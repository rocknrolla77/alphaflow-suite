// Файл: bff/src/onChainWatcher.ts
// On-Chain Consumption Watcher
// Решает State Desync: если TMA закрылась без /consume,
// watcher отслеживает on-chain event и помечает proposal как executed.

import { Redis } from "ioredis";
import { createPublicClient, http, parseAbi, type Log } from "viem";
import { createFallbackClient, getRpcConfigFromEnv } from "./rpcFallback";

const ACTIVE_SENTINEL_ABI = parseAbi([
    "event FlashArbitrageExecuted(address indexed executor, address tokenA, address tokenB, uint256 profit, uint256 nonce)",
]);

export interface WatcherConfig {
    redis: Redis;
    activeSentinelAddress: `0x${string}`;
    /** Polling interval (ms) — fallback if WebSocket unavailable */
    pollIntervalMs?: number;
}

/**
 * On-Chain Watcher: подписывается на FlashArbitrageExecuted events.
 *
 * Когда UserOp подтверждается on-chain:
 * 1. Получаем event с nonce
 * 2. Ищем proposal в Redis по nonce (indexed)
 * 3. Помечаем status = "executed" (nullifier сжигание)
 *
 * Это ГАРАНТИРУЕТ: даже если TMA не вызвала /consume,
 * state синхронизируется через on-chain event.
 */
export class OnChainWatcher {
    private redis: Redis;
    private publicClient: ReturnType<typeof createPublicClient>;
    private address: `0x${string}`;
    private intervalMs: number;
    private intervalHandle: NodeJS.Timeout | null = null;
    private lastProcessedBlock: bigint = 0n;

    constructor(config: WatcherConfig) {
        this.redis = config.redis;
        this.address = config.activeSentinelAddress;
        this.intervalMs = config.pollIntervalMs || 5000;
        this.publicClient = createFallbackClient(getRpcConfigFromEnv());
    }

    async start(): Promise<void> {
        // Get current block as starting point
        this.lastProcessedBlock = await this.publicClient.getBlockNumber();
        console.log(`[Watcher] Starting from block ${this.lastProcessedBlock}`);

        // Poll for new events
        this.intervalHandle = setInterval(() => this.poll(), this.intervalMs);

        // Also try WebSocket subscription (best-effort)
        this.tryWebSocketSubscription();
    }

    stop(): void {
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }
    }

    private async poll(): Promise<void> {
        try {
            const currentBlock = await this.publicClient.getBlockNumber();
            if (currentBlock <= this.lastProcessedBlock) return;

            const logs = await this.publicClient.getLogs({
                address: this.address,
                event: ACTIVE_SENTINEL_ABI[0] as any,
                fromBlock: this.lastProcessedBlock + 1n,
                toBlock: currentBlock,
            });

            for (const log of logs) {
                await this.processEvent(log);
            }

            this.lastProcessedBlock = currentBlock;
        } catch (err) {
            console.error("[Watcher] Poll error:", (err as Error).message);
            // Don't crash — next poll will retry
        }
    }

    private async processEvent(log: Log): Promise<void> {
        // Decode event args
        const args = (log as any).args;
        if (!args) return;

        const { executor, tokenA, tokenB, profit, nonce } = args;
        const nonceStr = nonce.toString();

        console.log(
            `[Watcher] FlashArbitrageExecuted: executor=${executor}, ` +
            `tokenA=${tokenA}, tokenB=${tokenB}, profit=${profit}, nonce=${nonceStr}`
        );

        // Find proposal by nonce (Redis index)
        const proposalId = await this.redis.get(`nonce_index:${nonceStr}`);
        if (!proposalId) {
            console.log(`[Watcher] No proposal found for nonce ${nonceStr} — external execution`);
            return;
        }

        // Mark as executed (State Desync Fix)
        const raw = await this.redis.get(`proposal:${proposalId}`);
        if (!raw) return;

        const proposal = JSON.parse(raw);
        if (proposal.status === "executed") return; // Already consumed

        proposal.status = "executed";
        proposal.executedOnChain = true;
        proposal.executionTxHash = log.transactionHash;
        proposal.executedAtBlock = Number(log.blockNumber);
        proposal.profitWei = profit.toString();

        const ttl = await this.redis.ttl(`proposal:${proposalId}`);
        await this.redis.set(
            `proposal:${proposalId}`,
            JSON.stringify(proposal),
            "EX",
            Math.max(ttl, 3600) // Keep for 1h minimum for audit
        );

        // Clean up lock
        await this.redis.del(`proposal_lock:${proposalId}`);

        console.log(`[Watcher] Proposal ${proposalId} marked as executed (on-chain confirmed)`);
    }

    private tryWebSocketSubscription(): void {
        // WebSocket is best-effort enhancement over polling
        // Mantle WS endpoint may not always be available
        try {
            // Note: viem watchEvent for real-time (if WS transport available)
            console.log("[Watcher] WebSocket subscription: not available on current transport, using polling");
        } catch {
            // Fallback to polling only — already running
        }
    }
}
