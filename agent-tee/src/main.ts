// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — agent-tee/src/main.ts
// Entry Point для TEE-агента (Phala Network CVM)
// Phase 4: Dynamic Watchlist + Heuristic Clustering
//
// БЕЗОПАСНОСТЬ:
// - Приватный ключ генерируется IN-MEMORY при каждом запуске
// - NEVER: не логируется, не записывается на диск, не передаётся по сети
// - Экспортируется ТОЛЬКО публичный адрес (через health endpoint)
//
// PIPELINE INVARIANT:
// 1. YieldArchitect.generateProposal() → proposal + insightHash
// 2. SentinelExecutor.commitProofOfAlpha(insightHash) → commitTxHash
// 3. Assemble final proposal with commitTxHash
// 4. ONLY THEN → redisPublisher.publish(proposal)
//
// PHASE 4 ADDITIONS:
// - DynamicWatchlist: Redis-backed wallet tracking (replaces state.json)
// - ClusteringEngine: auto-discovers related wallets via transfer/gas heuristics
// - NansenMCPClient: iterates over dynamic watchlist (SMEMBERS) instead of static array
// - Polling loop: periodic tick → cluster scan → signal generation → pipeline
//
// Если шаг 2 fails → шаг 4 НИКОГДА не выполняется.
// ═══════════════════════════════════════════════════════════════════════════════

import { ethers, Wallet, HDNodeWallet } from "ethers";
import { z } from "zod";
import { Redis } from "ioredis";
import http from "node:http";
import type { AgentConfig, SmartMoneySignal, UserRiskProfile, SignedProposal } from "./types/index.js";
import { YieldArchitect } from "./strategies/yieldArchitect.js";
import { ClusteringEngine, type ClusteringEngineConfig } from "./strategies/clusteringEngine.js";
import { SentinelExecutor, type ExecutorConfig } from "./executor.js";
import { ProposalPublisher } from "./services/proposalPublisher.js";
import { CircuitBreaker, CriticalHaltError } from "./services/circuitBreaker.js";
import { DynamicWatchlist } from "./services/dynamicWatchlist.js";
import { NansenMCPClient, type NansenMCPConfig } from "./services/nansenClient.js";

// ─── Zod Schema для валидации конфигурации ────────────────────────────────────

const AgentConfigSchema = z.object({
    redisUrl: z.string().min(1, "REDIS_URL is required"),
    chainId: z.number().int().positive(),
    proposalTtlSeconds: z.number().int().min(30).max(3600),
    healthPort: z.number().int().min(1024).max(65535),
    attestationEnabled: z.boolean(),
    alphaAuditorAddress: z.string()
        .regex(/^0x[a-fA-F0-9]{40}$/, "ALPHA_AUDITOR_ADDRESS must be valid Ethereum address"),
    agentId: z.bigint().positive("AGENT_ID must be positive uint256"),
});

// ─── Конфигурация из Environment Variables ────────────────────────────────────

function loadConfig(): AgentConfig {
    const raw = {
        redisUrl: process.env["REDIS_URL"] ?? "redis://localhost:6379",
        chainId: parseInt(process.env["CHAIN_ID"] ?? "5000", 10),
        proposalTtlSeconds: parseInt(process.env["PROPOSAL_TTL_SEC"] ?? "300", 10),
        healthPort: parseInt(process.env["HEALTH_PORT"] ?? "8080", 10),
        attestationEnabled: process.env["ATTESTATION_ENABLED"] === "true",
        alphaAuditorAddress: process.env["ALPHA_AUDITOR_ADDRESS"] ?? "0x0000000000000000000000000000000000000000",
        agentId: BigInt(process.env["AGENT_ID"] ?? "1"),
    };

    return AgentConfigSchema.parse(raw);
}

// ─── TEE Signer Generation ────────────────────────────────────────────────────

/**
 * Генерирует эфемерный ECDSA ключ внутри TEE.
 * Ключ живёт ТОЛЬКО в памяти процесса.
 * При перезапуске CVM — генерируется НОВЫЙ ключ.
 *
 * В Phala DStack:
 * - Память процесса защищена SGX/TDX enclav-ом
 * - Ключ недоступен хосту даже при полном root-доступе к серверу
 */
function generateTeeSigner(): HDNodeWallet {
    const wallet = Wallet.createRandom();
    console.log(`[TEE] Ephemeral signer generated: ${wallet.address}`);
    console.log(`[TEE] ⚠️  Key exists ONLY in-memory. Lost on restart.`);
    return wallet;
}

// ─── Health Server ────────────────────────────────────────────────────────────

function startHealthServer(
    port: number,
    signerAddress: string,
    config: AgentConfig,
    watchlist: DynamicWatchlist
): void {
    const server = http.createServer(async (req, res) => {
        if (req.url === "/health" && req.method === "GET") {
            let watchlistSize = 0;
            try {
                watchlistSize = await watchlist.size();
            } catch { /* Redis down — still report health */ }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                status: "healthy",
                signer: signerAddress,
                chainId: config.chainId,
                attestation: config.attestationEnabled,
                agentId: config.agentId.toString(),
                watchlistSize,
                timestamp: Math.floor(Date.now() / 1000),
            }));
        } else if (req.url === "/watchlist/stats" && req.method === "GET") {
            try {
                const stats = await watchlist.getStats();
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(stats));
            } catch (err) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Redis unavailable" }));
            }
        } else {
            res.writeHead(404);
            res.end("Not Found");
        }
    });

    server.listen(port, "0.0.0.0", () => {
        console.log(`[TEE] Health server on http://0.0.0.0:${port}/health`);
        console.log(`[TEE] Watchlist stats on http://0.0.0.0:${port}/watchlist/stats`);
    });
}

// ─── Proposal Pipeline ────────────────────────────────────────────────────────

class ProposalPipeline {
    private readonly architect: YieldArchitect;
    private readonly executor: SentinelExecutor;
    private readonly publisher: ProposalPublisher;
    private readonly circuitBreaker: CircuitBreaker;
    private readonly config: AgentConfig;

    constructor(
        architect: YieldArchitect,
        executor: SentinelExecutor,
        publisher: ProposalPublisher,
        config: AgentConfig,
        circuitBreaker?: CircuitBreaker
    ) {
        this.architect = architect;
        this.executor = executor;
        this.publisher = publisher;
        this.config = config;
        this.circuitBreaker = circuitBreaker ?? new CircuitBreaker();
    }

    /**
     * Полный pipeline: signal → proposal → on-chain commit → publish
     *
     * @param signal — Smart Money сигнал от Nansen MCP
     * @param profile — риск-профиль пользователя
     * @returns SignedProposal (published) или throws Error (NOT published)
     */
    async processSignal(
        signal: SmartMoneySignal,
        profile: UserRiskProfile
    ): Promise<SignedProposal> {
        const pipelineId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        console.log(`\n[Pipeline:${pipelineId}] ═══ Starting ═══`);
        console.log(`[Pipeline:${pipelineId}] Signal: ${signal.assetSymbol} ${signal.action}`);
        console.log(`[Pipeline:${pipelineId}] Source: ${signal.walletTag} (rep: ${signal.reputationScore})`);

        // ─── STEP 1: Generate Proposal (compute volumes + hashes) ─────────
        console.log(`[Pipeline:${pipelineId}] Step 1: Generating proposal...`);

        const preliminaryProposal = await this.architect.generateProposal(
            signal,
            profile,
            this.config.proposalTtlSeconds
        );

        console.log(`[Pipeline:${pipelineId}] Step 1 ✓ Proposal generated`);
        console.log(`  Amount: ${ethers.formatEther(preliminaryProposal.recommendedAmount)} tokens`);
        console.log(`  InsightHash: ${preliminaryProposal.insightHash}`);
        console.log(`  Nonce: ${preliminaryProposal.nonce}`);

        // ─── STEP 2: Commit insightHash on-chain (BLOCKING) ───────────────
        console.log(`[Pipeline:${pipelineId}] Step 2: Committing Proof-of-Alpha on-chain...`);

        let commitTxHash: `0x${string}`;
        try {
            const commitResult = await this.executor.commitProofOfAlpha(
                preliminaryProposal.insightHash
            );
            commitTxHash = commitResult.txHash;
        } catch (commitError) {
            const errMsg = commitError instanceof Error
                ? commitError.message
                : String(commitError);

            console.error(`[Pipeline:${pipelineId}] Step 2 ✗ FAILED: ${errMsg}`);
            console.error(`[Pipeline:${pipelineId}] ═══ ABORTED ═══ Proposal NOT published.`);

            throw new Error(
                `[Pipeline] Proof-of-Alpha commit failed. Proposal discarded.\n` +
                `  Reason: ${errMsg}\n` +
                `  InsightHash: ${preliminaryProposal.insightHash}\n` +
                `  AgentId: ${this.config.agentId}`
            );
        }

        console.log(`[Pipeline:${pipelineId}] Step 2 ✓ Committed on-chain`);
        console.log(`  TxHash: ${commitTxHash}`);

        // ─── STEP 3: Re-sign proposal with commitTxHash ──────────────────
        console.log(`[Pipeline:${pipelineId}] Step 3: Re-signing with commitTxHash...`);

        const finalProposal = await this.architect.generateProposal(
            signal,
            profile,
            this.config.proposalTtlSeconds,
            commitTxHash
        );

        console.log(`[Pipeline:${pipelineId}] Step 3 ✓ Final proposal signed`);

        // ─── STEP 4: Circuit Breaker Validation (BLOCKING) ────────────────
        console.log(`[Pipeline:${pipelineId}] Step 4: Circuit Breaker validation...`);

        try {
            await this.circuitBreaker.validateMarketConditions({
                estimatedSlippage: profile.maxSlippageBps / 10000,
                // Gas price fetched automatically from RPC inside CircuitBreaker
                // Oracle prices: in production, fetched from Nansen/Pyth before this step
            });
            console.log(`[Pipeline:${pipelineId}] Step 4 ✓ Market conditions validated`);
        } catch (haltError) {
            if (haltError instanceof CriticalHaltError) {
                console.error(
                    `[Pipeline:${pipelineId}] Step 4 ✗ CIRCUIT BREAKER TRIGGERED\n` +
                    `  Reason: ${haltError.reason}\n` +
                    `  Action: Proposal WILL NOT be published to Redis.\n` +
                    `  The UI will NOT display this dangerous proposal.`
                );
                console.error(`[Pipeline:${pipelineId}] ═══ ABORTED (Circuit Breaker) ═══`);
                throw haltError;
            }
            throw haltError;
        }

        // ─── STEP 5: Publish to Redis → Frontend WebSocket ──────────────────
        console.log(`[Pipeline:${pipelineId}] Step 5: Publishing to Redis...`);

        await this.publisher.publish(
            {
                proposal: finalProposal,
                proofOfReasoning: finalProposal.reasoningHash,
                teeSignerAddress: finalProposal.signerAddress,
            },
            0,
            profile.maxSlippageBps / 100
        );

        console.log(`[Pipeline:${pipelineId}] Step 5 ✓ Published to Redis`);
        console.log(`[Pipeline:${pipelineId}] ═══ COMPLETE ═══`);
        console.log(`  Asset: ${finalProposal.asset}`);
        console.log(`  Action: ${finalProposal.action}`);
        console.log(`  Amount: ${ethers.formatEther(finalProposal.recommendedAmount)}`);
        console.log(`  InsightHash: ${finalProposal.insightHash}`);
        console.log(`  CommitTxHash: ${finalProposal.commitTxHash}`);
        console.log(`  Deadline: ${new Date(finalProposal.deadline * 1000).toISOString()}`);

        return finalProposal;
    }
}

// ─── Polling Loop ─────────────────────────────────────────────────────────────

/**
 * Phase 4 Polling Loop:
 *
 * Каждые POLL_INTERVAL_MS:
 * 1. ClusteringEngine.runTick() → сканирует transfer events, расширяет watchlist
 * 2. NansenMCPClient.getRecentTransactions(dynamicWallets) → fresh signals
 * 3. Для каждого qualifying signal → ProposalPipeline.processSignal()
 *
 * Между тиками: сброс epoch counter для rate limiting.
 */
async function startPollingLoop(
    clusteringEngine: ClusteringEngine,
    nansenClient: NansenMCPClient,
    watchlist: DynamicWatchlist,
    pipeline: ProposalPipeline,
    profile: UserRiskProfile,
    pollIntervalMs: number
): Promise<void> {
    let lastScanTimestamp = Math.floor(Date.now() / 1000) - 300; // Start 5 min ago

    const tick = async (): Promise<void> => {
        const tickId = Date.now();
        console.log(`\n[PollingLoop:${tickId}] ════════════════════════════════════════`);

        // ─── Phase A: Clustering scan ─────────────────────────────────────
        try {
            console.log("[PollingLoop] Phase A: Running clustering engine...");
            const clusterResult = await clusteringEngine.runTick();

            if (clusterResult.addedByTransfer + clusterResult.addedByGasFunding > 0) {
                console.log(
                    `[PollingLoop] Clustering discovered ${clusterResult.addedByTransfer + clusterResult.addedByGasFunding} new wallets`
                );
            }
        } catch (err) {
            console.error(
                "[PollingLoop] Clustering error (non-fatal):",
                err instanceof Error ? err.message : err
            );
        }

        // ─── Phase B: Fetch signals from dynamic watchlist ────────────────
        try {
            console.log("[PollingLoop] Phase B: Fetching signals from Nansen MCP...");

            // Получаем динамический список кошельков из Redis
            const wallets = await watchlist.getWatchedWalletsArray();

            if (wallets.length === 0) {
                console.log("[PollingLoop] No wallets to monitor. Skipping signal fetch.");
                return;
            }

            // Запрашиваем транзакции по ДИНАМИЧЕСКОМУ списку (не статическому массиву)
            const transactions = await nansenClient.getRecentTransactions(
                wallets as `0x${string}`[],
                lastScanTimestamp,
                10_000 // min $10k USD
            );

            lastScanTimestamp = Math.floor(Date.now() / 1000);

            if (transactions.length === 0) {
                console.log("[PollingLoop] No significant transactions detected.");
                return;
            }

            console.log(`[PollingLoop] Found ${transactions.length} transactions to analyze`);

            // ─── Phase C: Generate signals and run pipeline ───────────────
            // Конвертируем transactions → SmartMoneySignal
            for (const tx of transactions) {
                // Простая конвертация — в production обогащается тегами из Nansen
                const signal: SmartMoneySignal = {
                    walletAddress: wallets[0]!, // TODO: map tx → source wallet
                    walletTag: "Whale",
                    reputationScore: 0.8,
                    asset: tx.tokenAddress,
                    assetSymbol: tx.tokenSymbol,
                    action: tx.action as "BUY" | "SELL",
                    tradeVolume: BigInt(Math.floor(tx.amountUsd * 1e18)),
                    totalPortfolioValue: ethers.parseEther("1000000"),
                    detectedAt: tx.timestamp,
                    sourceTxHash: tx.hash,
                };

                try {
                    await pipeline.processSignal(signal, profile);
                } catch (pipeErr) {
                    console.error(
                        `[PollingLoop] Pipeline error for tx ${tx.hash.slice(0, 16)}:`,
                        pipeErr instanceof Error ? pipeErr.message : pipeErr
                    );
                    // Non-fatal: continue to next signal
                }
            }
        } catch (err) {
            console.error(
                "[PollingLoop] Signal fetch error (non-fatal):",
                err instanceof Error ? err.message : err
            );
        }
    };

    // Первый tick сразу
    await tick();

    // Периодические тики
    const interval = setInterval(() => {
        void tick();
    }, pollIntervalMs);

    // Cleanup on shutdown
    process.once("SIGINT", () => clearInterval(interval));
    process.once("SIGTERM", () => clearInterval(interval));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  AlphaFlow Suite — TEE Agent (Phala DStack CVM)");
    console.log("  Phase 4: Dynamic Watchlist + Heuristic Clustering");
    console.log("═══════════════════════════════════════════════════════════════");

    // ─── 1. Load & validate config ────────────────────────────────────────
    const config = loadConfig();
    console.log(`[TEE] Chain ID: ${config.chainId}`);
    console.log(`[TEE] Proposal TTL: ${config.proposalTtlSeconds}s`);
    console.log(`[TEE] Attestation: ${config.attestationEnabled ? "ENABLED" : "MOCK"}`);
    console.log(`[TEE] AlphaAuditor: ${config.alphaAuditorAddress}`);
    console.log(`[TEE] Agent ID: ${config.agentId}`);

    // ─── 2. Initialize Redis ──────────────────────────────────────────────
    const redis = new Redis(config.redisUrl, {
        lazyConnect: false,
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => Math.min(times * 200, 3000),
    });

    redis.on("error", (err) => {
        console.error("[TEE:Redis] Connection error:", err.message);
    });

    redis.on("connect", () => {
        console.log("[TEE:Redis] Connected successfully");
    });

    // ─── 3. Initialize DynamicWatchlist ───────────────────────────────────
    const watchlist = new DynamicWatchlist(redis, {
        maxWatchlistSize: parseInt(process.env["MAX_WATCHLIST_SIZE"] ?? "10000", 10),
        maxAdditionsPerEpoch: parseInt(process.env["MAX_ADDITIONS_PER_EPOCH"] ?? "50", 10),
        epochDurationSec: parseInt(process.env["EPOCH_DURATION_SEC"] ?? "300", 10),
    });

    // Seed wallets из env (comma-separated)
    const seedWalletsRaw = process.env["SEED_WALLETS"] ?? "";
    if (seedWalletsRaw) {
        const seeds = seedWalletsRaw.split(",").map((s) => s.trim()).filter(Boolean);
        if (seeds.length > 0) {
            await watchlist.addSeeds(seeds, "Whale");
            console.log(`[TEE] Seeded ${seeds.length} initial whale wallets`);
        }
    }

    const currentSize = await watchlist.size();
    console.log(`[TEE] DynamicWatchlist ready | current size: ${currentSize} wallets`);

    // ─── 4. Initialize Clustering Engine ──────────────────────────────────
    const clusteringConfig: Partial<ClusteringEngineConfig> = {
        rpcUrl: process.env["MANTLE_RPC_URL"] ?? "https://rpc.mantle.xyz",
        rpcFallbacks: [
            process.env["MANTLE_RPC_FALLBACK_1"] ?? "https://rpc.ankr.com/mantle",
            process.env["MANTLE_RPC_FALLBACK_2"] ?? "https://mantle.public-rpc.com",
        ],
        minTransferThresholdUsd: parseFloat(process.env["MIN_TRANSFER_THRESHOLD_USD"] ?? "50000"),
        lookbackBlocks: parseInt(process.env["LOOKBACK_BLOCKS"] ?? "100", 10),
        enableGasFundingRule: process.env["ENABLE_GAS_FUNDING_RULE"] !== "false",
        maxDiscoveriesPerTick: parseInt(process.env["MAX_DISCOVERIES_PER_TICK"] ?? "20", 10),
    };

    const clusteringEngine = new ClusteringEngine(watchlist, clusteringConfig);
    console.log(`[TEE] ClusteringEngine ready | threshold: $${clusteringConfig.minTransferThresholdUsd}`);

    // ─── 5. Generate in-memory signer (NEVER persisted) ──────────────────
    const signer = generateTeeSigner();

    // ─── 6. Initialize YieldArchitect ─────────────────────────────────────
    const architect = new YieldArchitect(signer, config.chainId, 0);
    console.log(`[TEE] YieldArchitect ready. Nonce: ${architect.currentNonce}`);

    // ─── 7. Initialize SentinelExecutor (for Proof-of-Alpha commits) ──────
    const executorConfig: ExecutorConfig = {
        sessionPrivateKey: process.env["SESSION_PRIVATE_KEY"] as `0x${string}` ?? "0x",
        kernelAddress: process.env["KERNEL_ADDRESS"] as `0x${string}` ?? "0x",
        activeSentinelAddress: process.env["ACTIVE_SENTINEL_ADDRESS"] as `0x${string}` ?? "0x",
        alphaAuditorAddress: config.alphaAuditorAddress as `0x${string}`,
        agentId: config.agentId,
        bundlerUrl: process.env["BUNDLER_URL"] ?? "",
        rpcUrl: process.env["MANTLE_RPC_URL"] ?? "https://rpc.mantle.xyz",
        chainId: config.chainId,
    };
    const executor = new SentinelExecutor(executorConfig);
    console.log(`[TEE] SentinelExecutor ready (Proof-of-Alpha + Flash Arb)`);

    // ─── 8. Initialize ProposalPublisher (Redis Streams) ──────────────────
    const publisher = new ProposalPublisher(
        {
            redisUrl: config.redisUrl,
            streamKey: "agent_insights",
            defaultDeadlineOffsetSec: config.proposalTtlSeconds,
            maxStreamLength: 1000,
        },
        null
    );
    console.log(`[TEE] ProposalPublisher ready (stream: agent_insights)`);

    // ─── 9. Initialize Nansen MCP Client ──────────────────────────────────
    const nansenConfig: NansenMCPConfig = {
        apiUrl: process.env["NANSEN_API_URL"] ?? "https://api.nansen.ai",
        apiKey: process.env["NANSEN_API_KEY"] ?? "",
        chain: "mantle",
        timeoutMs: parseInt(process.env["NANSEN_TIMEOUT_MS"] ?? "15000", 10),
        maxRetries: parseInt(process.env["NANSEN_MAX_RETRIES"] ?? "3", 10),
    };
    const nansenClient = new NansenMCPClient(nansenConfig);
    console.log(`[TEE] NansenMCPClient ready (chain: ${nansenConfig.chain})`);

    // ─── 10. Initialize Circuit Breaker ──────────────────────────────────
    const circuitBreaker = new CircuitBreaker(
        process.env["MANTLE_RPC_URL"] ?? "https://rpc.mantle.xyz"
    );
    console.log(`[TEE] CircuitBreaker ready (thresholds: slip=3%, gas=1.5x, oracle=2%)`);

    // ─── 11. Create Pipeline ──────────────────────────────────────────────
    const pipeline = new ProposalPipeline(architect, executor, publisher, config, circuitBreaker);
    console.log(`[TEE] ProposalPipeline ready (commit-before-publish + circuit-breaker)`);

    // ─── 12. Start health/attestation endpoint ────────────────────────────
    startHealthServer(config.healthPort, architect.signerAddress, config, watchlist);

    // ─── 13. User risk profile (загружается из Redis в production) ────────
    const profile: UserRiskProfile = {
        accountAddress: process.env["USER_ACCOUNT_ADDRESS"] ?? "0x0000000000000000000000000000000000000000",
        availableBalance: ethers.parseEther(process.env["USER_BALANCE_ETH"] ?? "10000"),
        riskCoefficient: parseFloat(process.env["RISK_COEFFICIENT"] ?? "0.5"),
        maxSlippageBps: parseInt(process.env["MAX_SLIPPAGE_BPS"] ?? "200", 10),
        minProfitThreshold: ethers.parseEther(process.env["MIN_PROFIT_ETH"] ?? "10"),
    };

    // ─── 13. Start Polling Loop ───────────────────────────────────────────
    const pollIntervalMs = parseInt(process.env["POLL_INTERVAL_MS"] ?? "120000", 10); // 2 min default
    const isProductionMode = !!(
        executorConfig.bundlerUrl &&
        executorConfig.sessionPrivateKey !== "0x" &&
        nansenConfig.apiKey
    );

    if (isProductionMode) {
        console.log(`\n[TEE] Starting PRODUCTION polling loop (interval: ${pollIntervalMs / 1000}s)...`);
        console.log("[TEE] Flow: Clustering → Nansen Fetch → Pipeline → Publish\n");

        await startPollingLoop(
            clusteringEngine,
            nansenClient,
            watchlist,
            pipeline,
            profile,
            pollIntervalMs
        );
    } else {
        // ─── DEV MODE: demonstration run ──────────────────────────────────
        console.log("\n[TEE] Running in DEV mode (no bundler/Nansen configured)...");
        console.log("[TEE] Demonstrating: clustering tick + proposal generation\n");

        // Demo: run one clustering tick
        console.log("[TEE] ─── Demo: Clustering Tick ───");
        try {
            const clusterResult = await clusteringEngine.runTick();
            console.log("[TEE] Clustering result:", clusterResult);
        } catch (err) {
            console.log("[TEE] Clustering tick skipped (no RPC in dev):", (err as Error).message);
        }

        // Demo: generate proposal without on-chain commit
        const demoSignal: SmartMoneySignal = {
            walletAddress: "0x28C6c06298d514Db089934071355E5743bf21d60",
            walletTag: "Fund",
            reputationScore: 0.92,
            asset: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
            assetSymbol: "WMNT",
            action: "BUY",
            tradeVolume: ethers.parseEther("500000"),
            totalPortfolioValue: ethers.parseEther("10000000"),
            detectedAt: Math.floor(Date.now() / 1000),
            sourceTxHash: "0xabc123def456789012345678901234567890123456789012345678901234abcd",
        };

        console.log("\n[TEE] ─── Demo: Proposal Generation ───");
        const signed = await architect.generateProposal(
            demoSignal,
            profile,
            config.proposalTtlSeconds
        );

        console.log("[TEE] ═══ Proposal Generated (DEV) ═══");
        console.log(`  Asset:       ${signed.asset}`);
        console.log(`  Action:      ${signed.action}`);
        console.log(`  Amount:      ${ethers.formatEther(signed.recommendedAmount)} tokens`);
        console.log(`  Nonce:       ${signed.nonce}`);
        console.log(`  Deadline:    ${new Date(signed.deadline * 1000).toISOString()}`);
        console.log(`  ReasonHash:  ${signed.reasoningHash}`);
        console.log(`  InsightHash: ${signed.insightHash}`);
        console.log(`  Signature:   ${signed.signature.slice(0, 20)}...`);
        console.log(`  Signer:      ${signed.signerAddress}`);

        const isValid = YieldArchitect.verifyProposal(
            signed,
            signed.signature,
            signed.signerAddress,
            config.chainId
        );
        console.log(`  Verified:    ${isValid ? "✓ VALID" : "✗ INVALID"}`);

        // Show watchlist stats
        console.log("\n[TEE] ─── Watchlist Stats ───");
        const stats = await watchlist.getStats();
        console.log(`  Total wallets:  ${stats.totalWallets}`);
        console.log(`  Seeds:          ${stats.seedCount}`);
        console.log(`  Discovered:     ${stats.discoveredCount}`);
        console.log(`  Clusters:       ${stats.clusterCount}`);

        console.log("\n[TEE] ⚠️  In production, this would run in a loop:");
        console.log("  1. ClusteringEngine.runTick() → expand watchlist");
        console.log("  2. NansenMCP.getRecentTransactions(dynamicWallets) → signals");
        console.log("  3. Pipeline.processSignal(signal) → on-chain commit + publish");
    }

    // ─── 14. Keep alive ──────────────────────────────────────────────────
    console.log("\n[TEE] Agent running. Waiting for signals...");
    console.log("[TEE] Press Ctrl+C to shutdown.\n");

    // Graceful shutdown
    const shutdown = async (): Promise<void> => {
        console.log("\n[TEE] Shutting down gracefully...");
        await redis.quit();
        console.log("[TEE] Redis disconnected.");
        console.log("[TEE] Signer key destroyed (garbage collected).");
        process.exit(0);
    };

    process.once("SIGINT", () => { void shutdown(); });
    process.once("SIGTERM", () => { void shutdown(); });
}

// ─── Execution ────────────────────────────────────────────────────────────────

main().catch((err: unknown) => {
    console.error("[TEE] FATAL:", err);
    process.exit(1);
});
