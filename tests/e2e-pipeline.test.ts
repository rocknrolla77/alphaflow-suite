// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — tests/e2e-pipeline.test.ts
// Phase 3: End-to-End Smoke Test — полный жизненный цикл
//
// ЭМУЛИРУЕМЫЙ PIPELINE:
//   1. Регистрация идентичности агента (минтинг ERC-721 в IdentityRegistry)
//   2. Отсеивание шума фильтром Блума (irrelevant addresses → skip)
//   3. Маршрутизация через Byreal API (getQuote → buildExecutionPayload)
//   4. Формирование EIP-712 Proposal (signing внутри TEE)
//   5. Верификация TEE-аттестации (reportData = keccak256(proposalHash, bloomFilterHash))
//
// ЗАПУСК:
//   npx vitest tests/e2e-pipeline.test.ts
//   npx vitest tests/e2e-pipeline.test.ts --reporter=verbose
//
// ЗАВИСИМОСТИ:
//   - vitest (devDependency)
//   - viem (для ABI encoding, hashing)
//   - Мок-сервер Byreal API (встроенный в тест)
//   - Мок DStack endpoint (для attestation)
// ═══════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import {
    keccak256,
    encodePacked,
    encodeAbiParameters,
    parseAbiParameters,
    privateKeyToAccount,
    type Hex,
    type Address,
} from "viem";

// ─── Modules Under Test ─────────────────────────────────────────────────────

import { BloomFilter, createDefaultBloomFilter } from "../agent-tee/src/services/bloomFilter.js";
import { ByrealClient, type ByrealQuote } from "../agent-tee/src/services/byrealClient.js";
import { PhalaAttestationService, type ReportDataParams } from "../agent-tee/src/services/remoteAttestation.js";

// ═══════════════════════════════════════════════════════════════════════════════
//                          MOCK SERVERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Мок-сервер Byreal OpenClaw API */
function createMockByrealServer(): Server {
    return createServer((req: IncomingMessage, res: ServerResponse) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            const url = req.url || "";

            if (url === "/v1/quote" && req.method === "POST") {
                const params = JSON.parse(body);
                const response = {
                    quoteId: `quote_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    tokenIn: params.tokenIn,
                    tokenOut: params.tokenOut,
                    amountIn: params.amountIn,
                    estimatedAmountOut: (BigInt(params.amountIn) * 998n / 1000n).toString(),
                    priceImpactBps: 15,
                    routes: [
                        {
                            pool: "0x1234567890abcdef1234567890abcdef12345678",
                            protocol: "OpenClaw CLMM",
                            feeBps: 5,
                            percentAllocation: 70,
                            poolType: "concentrated",
                        },
                        {
                            pool: "0xabcdef1234567890abcdef1234567890abcdef12",
                            protocol: "OpenClaw Classic",
                            feeBps: 30,
                            percentAllocation: 30,
                            poolType: "classic",
                        },
                    ],
                    gasEstimate: "250000",
                    expiresAt: Math.floor(Date.now() / 1000) + 300,
                };
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(response));
            } else if (url === "/v1/build" && req.method === "POST") {
                const params = JSON.parse(body);
                const response = {
                    to: "0x5555555555555555555555555555555555555555",
                    data: "0xe449022e" + "0".repeat(256), // swap selector + params
                    value: "0",
                    gasLimit: "350000",
                    minAmountOut: (BigInt("1000000000000000000") * 995n / 1000n).toString(),
                    deadline: params.deadline,
                };
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(response));
            } else {
                res.writeHead(404);
                res.end("Not Found");
            }
        });
    });
}

/** Мок-сервер DStack (Phala TEE Attestation) */
function createMockDStackServer(): Server {
    return createServer((req: IncomingMessage, res: ServerResponse) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            const url = req.url || "";

            if (url === "/prpc/Phala.GetRemoteAttestation") {
                const params = JSON.parse(body);
                const mockQuote =
                    "0".repeat(224) + // header (112 bytes)
                    "a".repeat(64) +  // mrenclave (32 bytes)
                    "0".repeat(64) +  // padding
                    "b".repeat(64) +  // mrsigner (32 bytes)
                    "0".repeat(128);  // rest
                const response = {
                    quote: mockQuote,
                    mrenclave: "a".repeat(64),
                    mrsigner: "b".repeat(64),
                    platform: "tdx",
                };
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(response));
            } else if (url === "/prpc/Phala.VerifyAttestation") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ is_valid: true, tcb_status: "UpToDate" }));
            } else {
                res.writeHead(404);
                res.end("Not Found");
            }
        });
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
//                          TEST CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const MOCK_TEE_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const MOCK_AGENT_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const TOKEN_A = "0xdEAddEaDdeadDEadDEADDEAddEADDEAdDeadDEAd" as Address; // WMNT
const TOKEN_B = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address; // USDC

// Irrelevant addresses (noise — should be filtered by Bloom)
const NOISE_ADDRESSES = [
    "0x0000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000002",
    "0x0000000000000000000000000000000000dead01",
    "0x0000000000000000000000000000000000dead02",
    "0xspam111111111111111111111111111111111111",
    "0xspam222222222222222222222222222222222222",
];

// Relevant addresses (should pass through Bloom filter)
const RELEVANT_ADDRESSES = [
    "0xwhale1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "0xsmartmoney11111111111111111111111111111111",
    "0xfundvc222222222222222222222222222222222222",
];

// ═══════════════════════════════════════════════════════════════════════════════
//                          TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("E2E Pipeline Smoke Test — Full Lifecycle", () => {
    let byrealServer: Server;
    let dstackServer: Server;
    let byrealPort: number;
    let dstackPort: number;

    beforeAll(async () => {
        // Start mock servers
        byrealServer = createMockByrealServer();
        dstackServer = createMockDStackServer();

        await new Promise<void>((resolve) => byrealServer.listen(0, () => resolve()));
        await new Promise<void>((resolve) => dstackServer.listen(0, () => resolve()));

        byrealPort = (byrealServer.address() as any).port;
        dstackPort = (dstackServer.address() as any).port;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => byrealServer.close(() => resolve()));
        await new Promise<void>((resolve) => dstackServer.close(() => resolve()));
    });

    // ─── Stage 1: ERC-8004 Identity Registration ──────────────────────────────

    describe("Stage 1: ERC-8004 Agent Identity Registration", () => {
        it("should simulate agent registration (mint ERC-721 NFT)", () => {
            // Simulate: IdentityRegistry.registerAgent(owner, agentCardURI)
            // In real deployment this is on-chain, here we verify the data structures.

            const agentCardURI = "ipfs://bafkreigxyz_mock_agent_card_cid";
            const ownerAddress = MOCK_AGENT_ADDRESS;
            const tokenId = 1n; // First agent = tokenId 1

            // Verify AgentCard URI format invariant
            expect(agentCardURI.startsWith("ipfs://") || agentCardURI.startsWith("ar://")).toBe(true);
            expect(agentCardURI.length).toBeGreaterThan(10);

            // Verify address is not zero
            expect(ownerAddress).not.toBe("0x0000000000000000000000000000000000000000");

            // Simulate agentOf mapping
            const agentOf: Map<string, bigint> = new Map();
            agentOf.set(ownerAddress.toLowerCase(), tokenId);

            expect(agentOf.get(ownerAddress.toLowerCase())).toBe(tokenId);

            // Simulate: one address = one agent (soulbound-like)
            // Second registration should fail
            const alreadyRegistered = agentOf.has(ownerAddress.toLowerCase());
            expect(alreadyRegistered).toBe(true);
        });

        it("should generate valid AgentCard JSON structure", () => {
            const agentCard = {
                name: "AlphaFlow TEE Agent",
                description: "Flash arbitrage agent on Mantle Network with TEE attestation",
                version: "3.0.0",
                capabilities: [
                    { name: "flash_arbitrage", protocol: "MCP", version: "1.0" },
                    { name: "yield_optimization", protocol: "MCP", version: "1.0" },
                    { name: "bloom_filter_analysis", protocol: "MCP", version: "1.0" },
                ],
                endpoints: {
                    mcp: "https://agent.alphaflow.xyz/mcp",
                    health: "https://agent.alphaflow.xyz/health",
                    attestation: "https://agent.alphaflow.xyz/attestation",
                },
                paymentAddresses: {
                    mantle: MOCK_AGENT_ADDRESS,
                },
                tee: {
                    platform: "tdx",
                    provider: "phala-dstack",
                },
            };

            // ERC-8004 required fields
            expect(agentCard.name).toBeDefined();
            expect(agentCard.description).toBeDefined();
            expect(agentCard.capabilities).toBeInstanceOf(Array);
            expect(agentCard.capabilities.length).toBeGreaterThan(0);
            expect(agentCard.endpoints.mcp).toBeDefined();
            expect(agentCard.paymentAddresses).toBeDefined();

            // Capability must have MCP protocol
            const mcpCapability = agentCard.capabilities.find(c => c.protocol === "MCP");
            expect(mcpCapability).toBeDefined();
        });
    });

    // ─── Stage 2: Bloom Filter Noise Elimination ──────────────────────────────

    describe("Stage 2: Bloom Filter — Noise Elimination", () => {
        let bloomFilter: BloomFilter;

        beforeEach(() => {
            bloomFilter = createDefaultBloomFilter();
        });

        it("should add noise addresses and filter them out", () => {
            // Add known noise/spam addresses to filter
            bloomFilter.addBatch(NOISE_ADDRESSES);

            // Verify noise addresses are detected
            for (const noise of NOISE_ADDRESSES) {
                expect(bloomFilter.test(noise)).toBe(true);
            }

            // Verify relevant addresses are NOT in filter (pass through)
            for (const relevant of RELEVANT_ADDRESSES) {
                expect(bloomFilter.test(relevant)).toBe(false);
            }
        });

        it("should filterNotPresent correctly for pipeline integration", () => {
            // Simulate: add irrelevant addresses during previous epochs
            bloomFilter.addBatch(NOISE_ADDRESSES);

            // New batch from RPC: mix of noise and relevant
            const incomingAddresses = [...NOISE_ADDRESSES.slice(0, 3), ...RELEVANT_ADDRESSES];

            // filterNotPresent → only relevant addresses proceed to Nansen MCP
            const toEnrich = bloomFilter.filterNotPresent(incomingAddresses);

            // All relevant addresses should pass through
            for (const relevant of RELEVANT_ADDRESSES) {
                expect(toEnrich).toContain(relevant);
            }

            // Noise addresses should NOT be in the result
            for (const noise of NOISE_ADDRESSES.slice(0, 3)) {
                expect(toEnrich).not.toContain(noise);
            }
        });

        it("should produce deterministic configHash for attestation", () => {
            const hash1 = bloomFilter.getFilterConfigHash();
            const hash2 = bloomFilter.getFilterConfigHash();

            // Same filter config → same hash (deterministic)
            expect(hash1).toBe(hash2);
            expect(hash1.startsWith("0x")).toBe(true);
            expect(hash1.length).toBe(66); // bytes32
        });

        it("should report correct statistics", () => {
            bloomFilter.addBatch(NOISE_ADDRESSES);
            const stats = bloomFilter.getStats();

            expect(stats.itemCount).toBe(NOISE_ADDRESSES.length);
            expect(stats.bitSize).toBeGreaterThan(0);
            expect(stats.hashCount).toBeGreaterThan(0);
            expect(stats.fillRatio).toBeGreaterThan(0);
            expect(stats.fillRatio).toBeLessThan(1);
            expect(stats.estimatedFpr).toBeLessThan(0.01); // Below target FPR
        });

        it("should recommend reset when overfilled", () => {
            // Fill filter beyond 50% capacity
            const filter = new BloomFilter({ expectedItems: 10, falsePositiveRate: 0.01 });
            for (let i = 0; i < 1000; i++) {
                filter.add(`overflow_address_${i}`);
            }
            expect(filter.shouldReset()).toBe(true);
        });
    });

    // ─── Stage 3: Byreal API Routing ──────────────────────────────────────────

    describe("Stage 3: Byreal OpenClaw API — CLMM Routing", () => {
        let byrealClient: ByrealClient;

        beforeAll(() => {
            byrealClient = new ByrealClient({
                baseUrl: `http://localhost:${byrealPort}`,
                chainId: 5000,
                timeoutMs: 5000,
                maxRetries: 1,
            });
        });

        it("should get quote for token swap", async () => {
            const amount = 1000000000000000000n; // 1 ETH in wei
            const quote = await byrealClient.getQuote(TOKEN_A, TOKEN_B, amount);

            expect(quote.quoteId).toBeDefined();
            expect(quote.quoteId.startsWith("quote_")).toBe(true);
            expect(quote.tokenIn).toBe(TOKEN_A);
            expect(quote.tokenOut).toBe(TOKEN_B);
            expect(quote.amountIn).toBe(amount);
            expect(quote.estimatedAmountOut).toBeGreaterThan(0n);
            expect(quote.priceImpactBps).toBeLessThan(300); // Below max threshold
            expect(quote.routes.length).toBeGreaterThan(0);
            expect(quote.gasEstimate).toBeGreaterThan(0n);
            expect(quote.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
        });

        it("should validate quote freshness", async () => {
            const amount = 1000000000000000000n;
            const quote = await byrealClient.getQuote(TOKEN_A, TOKEN_B, amount);

            expect(byrealClient.isQuoteValid(quote)).toBe(true);

            // Simulate expired quote
            const expiredQuote: ByrealQuote = {
                ...quote,
                expiresAt: Math.floor(Date.now() / 1000) - 100,
            };
            expect(byrealClient.isQuoteValid(expiredQuote)).toBe(false);
        });

        it("should build execution payload from quote", async () => {
            const amount = 1000000000000000000n;
            const quote = await byrealClient.getQuote(TOKEN_A, TOKEN_B, amount);

            const recipient = "0x1111111111111111111111111111111111111111" as Address;
            const payload = await byrealClient.buildExecutionPayload(
                quote.quoteId,
                50, // 0.5% slippage
                recipient,
                300 // 5 min deadline
            );

            expect(payload.to).toBeDefined();
            expect(payload.data).toBeDefined();
            expect(payload.data.startsWith("0x")).toBe(true);
            expect(payload.gasLimit).toBeGreaterThan(0n);
            expect(payload.minAmountOut).toBeGreaterThan(0n);
            expect(payload.deadline).toBeGreaterThan(Math.floor(Date.now() / 1000));
        });

        it("should compute unique nonce key per route", async () => {
            const quoteA = await byrealClient.getQuote(TOKEN_A, TOKEN_B, 1000000n);
            const quoteB = await byrealClient.getQuote(TOKEN_B, TOKEN_A, 2000000n);

            const nonceA = byrealClient.computeRouteNonceKey(quoteA);
            const nonceB = byrealClient.computeRouteNonceKey(quoteB);

            // Different routes → different nonce keys (no collision)
            expect(nonceA).not.toBe(nonceB);
            expect(nonceA).toBeGreaterThan(0n);
            expect(nonceB).toBeGreaterThan(0n);
        });

        it("should include CLMM routes in quote", async () => {
            const quote = await byrealClient.getQuote(TOKEN_A, TOKEN_B, 1000000000000000000n);

            // Verify route structure
            const clmmRoute = quote.routes.find(r => r.poolType === "concentrated");
            expect(clmmRoute).toBeDefined();
            expect(clmmRoute!.protocol).toContain("CLMM");
            expect(clmmRoute!.percentAllocation).toBeGreaterThan(0);
            expect(clmmRoute!.feeBps).toBeGreaterThan(0);

            // Total allocation should sum to 100%
            const totalAllocation = quote.routes.reduce((sum, r) => sum + r.percentAllocation, 0);
            expect(totalAllocation).toBe(100);
        });
    });

    // ─── Stage 4: EIP-712 Proposal Formation ──────────────────────────────────

    describe("Stage 4: EIP-712 Proposal — TEE Signing", () => {
        it("should form valid Proposal structure", () => {
            const proposal = {
                asset: TOKEN_B,
                action: "BUY",
                recommendedAmount: 500000000000000000n, // 0.5 token
                nonce: 42,
                deadline: Math.floor(Date.now() / 1000) + 300,
                reasoningHash: keccak256(
                    encodePacked(["string"], ["signal_data_hash_placeholder"])
                ),
                insightHash: keccak256(
                    encodeAbiParameters(
                        parseAbiParameters("address, string, uint256, uint256"),
                        [TOKEN_B, "BUY", 500000000000000000n, BigInt(Math.floor(Date.now() / 1000))]
                    )
                ),
                commitTxHash: "0x" + "a".repeat(64),
            };

            expect(proposal.asset).toBe(TOKEN_B);
            expect(proposal.action).toBe("BUY");
            expect(proposal.recommendedAmount).toBeGreaterThan(0n);
            expect(proposal.nonce).toBeGreaterThan(0);
            expect(proposal.deadline).toBeGreaterThan(Math.floor(Date.now() / 1000));
            expect(proposal.reasoningHash.startsWith("0x")).toBe(true);
            expect(proposal.reasoningHash.length).toBe(66);
            expect(proposal.insightHash.startsWith("0x")).toBe(true);
            expect(proposal.insightHash.length).toBe(66);
            expect(proposal.commitTxHash.length).toBe(66);
        });

        it("should compute proposalHash for attestation binding", () => {
            const proposal = {
                asset: TOKEN_B,
                action: "BUY",
                recommendedAmount: 500000000000000000n,
                nonce: 42,
                deadline: Math.floor(Date.now() / 1000) + 300,
            };

            // EIP-712 struct hash
            const proposalHash = keccak256(
                encodeAbiParameters(
                    parseAbiParameters("address, string, uint256, uint256, uint256"),
                    [
                        proposal.asset as Address,
                        proposal.action,
                        proposal.recommendedAmount,
                        BigInt(proposal.nonce),
                        BigInt(proposal.deadline),
                    ]
                )
            );

            expect(proposalHash.startsWith("0x")).toBe(true);
            expect(proposalHash.length).toBe(66);

            // Same inputs → same hash (deterministic)
            const proposalHash2 = keccak256(
                encodeAbiParameters(
                    parseAbiParameters("address, string, uint256, uint256, uint256"),
                    [
                        proposal.asset as Address,
                        proposal.action,
                        proposal.recommendedAmount,
                        BigInt(proposal.nonce),
                        BigInt(proposal.deadline),
                    ]
                )
            );
            expect(proposalHash).toBe(proposalHash2);
        });

        it("should sign Proposal with TEE private key (EIP-712)", async () => {
            const account = privateKeyToAccount(MOCK_TEE_PRIVATE_KEY);

            const domain = {
                name: "AlphaFlow TEE",
                version: "3",
                chainId: 5000,
            } as const;

            const types = {
                Proposal: [
                    { name: "asset", type: "address" },
                    { name: "action", type: "string" },
                    { name: "recommendedAmount", type: "uint256" },
                    { name: "nonce", type: "uint256" },
                    { name: "deadline", type: "uint256" },
                ],
            } as const;

            const message = {
                asset: TOKEN_B,
                action: "BUY",
                recommendedAmount: 500000000000000000n,
                nonce: 42n,
                deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
            } as const;

            const signature = await account.signTypedData({
                domain,
                types,
                primaryType: "Proposal",
                message,
            });

            // Valid EIP-712 signature
            expect(signature.startsWith("0x")).toBe(true);
            expect(signature.length).toBe(132); // 65 bytes = 130 hex + "0x"

            // Signer address matches
            expect(account.address).toBe(MOCK_AGENT_ADDRESS);
        });
    });

    // ─── Stage 5: TEE Attestation Verification ────────────────────────────────

    describe("Stage 5: TEE Attestation — Combined reportData", () => {
        let attestationService: PhalaAttestationService;
        let bloomFilter: BloomFilter;

        beforeAll(() => {
            attestationService = new PhalaAttestationService(
                `http://localhost:${dstackPort}`
            );
            bloomFilter = createDefaultBloomFilter();
            bloomFilter.addBatch(NOISE_ADDRESSES);
        });

        it("should build reportData with keccak256(proposalHash, bloomFilterHash)", () => {
            const proposalHash = keccak256(
                encodePacked(["string"], ["test_proposal_hash"])
            ) as Hex;
            const bloomFilterHash = bloomFilter.getFilterConfigHash();

            const reportData = attestationService.buildReportData({
                proposalHash,
                bloomFilterHash,
            });

            // 64 bytes = 128 hex characters
            expect(reportData.length).toBe(128);
            expect(/^[0-9a-f]+$/i.test(reportData)).toBe(true);

            // Deterministic: same inputs → same output
            const reportData2 = attestationService.buildReportData({
                proposalHash,
                bloomFilterHash,
            });
            expect(reportData).toBe(reportData2);
        });

        it("should generate attestation quote with combined reportData", async () => {
            const proposalHash = keccak256(
                encodePacked(["string"], ["real_proposal_data"])
            ) as Hex;
            const bloomFilterHash = bloomFilter.getFilterConfigHash();

            const quote = await attestationService.attestProposal({
                proposalHash,
                bloomFilterHash,
            });

            expect(quote.rawQuote).toBeDefined();
            expect(quote.mrenclave).toBeDefined();
            expect(quote.mrsigner).toBeDefined();
            expect(quote.platform).toBe("tdx");
            expect(quote.timestamp).toBeGreaterThan(0);

            // reportData embeds combined hash
            expect(quote.reportData.length).toBe(128);
        });

        it("should verify attestation quote via DCAP", async () => {
            const proposalHash = keccak256(
                encodePacked(["string"], ["verification_test"])
            ) as Hex;
            const bloomFilterHash = bloomFilter.getFilterConfigHash();

            const quote = await attestationService.attestProposal({
                proposalHash,
                bloomFilterHash,
            });

            const verification = await attestationService.verifyQuote(quote);

            expect(verification.isValid).toBe(true);
            expect(verification.mrenclave).toBe(quote.mrenclave);
            expect(verification.mrsigner).toBe(quote.mrsigner);
            expect(verification.reportData).toBe(quote.reportData);
            expect(verification.dcapResult).toBeDefined();
        });

        it("should reject invalid reportData format", () => {
            expect(() =>
                attestationService.buildReportData({
                    proposalHash: "0x123" as Hex, // Too short
                    bloomFilterHash: bloomFilter.getFilterConfigHash(),
                })
            ).toThrow("Invalid proposalHash");

            expect(() =>
                attestationService.buildReportData({
                    proposalHash: keccak256(encodePacked(["string"], ["x"])) as Hex,
                    bloomFilterHash: "0xshort" as Hex, // Too short
                })
            ).toThrow("Invalid bloomFilterHash");
        });
    });

    // ─── Full Pipeline Integration ────────────────────────────────────────────

    describe("Full Pipeline: Identity → Filter → Route → Proposal → Attest", () => {
        it("should execute complete lifecycle end-to-end", async () => {
            // ═══ STEP 1: Agent Identity Registration ═══
            const agentCardURI = "ipfs://bafkreie2e_test_agent_card";
            const agentTokenId = 1n;
            const agentAddress = MOCK_AGENT_ADDRESS;

            // Verify registration prerequisites
            expect(agentAddress).toBeDefined();
            expect(agentCardURI.startsWith("ipfs://")).toBe(true);

            console.log(`[E2E] Step 1: Agent registered — tokenId=${agentTokenId}`);

            // ═══ STEP 2: Bloom Filter — Noise Elimination ═══
            const bloomFilter = createDefaultBloomFilter();
            bloomFilter.addBatch(NOISE_ADDRESSES);

            const incomingRpcData = [
                ...NOISE_ADDRESSES.slice(0, 4),
                ...RELEVANT_ADDRESSES,
            ];

            const relevantData = bloomFilter.filterNotPresent(incomingRpcData);

            // Only relevant data passes through
            expect(relevantData.length).toBe(RELEVANT_ADDRESSES.length);
            const bloomFilterHash = bloomFilter.getFilterConfigHash();

            console.log(
                `[E2E] Step 2: Bloom filtered — ` +
                `${incomingRpcData.length} in → ${relevantData.length} out ` +
                `(${NOISE_ADDRESSES.slice(0, 4).length} noise eliminated)`
            );

            // ═══ STEP 3: Byreal API — CLMM Routing ═══
            const byrealClient = new ByrealClient({
                baseUrl: `http://localhost:${byrealPort}`,
                chainId: 5000,
                timeoutMs: 5000,
                maxRetries: 1,
            });

            const borrowAmount = 5000000000000000000n; // 5 tokens
            const quote = await byrealClient.getQuote(TOKEN_A, TOKEN_B, borrowAmount);
            expect(quote.estimatedAmountOut).toBeGreaterThan(0n);
            expect(byrealClient.isQuoteValid(quote)).toBe(true);

            const payload = await byrealClient.buildExecutionPayload(
                quote.quoteId,
                50, // 0.5% slippage
                "0x1111111111111111111111111111111111111111" as Address,
                300
            );

            expect(payload.data.startsWith("0x")).toBe(true);

            console.log(
                `[E2E] Step 3: Byreal route — ` +
                `quoteId=${quote.quoteId.slice(0, 20)}..., ` +
                `output=${quote.estimatedAmountOut}, ` +
                `impact=${quote.priceImpactBps}bps`
            );

            // ═══ STEP 4: EIP-712 Proposal Formation ═══
            const account = privateKeyToAccount(MOCK_TEE_PRIVATE_KEY);

            const proposalHash = keccak256(
                encodeAbiParameters(
                    parseAbiParameters("address, string, uint256, uint256"),
                    [TOKEN_B, "BUY", quote.estimatedAmountOut, BigInt(agentTokenId)]
                )
            ) as Hex;

            const domain = {
                name: "AlphaFlow TEE",
                version: "3",
                chainId: 5000,
            } as const;

            const types = {
                Proposal: [
                    { name: "asset", type: "address" },
                    { name: "action", type: "string" },
                    { name: "recommendedAmount", type: "uint256" },
                    { name: "nonce", type: "uint256" },
                    { name: "deadline", type: "uint256" },
                ],
            } as const;

            const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
            const message = {
                asset: TOKEN_B,
                action: "BUY",
                recommendedAmount: quote.estimatedAmountOut,
                nonce: 1n,
                deadline,
            } as const;

            const signature = await account.signTypedData({
                domain,
                types,
                primaryType: "Proposal",
                message,
            });

            expect(signature.length).toBe(132);

            console.log(
                `[E2E] Step 4: Proposal signed — ` +
                `hash=${proposalHash.slice(0, 18)}..., ` +
                `sig=${signature.slice(0, 18)}...`
            );

            // ═══ STEP 5: TEE Attestation ═══
            const attestationService = new PhalaAttestationService(
                `http://localhost:${dstackPort}`
            );

            const attestQuote = await attestationService.attestProposal({
                proposalHash,
                bloomFilterHash,
            });

            const verification = await attestationService.verifyQuote(attestQuote);
            expect(verification.isValid).toBe(true);

            console.log(
                `[E2E] Step 5: Attestation verified — ` +
                `platform=${attestQuote.platform}, ` +
                `mrenclave=${attestQuote.mrenclave.slice(0, 16)}..., ` +
                `valid=${verification.isValid}`
            );

            // ═══ FINAL: Pipeline Complete ═══
            const pipelineResult = {
                agentTokenId,
                bloomStats: bloomFilter.getStats(),
                byrealQuoteId: quote.quoteId,
                proposalHash,
                signature,
                attestation: {
                    platform: attestQuote.platform,
                    mrenclave: attestQuote.mrenclave,
                    reportData: attestQuote.reportData,
                    isValid: verification.isValid,
                },
            };

            // All stages completed successfully
            expect(pipelineResult.agentTokenId).toBeGreaterThan(0n);
            expect(pipelineResult.bloomStats.itemCount).toBeGreaterThan(0);
            expect(pipelineResult.byrealQuoteId).toBeDefined();
            expect(pipelineResult.proposalHash).toBeDefined();
            expect(pipelineResult.signature).toBeDefined();
            expect(pipelineResult.attestation.isValid).toBe(true);

            console.log("\n[E2E] ✓ FULL PIPELINE PASSED — all 5 stages completed successfully\n");
        });
    });
});
