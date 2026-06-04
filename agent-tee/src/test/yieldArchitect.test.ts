// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — agent-tee/src/test/yieldArchitect.test.ts
// Unit tests для Yield Architect Strategy Engine (Phase 5 — Swarm Mode)
//
// Тестируем:
// 1. Volume calculation (Smart Money Weight formula)
// 2. Bounds checking / input validation
// 3. Legacy EIP-712 Proposal подпись (Proof-of-Reasoning)
// 4. NEW: ForwardRequest EIP-712 подпись для MicroFundingDispatcher
// 5. NEW: Подпись recoverTypedDataAddress через viem
// ═══════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyTypedData, parseEther, type Address, type Hex } from "viem";
import { YieldArchitect, type ArbParams } from "../strategies/yieldArchitect.js";
import type { SmartMoneySignal, UserRiskProfile, ForwardRequest } from "../types/index.js";
import { DISPATCHER_EIP712_DOMAIN, FORWARD_REQUEST_TYPES } from "../types/index.js";

// ═══════════════════════════════════════════════════════════════════════════════
//                          TEST FIXTURES
// ═══════════════════════════════════════════════════════════════════════════════

const ACTIVE_SENTINEL_ADDRESS = "0x1234567890123456789012345678901234567890" as Address;

function createDefaultSignal(): SmartMoneySignal {
    return {
        walletAddress: "0x28C6c06298d514Db089934071355E5743bf21d60",
        walletTag: "Fund",
        reputationScore: 0.92,
        asset: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
        assetSymbol: "WMNT",
        action: "BUY",
        tradeVolume: parseEther("500000"),      // 500k tokens
        totalPortfolioValue: parseEther("10000000"), // 10M total portfolio
        detectedAt: Math.floor(Date.now() / 1000),
        sourceTxHash: "0xabc123def456789012345678901234567890123456789012345678901234abcd",
    };
}

function createDefaultProfile(): UserRiskProfile {
    return {
        accountAddress: "0x9876543210987654321098765432109876543210",
        availableBalance: parseEther("10000"),  // 10k tokens
        riskCoefficient: 0.5,
        maxSlippageBps: 200,
        minProfitThreshold: parseEther("10"),
    };
}

function createDefaultArbParams(): ArbParams {
    return {
        borrowToken: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8" as Address, // WMNT
        borrowAmount: parseEther("250"),
        minProfit: parseEther("5"),
        swapTarget: "0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57" as Address, // Paraswap-like
        swapCalldata: "0xabcdef1234567890" as Hex,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//                              TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("YieldArchitect (Swarm Mode)", () => {
    let architect: YieldArchitect;
    let teePrivateKey: `0x${string}`;
    let teeAddress: Address;

    beforeEach(() => {
        teePrivateKey = generatePrivateKey();
        teeAddress = privateKeyToAccount(teePrivateKey).address;
        architect = new YieldArchitect(teePrivateKey, 5000, ACTIVE_SENTINEL_ADDRESS, 0n);
    });

    // ─── Volume Calculation ──────────────────────────────────────────────────

    describe("Volume Calculation (W = S_smart / V_smart)", () => {
        it("should calculate correct weight (W = 500k / 10M = 0.05)", () => {
            const signal = createDefaultSignal();
            const profile = createDefaultProfile();
            const amount = architect.calculateVolume(signal, profile);

            // W = 500k/10M = 0.05, S_user = 10k * 0.05 * 0.5 = 250
            expect(amount).toBe(parseEther("250"));
        });

        it("should cap at availableBalance when amount exceeds", () => {
            const signal = createDefaultSignal();
            signal.tradeVolume = signal.totalPortfolioValue; // W = 1.0
            const profile = createDefaultProfile();
            profile.riskCoefficient = 1.0; // Full aggression

            // W = 1.0, S_user = 10k * 1.0 * 1.0 = 10k = entire balance
            const amount = architect.calculateVolume(
                { ...signal, tradeVolume: signal.totalPortfolioValue },
                { ...profile, riskCoefficient: 1.0 }
            );
            expect(amount).toBeLessThanOrEqual(profile.availableBalance);
        });

        it("should never produce negative amounts", () => {
            const signal = createDefaultSignal();
            const profile = createDefaultProfile();
            const amount = architect.calculateVolume(signal, profile);
            expect(amount).toBeGreaterThan(0n);
        });
    });

    // ─── Input Validation ────────────────────────────────────────────────────

    describe("Input Validation", () => {
        it("should throw on totalPortfolioValue = 0 (division by zero)", () => {
            const signal = { ...createDefaultSignal(), totalPortfolioValue: 0n };
            expect(() => architect.calculateVolume(signal, createDefaultProfile()))
                .toThrow("totalPortfolioValue cannot be zero");
        });

        it("should throw on tradeVolume = 0", () => {
            const signal = { ...createDefaultSignal(), tradeVolume: 0n };
            expect(() => architect.calculateVolume(signal, createDefaultProfile()))
                .toThrow("tradeVolume cannot be zero");
        });

        it("should throw on tradeVolume > totalPortfolioValue", () => {
            const signal = { ...createDefaultSignal(), tradeVolume: parseEther("99999999") };
            expect(() => architect.calculateVolume(signal, createDefaultProfile()))
                .toThrow("tradeVolume > totalPortfolioValue");
        });

        it("should throw on riskCoefficient > 1.0", () => {
            const profile = { ...createDefaultProfile(), riskCoefficient: 1.5 };
            expect(() => architect.calculateVolume(createDefaultSignal(), profile))
                .toThrow("riskCoefficient must be in [0.1, 1.0]");
        });

        it("should throw on riskCoefficient < 0.1", () => {
            const profile = { ...createDefaultProfile(), riskCoefficient: 0.05 };
            expect(() => architect.calculateVolume(createDefaultSignal(), profile))
                .toThrow("riskCoefficient must be in [0.1, 1.0]");
        });

        it("should throw on availableBalance = 0", () => {
            const profile = { ...createDefaultProfile(), availableBalance: 0n };
            expect(() => architect.calculateVolume(createDefaultSignal(), profile))
                .toThrow("availableBalance is zero");
        });
    });

    // ─── Insight Hash (Proof-of-Alpha — UNCHANGED) ───────────────────────────

    describe("InsightHash (Proof-of-Alpha)", () => {
        it("should produce deterministic hash for same inputs", () => {
            const hash1 = architect.computeInsightHash(
                "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
                "BUY",
                parseEther("250"),
                1700000000
            );
            const hash2 = architect.computeInsightHash(
                "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
                "BUY",
                parseEther("250"),
                1700000000
            );
            expect(hash1).toBe(hash2);
        });

        it("should produce different hash for different inputs", () => {
            const hash1 = architect.computeInsightHash(
                "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
                "BUY",
                parseEther("250"),
                1700000000
            );
            const hash2 = architect.computeInsightHash(
                "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
                "SELL",  // different action
                parseEther("250"),
                1700000000
            );
            expect(hash1).not.toBe(hash2);
        });

        it("should produce valid bytes32 hex", () => {
            const hash = architect.computeInsightHash(
                "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
                "BUY",
                parseEther("250"),
                1700000000
            );
            expect(hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
        });
    });

    // ─── ForwardRequest EIP-712 Signature (NEW — Swarm Mode) ─────────────────

    describe("ForwardRequest EIP-712 Signature", () => {
        it("should generate valid ForwardRequest with correct structure", async () => {
            const arbParams = createDefaultArbParams();
            const insightHash = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hex;
            const commitTxHash = "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`;

            const signed = await architect.generateForwardRequest(
                arbParams, insightHash, commitTxHash, 300
            );

            // Verify structure
            expect(signed.request.target).toBe(ACTIVE_SENTINEL_ADDRESS);
            expect(signed.request.value).toBe(0n);
            expect(signed.request.nonce).toBe(0n); // First request
            expect(signed.request.data).toMatch(/^0x/); // Encoded calldata
            expect(signed.signature).toMatch(/^0x[a-fA-F0-9]{130}$/);
            expect(signed.signerAddress).toBe(teeAddress);
            expect(signed.insightHash).toBe(insightHash);
            expect(signed.commitTxHash).toBe(commitTxHash);
        });

        it("EIP-712 signature should recover to TEE signer address", async () => {
            const arbParams = createDefaultArbParams();
            const insightHash = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hex;
            const commitTxHash = "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`;

            const signed = await architect.generateForwardRequest(
                arbParams, insightHash, commitTxHash, 300
            );

            // Recover signer from EIP-712 signature via viem
            const recoveredValid = await verifyTypedData({
                address: teeAddress,
                domain: {
                    ...DISPATCHER_EIP712_DOMAIN,
                    chainId: 5000,
                },
                types: FORWARD_REQUEST_TYPES,
                primaryType: "ForwardRequest",
                message: {
                    target: signed.request.target,
                    data: signed.request.data,
                    value: signed.request.value,
                    nonce: signed.request.nonce,
                    deadline: signed.request.deadline,
                },
                signature: signed.signature,
            });

            expect(recoveredValid).toBe(true);
        });

        it("signature should NOT verify with wrong signer", async () => {
            const arbParams = createDefaultArbParams();
            const insightHash = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hex;
            const commitTxHash = "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`;

            const signed = await architect.generateForwardRequest(
                arbParams, insightHash, commitTxHash, 300
            );

            // Try to verify with random address (should fail)
            const wrongAddress = privateKeyToAccount(generatePrivateKey()).address;
            const isValidForWrong = await verifyTypedData({
                address: wrongAddress,
                domain: {
                    ...DISPATCHER_EIP712_DOMAIN,
                    chainId: 5000,
                },
                types: FORWARD_REQUEST_TYPES,
                primaryType: "ForwardRequest",
                message: {
                    target: signed.request.target,
                    data: signed.request.data,
                    value: signed.request.value,
                    nonce: signed.request.nonce,
                    deadline: signed.request.deadline,
                },
                signature: signed.signature,
            });

            expect(isValidForWrong).toBe(false);
        });

        it("nonce should increment monotonically", async () => {
            const arbParams = createDefaultArbParams();
            const insightHash = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hex;
            const commitTxHash = "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`;

            const signed1 = await architect.generateForwardRequest(
                arbParams, insightHash, commitTxHash
            );
            const signed2 = await architect.generateForwardRequest(
                arbParams, insightHash, commitTxHash
            );
            const signed3 = await architect.generateForwardRequest(
                arbParams, insightHash, commitTxHash
            );

            expect(signed1.request.nonce).toBe(0n);
            expect(signed2.request.nonce).toBe(1n);
            expect(signed3.request.nonce).toBe(2n);
            expect(architect.currentNonce).toBe(3n);
        });

        it("deadline should be in the future", async () => {
            const arbParams = createDefaultArbParams();
            const insightHash = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hex;
            const commitTxHash = "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`;

            const signed = await architect.generateForwardRequest(
                arbParams, insightHash, commitTxHash, 300
            );

            const now = BigInt(Math.floor(Date.now() / 1000));
            expect(signed.request.deadline).toBeGreaterThan(now);
            expect(signed.request.deadline).toBeLessThanOrEqual(now + 305n); // 300s + small buffer
        });

        it("different arbParams produce different calldata", async () => {
            const insightHash = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hex;
            const commitTxHash = "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`;

            const arbParams1 = createDefaultArbParams();
            const arbParams2 = { ...createDefaultArbParams(), borrowAmount: parseEther("500") };

            const signed1 = await architect.generateForwardRequest(
                arbParams1, insightHash, commitTxHash
            );
            const signed2 = await architect.generateForwardRequest(
                arbParams2, insightHash, commitTxHash
            );

            expect(signed1.request.data).not.toBe(signed2.request.data);
        });
    });

    // ─── Legacy Proposal (backward compat) ───────────────────────────────────

    describe("Legacy Proposal Generation (Proof-of-Reasoning)", () => {
        it("should generate valid SignedProposal", async () => {
            const signal = createDefaultSignal();
            const profile = createDefaultProfile();

            const signed = await architect.generateProposal(signal, profile, 300);

            expect(signed.asset).toBe(signal.asset);
            expect(signed.action).toBe("BUY");
            expect(signed.recommendedAmount).toBe(parseEther("250"));
            expect(signed.signature).toMatch(/^0x[a-fA-F0-9]{130}$/);
            expect(signed.signerAddress).toBe(teeAddress);
            expect(signed.insightHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
            expect(signed.reasoningHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
        });

        it("reasoningHash should be deterministic for same inputs", async () => {
            const signal = createDefaultSignal();
            const profile = createDefaultProfile();
            const amount = architect.calculateVolume(signal, profile);

            const hash1 = architect.computeReasoningHash(signal, profile, amount);
            const hash2 = architect.computeReasoningHash(signal, profile, amount);

            expect(hash1).toBe(hash2);
        });
    });

    // ─── Isolation Invariant ─────────────────────────────────────────────────

    describe("Isolation: TEE → Redis only (no TX sending)", () => {
        it("YieldArchitect has NO method for sending transactions", () => {
            const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(architect));
            expect(methods).not.toContain("sendTransaction");
            expect(methods).not.toContain("executeArbitrage");
            expect(methods).not.toContain("relay");
            expect(methods).not.toContain("broadcast");
        });

        it("generateForwardRequest returns data, not a tx receipt", async () => {
            const arbParams = createDefaultArbParams();
            const insightHash = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hex;
            const commitTxHash = "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`;

            const result = await architect.generateForwardRequest(
                arbParams, insightHash, commitTxHash
            );

            // Result is a signed payload, NOT a transaction receipt
            expect(result).toHaveProperty("request");
            expect(result).toHaveProperty("signature");
            expect(result).not.toHaveProperty("txHash");
            expect(result).not.toHaveProperty("receipt");
            expect(result).not.toHaveProperty("gasUsed");
        });
    });
});
