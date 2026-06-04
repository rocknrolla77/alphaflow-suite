// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — agent-tee/src/main.ts
// Entry Point для TEE-агента "Мозг" (Phala Network CVM)
// Phase 5: Swarm Mode — TEE только подписывает, НЕ отправляет TX
//
// БЕЗОПАСНОСТЬ:
// - Приватный ключ генерируется IN-MEMORY при каждом запуске
// - NEVER: не логируется, не записывается на диск, не передаётся по сети
// - Экспортируется ТОЛЬКО публичный адрес (через health endpoint)
//
// SWARM MODE PIPELINE:
// 1. ClusteringEngine → расширяет watchlist
// 2. NansenMCPClient → fresh Smart Money signals
// 3. YieldArchitect.computeInsightHash() → deterministic Proof-of-Alpha
// 4. SentinelExecutor.commitProofOfAlpha(insightHash) → ON-CHAIN COMMIT (blocking)
// 5. YieldArchitect.generateForwardRequest() → signed EIP-712 ForwardRequest
// 6. ProposalPublisher.publish(signedForwardRequest) → Redis Stream
//
// КРИТИЧЕСКИЙ ИНВАРИАНТ:
//   Шаг 4 (commit) СТРОГО ДО Шага 6 (publish).
//   Если commit fails → publish НИКОГДА не выполняется.
//
// TEE НЕ ЗНАЕТ об отправке транзакций.
// "Мускулы" (Swarm Workers) слушают Redis и relay on-chain за свой газ.
// ═══════════════════════════════════════════════════════════════════════════════

import { parseEther, formatEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { Redis } from "ioredis";
import http from "node:http";
import type {
    AgentConfig,
    SmartMoneySignal,
    UserRiskProfile,
    SignedForwardRequest,
} from "./types/index.js";
import { YieldArchitect, type ArbParams } from "./strategies/yieldArchitect.js";
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
    dispatcherAddress: z.string()
        .regex(/^0x[a-fA-F0-9]{40}$/, "DISPATCHER_ADDRESS must be valid Ethereum address"),
    activeSentinelAddress: z.string()
        .regex(/^0x[a-fA-F0-9]{40}$/, "ACTIVE_SENTINEL_ADDRESS must be valid Ethereum address"),
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
        dispatcherAddress: process.env["DISPATCHER_ADDRESS"] ?? "0x0000000000000000000000000000000000000000",
        activeSentinelAddress: process.env["ACTIVE_SENTINEL_ADDRESS"] ?? "0x0000000000000000000000000000000000000000",
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
function generateTeeSigner(): `0x${string}` {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    console.log(`[TEE] Ephemeral signer generated: ${account.address}`);
    console.log(`[TEE] ⚠️  Key exists ONLY in-memory. Lost on restart.`);
    return privateKey;
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
                mode: "swarm",
                signer: signerAddress,
                chainId: config.chainId,
                attestation: config.attestationEnabled,
                agentId: config.agentId.toString(),
                dispatcher: config.dispatcherAddress,
                activeSentinel: config.activeSentinelAddress,
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

// ─── Swarm Pipeline (replaces old ProposalPipeline) ──────────────────────────

/**
 * SwarmPipeline — "Мозг" TEE-агента в Swarm Mode.
 *
 * РАЗДЕЛЕНИЕ ОТВЕТСТВЕННОСТИ:
 *   TEE Pipeline (здесь):
 *     - Рассчитывает стратегию
 *     - Коммитит Proof-of-Alpha on-chain
 *     - Подписывает ForwardRequest (EIP-712)
 *     - Публикует в Redis Stream
 *
 *   Swarm Workers (swarmWorker.ts):
 *     - Слушают Redis Stream
 *     - Relay ForwardRequest on-chain
 *     - Получают MNT рефанд
 *
 * TEE НИКОГДА не отправляет executeFlashArbitrage.
 * TEE отправляет ТОЛЬКО commitInsight (через executor).
 */
class SwarmPipeline {
    private readonly architect: YieldArchitect;
    private readonly executor: SentinelExecutor;
    private readonly circuitBreaker: CircuitBreaker;
    private readonly config: AgentConfig;
    private readonly redis: Redis;

    constructor(
        architect: YieldArchitect,
        executor: SentinelExecutor,
        _publisher: ProposalPublisher,
        config: AgentConfig,
        redis: Redis,
        circuitBreaker?: CircuitBreaker
    ) {
        this.architect = architect;
        this.executor = executor;
        this.config = config;
        this.redis = redis;
        this.circuitBreaker = circuitBreaker ?? new CircuitBreaker();
    }

    /**
     * Полный Swarm pipeline: signal → compute → commit → sign → publish
     */
    async processSignal(
        signal: SmartMoneySignal,
        profile: UserRiskProfile,
        arbParams: ArbParams
    ): Promise<SignedForwardRequest> {
        const pipelineId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        console.log(`\n[Pipeline:${pipelineId}] ═══ Starting (Swarm Mode) ═══`);
        console.log(`[Pipeline:${pipelineId}] Signal: ${signal.assetSymbol} ${signal.action}`);
        console.log(`[Pipeline:${pipelineId}] Source: ${signal.walletTag} (rep: ${signal.reputationScore})`);

        // ─── STEP 1: Compute volumes + hashes ───────────────────────────────
        console.log(`[Pipeline:${pipelineId}] Step 1: Computing volumes and hashes...`);

        const recommendedAmount = this.architect.calculateVolume(signal, profile);
        const timestamp = Math.floor(Date.now() / 1000);
        const insightHash = this.architect.computeInsightHash(
            signal.asset,
            signal.action,
            recommendedAmount,
            timestamp
        );

        console.log(`[Pipeline:${pipelineId}] Step 1 ✓`);
        console.log(`  Amount: ${formatEther(recommendedAmount)} tokens`);
        console.log(`  InsightHash: ${insightHash}`);

        // ─── STEP 2: Circuit Breaker (pre-commit check) ─────────────────────
        console.log(`[Pipeline:${pipelineId}] Step 2: Circuit Breaker validation...`);

        try {
            await this.circuitBreaker.validateMarketConditions({
                estimatedSlippage: profile.maxSlippageBps / 10000,
            });
            console.log(`[Pipeline:${pipelineId}] Step 2 ✓ Market conditions OK`);
        } catch (haltError) {
            if (haltError instanceof CriticalHaltError) {
                console.error(
                    `[Pipeline:${pipelineId}] Step 2 ✗ CIRCUIT BREAKER TRIGGERED\n` +
                    `  Reason: ${haltError.reason}\n` +
                    `  Action: ForwardRequest WILL NOT be created.`
                );
                throw haltError;
            }
            throw haltError;
        }

        // ─── STEP 3: Commit Proof-of-Alpha ON-CHAIN (BLOCKING) ──────────────
        console.log(`[Pipeline:${pipelineId}] Step 3: Committing Proof-of-Alpha on-chain...`);

        let commitTxHash: `0x${string}`;
        try {
            const commitResult = await this.executor.commitProofOfAlpha(insightHash);
            commitTxHash = commitResult.txHash;
        } catch (commitError) {
            const errMsg = commitError instanceof Error
                ? commitError.message
                : String(commitError);

            console.error(`[Pipeline:${pipelineId}] Step 3 ✗ FAILED: ${errMsg}`);
            console.error(`[Pipeline:${pipelineId}] ═══ ABORTED ═══ ForwardRequest NOT created.`);
            throw new Error(
                `[Pipeline] Proof-of-Alpha commit failed. ForwardRequest discarded.\n` +
                `  Reason: ${errMsg}\n` +
                `  InsightHash: ${insightHash}\n` +
                `  AgentId: ${this.config.agentId}`
            );
        }

        console.log(`[Pipeline:${pipelineId}] Step 3 ✓ Committed on-chain`);
        console.log(`  TxHash: ${commitTxHash}`);

        // ─── STEP 4: Generate & Sign ForwardRequest (EIP-712) ───────────────
        console.log(`[Pipeline:${pipelineId}] Step 4: Signing ForwardRequest (EIP-712)...`);

        const signedRequest = await this.architect.generateForwardRequest(
            arbParams,
            insightHash,
            commitTxHash,
            this.config.proposalTtlSeconds
        );

        console.log(`[Pipeline:${pipelineId}] Step 4 ✓ ForwardRequest signed`);
        console.log(`  Target: ${signedRequest.request.target}`);
        console.log(`  Nonce: ${signedRequest.request.nonce}`);
        console.log(`  Deadline: ${new Date(Number(signedRequest.request.deadline) * 1000).toISOString()}`);

        // ─── STEP 5: Publish to Redis Stream → Swarm Workers ────────────────
        console.log(`[Pipeline:${pipelineId}] Step 5: Publishing to Redis Stream...`);

        const payload = JSON.stringify({
            request: {
                target: signedRequest.request.target,
                data: signedRequest.request.data,
                value: signedRequest.request.value.toString(),
                nonce: signedRequest.request.nonce.toString(),
                deadline: signedRequest.request.deadline.toString(),
            },
            signature: signedRequest.signature,
            signerAddress: signedRequest.signerAddress,
            generatedAt: signedRequest.generatedAt,
            insightHash: signedRequest.insightHash,
            commitTxHash: signedRequest.commitTxHash,
        });

        const maxLen = 1000;
        const streamId = await this.redis.xadd(
            "agent_insights",
            "MAXLEN", "~", maxLen,
            "*",
            "payload", payload
        );

        console.log(`[Pipeline:${pipelineId}] Step 5 ✓ Published to Redis`);
        console.log(`  Stream ID: ${streamId}`);
        console.log(`[Pipeline:${pipelineId}] ═══ COMPLETE ═══`);
        console.log(`  Asset: ${signal.asset}`);
        console.log(`  Action: ${signal.action}`);
        console.log(`  Amount: ${formatEther(recommendedAmount)}`);
        console.log(`  InsightHash: ${insightHash}`);
        console.log(`  CommitTxHash: ${commitTxHash}`);
        console.log(`  ForwardRequest Nonce: ${signedRequest.request.nonce}`);

        return signedRequest;
    }
}

// ─── Polling Loop ─────────────────────────────────────────────────────────────

async function startPollingLoop(
    clusteringEngine: ClusteringEngine,
    nansenClient: NansenMCPClient,
    watchlist: DynamicWatchlist,
    pipeline: SwarmPipeline,
    profile: UserRiskProfile,
    pollIntervalMs: number
): Promise<void> {
    let lastScanTimestamp = Math.floor(Date.now() / 1000) - 300;

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

            const wallets = await watchlist.getWatchedWalletsArray();

            if (wallets.length === 0) {
                console.log("[PollingLoop] No wallets to monitor. Skipping signal fetch.");
                return;
            }

            const transactions = await nansenClient.getRecentTransactions(
                wallets as `0x${string}`[],
                lastScanTimestamp,
                10_000
            );

            lastScanTimestamp = Math.floor(Date.now() / 1000);

            if (transactions.length === 0) {
                console.log("[PollingLoop] No significant transactions detected.");
                return;
            }

            console.log(`[PollingLoop] Found ${transactions.length} transactions to analyze`);

            // ─── Phase C: Generate signals and run Swarm pipeline ─────────
            for (const tx of transactions) {
                const signal: SmartMoneySignal = {
                    walletAddress: wallets[0]!,
                    walletTag: "Whale",
                    reputationScore: 0.8,
                    asset: tx.tokenAddress,
                    assetSymbol: tx.tokenSymbol,
                    action: tx.action as "BUY" | "SELL",
                    tradeVolume: BigInt(Math.floor(tx.amountUsd * 1e18)),
                    totalPortfolioValue: parseEther("1000000"),
                    detectedAt: tx.timestamp,
                    sourceTxHash: tx.hash,
                };

                // TODO: In production, ArbParams come from Byreal/1inch routing API
                const arbParams: ArbParams = {
                    borrowToken: tx.tokenAddress as Address,
                    borrowAmount: BigInt(Math.floor(tx.amountUsd * 1e18 * 0.05)), // 5% of signal
                    minProfit: parseEther("5"), // Min 5 MNT profit
                    swapTarget: "0x0000000000000000000000000000000000000000" as Address, // Placeholder
                    swapCalldata: "0x" as Hex, // Placeholder
                };

                try {
                    await pipeline.processSignal(signal, profile, arbParams);
                } catch (pipeErr) {
                    console.error(
                        `[PollingLoop] Pipeline error for tx ${tx.hash.slice(0, 16)}:`,
                        pipeErr instanceof Error ? pipeErr.message : pipeErr
                    );
                }
            }
        } catch (err) {
            console.error(
                "[PollingLoop] Signal fetch error (non-fatal):",
                err instanceof Error ? err.message : err
            );
        }
    };

    await tick();

    const interval = setInterval(() => {
        void tick();
    }, pollIntervalMs);

    process.once("SIGINT", () => clearInterval(interval));
    process.once("SIGTERM", () => clearInterval(interval));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  AlphaFlow Suite — TEE Agent 'Brain' (Phala DStack CVM)");
    console.log("  Phase 5: Swarm Mode — Sign & Publish Only");
    console.log("═══════════════════════════════════════════════════════════════");

    // ─── 1. Load & validate config ────────────────────────────────────────
    const config = loadConfig();
    console.log(`[TEE] Chain ID: ${config.chainId}`);
    console.log(`[TEE] Proposal TTL: ${config.proposalTtlSeconds}s`);
    console.log(`[TEE] Attestation: ${config.attestationEnabled ? "ENABLED" : "MOCK"}`);
    console.log(`[TEE] AlphaAuditor: ${config.alphaAuditorAddress}`);
    console.log(`[TEE] Dispatcher: ${config.dispatcherAddress}`);
    console.log(`[TEE] ActiveSentinel: ${config.activeSentinelAddress}`);
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
    const teePrivateKey = generateTeeSigner();
    const teeAccount = privateKeyToAccount(teePrivateKey);

    // ─── 6. Initialize YieldArchitect (Swarm Mode) ───────────────────────
    const architect = new YieldArchitect(
        teePrivateKey,
        config.chainId,
        config.activeSentinelAddress as Address,
        0n
    );
    console.log(`[TEE] YieldArchitect ready (Swarm Mode). Nonce: ${architect.currentNonce}`);

    // ─── 7. Initialize SentinelExecutor (ONLY for Proof-of-Alpha commits) ─
    const executorConfig: ExecutorConfig = {
        sessionPrivateKey: process.env["SESSION_PRIVATE_KEY"] as `0x${string}` ?? "0x",
        kernelAddress: process.env["KERNEL_ADDRESS"] as `0x${string}` ?? "0x",
        activeSentinelAddress: config.activeSentinelAddress as `0x${string}`,
        alphaAuditorAddress: config.alphaAuditorAddress as `0x${string}`,
        agentId: config.agentId,
        bundlerUrl: process.env["BUNDLER_URL"] ?? "",
        rpcUrl: process.env["MANTLE_RPC_URL"] ?? "https://rpc.mantle.xyz",
        chainId: config.chainId,
    };
    const executor = new SentinelExecutor(executorConfig);
    console.log(`[TEE] SentinelExecutor ready (Proof-of-Alpha commits ONLY)`);

    // ─── 8. Initialize ProposalPublisher (legacy — for BFF/frontend) ──────
    const publisher = new ProposalPublisher(
        {
            redisUrl: config.redisUrl,
            streamKey: "agent_insights",
            defaultDeadlineOffsetSec: config.proposalTtlSeconds,
            maxStreamLength: 1000,
        },
        redis
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

    // ─── 11. Create Swarm Pipeline ──────────────────────────────────────────
    const pipeline = new SwarmPipeline(
        architect, executor, publisher, config, redis, circuitBreaker
    );
    console.log(`[TEE] SwarmPipeline ready (commit-before-publish + ForwardRequest signing)`);

    // ─── 12. Start health/attestation endpoint ────────────────────────────
    startHealthServer(config.healthPort, teeAccount.address, config, watchlist);

    // ─── 13. User risk profile ───────────────────────────────────────────
    const profile: UserRiskProfile = {
        accountAddress: process.env["USER_ACCOUNT_ADDRESS"] ?? "0x0000000000000000000000000000000000000000",
        availableBalance: parseEther(process.env["USER_BALANCE_ETH"] ?? "10000"),
        riskCoefficient: parseFloat(process.env["RISK_COEFFICIENT"] ?? "0.5"),
        maxSlippageBps: parseInt(process.env["MAX_SLIPPAGE_BPS"] ?? "200", 10),
        minProfitThreshold: parseEther(process.env["MIN_PROFIT_ETH"] ?? "10"),
    };

    // ─── 14. Start Polling Loop ──────────────────────────────────────────
    const pollIntervalMs = parseInt(process.env["POLL_INTERVAL_MS"] ?? "120000", 10);
    const isProductionMode = !!(
        executorConfig.bundlerUrl &&
        executorConfig.sessionPrivateKey !== "0x" &&
        nansenConfig.apiKey
    );

    if (isProductionMode) {
        console.log(`\n[TEE] Starting PRODUCTION polling loop (interval: ${pollIntervalMs / 1000}s)...`);
        console.log("[TEE] Flow: Clustering → Nansen → Circuit Breaker → Commit → Sign → Publish\n");

        await startPollingLoop(
            clusteringEngine,
            nansenClient,
            watchlist,
            pipeline,
            profile,
            pollIntervalMs
        );
    } else {
        // ─── DEV MODE: demonstration ─────────────────────────────────────
        console.log("\n[TEE] Running in DEV mode (no bundler/Nansen configured)...");
        console.log("[TEE] Demonstrating: ForwardRequest generation (Swarm Mode)\n");

        // Demo: clustering tick
        console.log("[TEE] ─── Demo: Clustering Tick ───");
        try {
            const clusterResult = await clusteringEngine.runTick();
            console.log("[TEE] Clustering result:", clusterResult);
        } catch (err) {
            console.log("[TEE] Clustering tick skipped (no RPC in dev):", (err as Error).message);
        }

        // Demo: generate ForwardRequest without on-chain commit
        const demoSignal: SmartMoneySignal = {
            walletAddress: "0x28C6c06298d514Db089934071355E5743bf21d60",
            walletTag: "Fund",
            reputationScore: 0.92,
            asset: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
            assetSymbol: "WMNT",
            action: "BUY",
            tradeVolume: parseEther("500000"),
            totalPortfolioValue: parseEther("10000000"),
            detectedAt: Math.floor(Date.now() / 1000),
            sourceTxHash: "0xabc123def456789012345678901234567890123456789012345678901234abcd",
        };

        console.log("\n[TEE] ─── Demo: Volume Calculation ───");
        const recommendedAmount = architect.calculateVolume(demoSignal, profile);
        console.log(`  Recommended: ${formatEther(recommendedAmount)} tokens`);

        console.log("\n[TEE] ─── Demo: InsightHash Computation ───");
        const insightHash = architect.computeInsightHash(
            demoSignal.asset, demoSignal.action, recommendedAmount, Math.floor(Date.now() / 1000)
        );
        console.log(`  InsightHash: ${insightHash}`);

        console.log("\n[TEE] ─── Demo: ForwardRequest Generation ───");
        const demoArbParams: ArbParams = {
            borrowToken: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8" as Address,
            borrowAmount: recommendedAmount,
            minProfit: parseEther("5"),
            swapTarget: "0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57" as Address,
            swapCalldata: "0xdeadbeef" as Hex,
        };

        const signed = await architect.generateForwardRequest(
            demoArbParams,
            insightHash,
            "0x0000000000000000000000000000000000000000000000000000000000000000",
            config.proposalTtlSeconds
        );

        console.log("[TEE] ═══ ForwardRequest Generated (DEV) ═══");
        console.log(`  Target:      ${signed.request.target}`);
        console.log(`  Nonce:       ${signed.request.nonce}`);
        console.log(`  Value:       ${signed.request.value}`);
        console.log(`  Deadline:    ${new Date(Number(signed.request.deadline) * 1000).toISOString()}`);
        console.log(`  Calldata:    ${signed.request.data.slice(0, 20)}...`);
        console.log(`  Signature:   ${signed.signature.slice(0, 20)}...`);
        console.log(`  Signer:      ${signed.signerAddress}`);
        console.log(`  InsightHash: ${signed.insightHash}`);

        // Show watchlist stats
        console.log("\n[TEE] ─── Watchlist Stats ───");
        try {
            const stats = await watchlist.getStats();
            console.log(`  Total wallets:  ${stats.totalWallets}`);
            console.log(`  Seeds:          ${stats.seedCount}`);
            console.log(`  Discovered:     ${stats.discoveredCount}`);
            console.log(`  Clusters:       ${stats.clusterCount}`);
        } catch {
            console.log("  (Redis unavailable in dev)");
        }

        console.log("\n[TEE] ⚠️  In production (Swarm Mode), flow is:");
        console.log("  1. ClusteringEngine.runTick() → expand watchlist");
        console.log("  2. NansenMCP.getRecentTransactions() → signals");
        console.log("  3. CircuitBreaker.validate() → market conditions check");
        console.log("  4. commitInsight(insightHash) → on-chain Proof-of-Alpha");
        console.log("  5. generateForwardRequest(arbParams) → EIP-712 signed");
        console.log("  6. XADD agent_insights → Redis Stream");
        console.log("  7. Swarm Workers XREAD → relay on-chain → get MNT refund");
    }

    // ─── 15. Keep alive ──────────────────────────────────────────────────
    console.log("\n[TEE] Agent 'Brain' running. Waiting for signals...");
    console.log("[TEE] Swarm Workers will handle on-chain execution.");
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
