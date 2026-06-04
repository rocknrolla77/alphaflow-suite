// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — agent-tee/src/swarmWorker.ts
// Byreal Swarm Worker: независимый Node.js процесс-релейер
//
// АРХИТЕКТУРА:
//   TEE "Мозг" → Redis Stream (agent_insights) → Swarm Workers "Мускулы"
//   Каждый Worker подхватывает ForwardRequest и отправляет on-chain.
//   Worker оплачивает газ из своего кошелька, получает MNT рефанд от Dispatcher.
//
// RACE CONDITION (by design):
//   Несколько Workers слушают один Redis Stream.
//   Первый, чья TX проходит on-chain — получает рефанд.
//   Остальные получают revert (nonce already used) — это OK.
//
// ENTRY POINT:
//   npm run start:worker
//   tsx src/swarmWorker.ts
// ═══════════════════════════════════════════════════════════════════════════════

import { Redis } from "ioredis";
import {
    createPublicClient,
    createWalletClient,
    http,
    parseAbi,
    type Address,
    type Hex,
    type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mantle } from "viem/chains";
import { z } from "zod";
import type { SignedForwardRequest } from "./types/index.js";

// ─── Configuration ───────────────────────────────────────────────────────────

const WorkerConfigSchema = z.object({
    relayerPrivateKey: z.string().regex(/^0x[a-fA-F0-9]{64}$/, "Invalid RELAYER_PRIVATE_KEY"),
    redisUrl: z.string().min(1, "REDIS_URL is required"),
    rpcUrl: z.string().url("RPC_URL must be valid URL"),
    dispatcherAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid DISPATCHER_ADDRESS"),
    streamKey: z.string().default("agent_insights"),
    /** Worker ID (для логов и consumer group) */
    workerId: z.string().default(`worker-${process.pid}`),
    /** Minimum MNT balance to continue relaying (wei) */
    minBalanceWei: z.bigint().default(BigInt("100000000000000000")), // 0.1 MNT
});

type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

function loadWorkerConfig(): WorkerConfig {
    return WorkerConfigSchema.parse({
        relayerPrivateKey: process.env["RELAYER_PRIVATE_KEY"],
        redisUrl: process.env["REDIS_URL"] ?? "redis://localhost:6379",
        rpcUrl: process.env["RPC_URL"] ?? "https://rpc.mantle.xyz",
        dispatcherAddress: process.env["DISPATCHER_ADDRESS"] ?? "0x0000000000000000000000000000000000000000",
        streamKey: process.env["STREAM_KEY"] ?? "agent_insights",
        workerId: process.env["WORKER_ID"] ?? `worker-${process.pid}`,
        minBalanceWei: BigInt(process.env["MIN_BALANCE_WEI"] ?? "100000000000000000"),
    });
}

// ─── ABI ─────────────────────────────────────────────────────────────────────

const DISPATCHER_ABI = parseAbi([
    "function executeValidatedCall((address target, bytes data, uint256 value, uint256 nonce, uint256 deadline) req, bytes signature) payable returns (bool success, bytes returnData)",
    "event CallExecuted(address indexed signer, address indexed target, uint256 nonce, bool success, uint256 gasRefund)",
]);

// ─── Swarm Worker ────────────────────────────────────────────────────────────

class SwarmWorker {
    private readonly config: WorkerConfig;
    private readonly redis: Redis;
    private readonly account: ReturnType<typeof privateKeyToAccount>;
    private readonly publicClient: ReturnType<typeof createPublicClient>;
    private readonly walletClient: ReturnType<typeof createWalletClient>;
    private lastStreamId: string = "0-0"; // Start from beginning (or "$" for new only)
    private isRunning: boolean = true;
    private totalRelayed: number = 0;
    private totalRefundMNT: bigint = 0n;

    constructor(config: WorkerConfig) {
        this.config = config;
        this.redis = new Redis(config.redisUrl, {
            lazyConnect: false,
            maxRetriesPerRequest: 3,
            retryStrategy: (times) => Math.min(times * 500, 5000),
        });
        this.account = privateKeyToAccount(config.relayerPrivateKey as `0x${string}`);

        const chain: Chain = {
            ...mantle,
            rpcUrls: {
                default: { http: [config.rpcUrl] },
            },
        };

        this.publicClient = createPublicClient({
            chain,
            transport: http(config.rpcUrl),
        });

        this.walletClient = createWalletClient({
            account: this.account,
            chain,
            transport: http(config.rpcUrl),
        });
    }

    /**
     * Основной loop: XREAD BLOCK → relay → repeat
     */
    async run(): Promise<void> {
        console.log("═══════════════════════════════════════════════════════════════");
        console.log(`  AlphaFlow Swarm Worker: ${this.config.workerId}`);
        console.log(`  Relayer: ${this.account.address}`);
        console.log(`  Dispatcher: ${this.config.dispatcherAddress}`);
        console.log(`  Stream: ${this.config.streamKey}`);
        console.log("═══════════════════════════════════════════════════════════════");

        // Check initial balance
        const balance = await this.publicClient.getBalance({ address: this.account.address });
        console.log(`[${this.config.workerId}] Balance: ${Number(balance) / 1e18} MNT`);

        if (balance < this.config.minBalanceWei) {
            console.error(`[${this.config.workerId}] FATAL: Balance too low for gas. Exiting.`);
            process.exit(1);
        }

        // Start listening — use "$" to only get NEW messages (not replay history)
        this.lastStreamId = "$";

        while (this.isRunning) {
            try {
                await this.pollAndRelay();
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                console.error(`[${this.config.workerId}] Poll error: ${errMsg}`);
                // Backoff on error
                await this.sleep(2000);
            }
        }

        console.log(`[${this.config.workerId}] Shutting down. Total relayed: ${this.totalRelayed}`);
        await this.redis.quit();
    }

    /**
     * Single XREAD BLOCK iteration.
     * Blocks for up to 5 seconds waiting for new stream entries.
     */
    private async pollAndRelay(): Promise<void> {
        // XREAD BLOCK 5000 STREAMS agent_insights <lastId>
        const results = await this.redis.xread(
            "BLOCK", 5000,
            "STREAMS", this.config.streamKey, this.lastStreamId
        );

        if (!results || results.length === 0) {
            return; // Timeout — no new data
        }

        // results = [[streamKey, [[id, [field, value, ...]], ...]]]
        const [, entries] = results[0]!;

        for (const [entryId, fields] of entries) {
            this.lastStreamId = entryId;

            // Parse payload
            const payloadIdx = fields.indexOf("payload");
            if (payloadIdx === -1 || payloadIdx + 1 >= fields.length) {
                console.warn(`[${this.config.workerId}] Entry ${entryId}: no payload field, skipping`);
                continue;
            }

            const rawPayload = fields[payloadIdx + 1]!;
            let payload: any;
            try {
                payload = JSON.parse(rawPayload);
            } catch {
                console.warn(`[${this.config.workerId}] Entry ${entryId}: invalid JSON, skipping`);
                continue;
            }

            // Expect SignedForwardRequest in the payload
            if (!payload.request || !payload.signature) {
                // Legacy insight format — skip (not a ForwardRequest)
                console.log(`[${this.config.workerId}] Entry ${entryId}: legacy format, skipping`);
                continue;
            }

            console.log(`\n[${this.config.workerId}] ─── New ForwardRequest ───`);
            console.log(`  Stream ID: ${entryId}`);
            console.log(`  Target: ${payload.request.target}`);
            console.log(`  Nonce: ${payload.request.nonce}`);
            console.log(`  Deadline: ${new Date(Number(payload.request.deadline) * 1000).toISOString()}`);

            await this.relayTransaction(payload as SignedForwardRequest, entryId);
        }
    }

    /**
     * Relay ForwardRequest on-chain via MicroFundingDispatcher.executeValidatedCall()
     */
    private async relayTransaction(
        signed: SignedForwardRequest,
        _streamId: string
    ): Promise<void> {
        const startTime = Date.now();

        // Check deadline
        const now = BigInt(Math.floor(Date.now() / 1000));
        const deadline = BigInt(signed.request.deadline);
        if (now >= deadline) {
            console.warn(`[${this.config.workerId}] Request expired (deadline passed). Skipping.`);
            return;
        }

        // Check balance before relay
        const balance = await this.publicClient.getBalance({ address: this.account.address });
        if (balance < this.config.minBalanceWei) {
            console.error(`[${this.config.workerId}] Balance too low (${Number(balance) / 1e18} MNT). Pausing.`);
            await this.sleep(30000); // Wait 30s, maybe refund arrived
            return;
        }

        try {
            // Prepare the ForwardRequest tuple for on-chain call
            const req = {
                target: signed.request.target as Address,
                data: signed.request.data as Hex,
                value: BigInt(signed.request.value),
                nonce: BigInt(signed.request.nonce),
                deadline: BigInt(signed.request.deadline),
            };

            // Simulate first to avoid wasting gas on reverts
            const { request: simulatedRequest } = await this.publicClient.simulateContract({
                account: this.account,
                address: this.config.dispatcherAddress as Address,
                abi: DISPATCHER_ABI,
                functionName: "executeValidatedCall",
                args: [req, signed.signature],
            });

            // Send transaction
            const txHash = await this.walletClient.writeContract(simulatedRequest);

            console.log(`[${this.config.workerId}] TX sent: ${txHash}`);

            // Wait for receipt
            const receipt = await this.publicClient.waitForTransactionReceipt({
                hash: txHash,
                confirmations: 1,
                timeout: 30_000,
            });

            const gasUsed = receipt.gasUsed;
            const effectiveGasPrice = receipt.effectiveGasPrice;
            const gasCost = gasUsed * effectiveGasPrice;
            const elapsed = Date.now() - startTime;

            if (receipt.status === "success") {
                // Parse CallExecuted event for refund amount
                let refundAmount = 0n;
                for (const log of receipt.logs) {
                    // Simplified event parsing — look for gasRefund in last topic
                    if (log.topics[0] === "0x" /* CallExecuted topic hash */) {
                        // In production: proper event decoding
                        // For now log the gas cost as approximate refund
                        refundAmount = gasCost; // Dispatcher refunds at least gas cost
                    }
                }

                this.totalRelayed++;
                this.totalRefundMNT += refundAmount;

                console.log(`[${this.config.workerId}] ✓ SUCCESS in ${elapsed}ms`);
                console.log(`  TX Hash:  ${txHash}`);
                console.log(`  Gas Used: ${gasUsed}`);
                console.log(`  Gas Cost: ${Number(gasCost) / 1e18} MNT`);
                console.log(`  Refund:   ~${Number(refundAmount) / 1e18} MNT`);
                console.log(`  Total Relayed: ${this.totalRelayed}`);
            } else {
                console.error(`[${this.config.workerId}] ✗ TX reverted: ${txHash}`);
                console.error(`  Gas wasted: ${Number(gasCost) / 1e18} MNT`);
            }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);

            // Expected race condition: another worker already relayed
            if (errMsg.includes("nonce") || errMsg.includes("already used") || errMsg.includes("reverted")) {
                console.log(`[${this.config.workerId}] Race lost (nonce used by another worker). OK.`);
            } else {
                console.error(`[${this.config.workerId}] Relay failed: ${errMsg}`);
            }
        }
    }

    /**
     * Graceful shutdown
     */
    stop(): void {
        this.isRunning = false;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const config = loadWorkerConfig();
    const worker = new SwarmWorker(config);

    // Graceful shutdown
    process.once("SIGINT", () => {
        console.log("\n[SwarmWorker] SIGINT received. Shutting down...");
        worker.stop();
    });
    process.once("SIGTERM", () => {
        console.log("\n[SwarmWorker] SIGTERM received. Shutting down...");
        worker.stop();
    });

    await worker.run();
}

main().catch((err: unknown) => {
    console.error("[SwarmWorker] FATAL:", err);
    process.exit(1);
});
