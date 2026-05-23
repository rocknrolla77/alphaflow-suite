// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — agent-tee/src/executor.ts
// Phase 3: Модуль исполнения через Byreal OpenClaw + ZeroDev Session Key
//
// ИЗМЕНЕНИЯ PHASE 3:
//   ✗ УДАЛЕНО: ручная сборка dexPayloadRoute1/Route2 для Merchant Moe / Agni
//   ✓ ДОБАВЛЕНО: ByrealClient.buildExecutionPayload() для подготовки UserOperation
//   ✓ ДОБАВЛЕНО: BloomFilter hash в attestation flow
//
// 2D Nonces (ERC-4337 v0.7) для параллельного пакетирования
// ZeroDev SDK v5.5 API (constants.KERNEL_V3_1, kernelVersion обязателен)
// ═══════════════════════════════════════════════════════════════════════════════

import {
    createPublicClient,
    http,
    encodeFunctionData,
    parseAbi,
    keccak256,
    encodePacked,
    type Chain,
    type Hex,
    type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mantle } from "viem/chains";
import { createKernelAccountClient, createKernelAccount, constants } from "@zerodev/sdk";
import { signerToSessionKeyValidator } from "@zerodev/session-key";
import { PaymasterRateLimiter } from "./services/rateLimiter.js";
import { ByrealClient, type ByrealQuote, type ByrealExecutionPayload } from "./services/byrealClient.js";
import { BloomFilter } from "./services/bloomFilter.js";
import type { RateLimitConfig, ProofOfAlphaCommitResult } from "./types/index.js";

// ─── ABI Definitions ──────────────────────────────────────────────────────────

/**
 * Phase 3: ABI ActiveSentinel обновлён.
 * executeFlashArbitrage теперь принимает generic calldata от Byreal
 * вместо захардкоженных dexPayloadRoute1/2.
 */
const ACTIVE_SENTINEL_ABI = parseAbi([
    "function executeFlashArbitrage(address borrowToken, uint256 borrowAmount, uint256 minProfit, address swapTarget, bytes calldata swapCalldata, uint256 deadline)",
]);

const ALPHA_AUDITOR_ABI = parseAbi([
    "function commitInsight(uint256 agentId, bytes32 insightHash)",
]);

// ─── EntryPoint v0.7 address (ERC-4337) ───────────────────────────────────────
const ENTRYPOINT_ADDRESS_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Phase 3: ArbOpportunity переработан.
 * Вместо двух dexPayload (Route1/2), используем единый ByrealQuote.
 * Маршрутизация полностью делегирована Byreal OpenClaw API.
 */
export interface ArbOpportunity {
    /** Токен для flash borrow (из INIT Capital) */
    borrowToken: Address;
    /** Целевой токен свопа */
    targetToken: Address;
    /** Объём flash borrow (wei) */
    borrowAmount: bigint;
    /** Минимальный профит в borrowToken (wei) */
    minProfit: bigint;
    /** Допустимый slippage (bps) */
    slippageBps: number;
    /** Deadline для исполнения (seconds from now) */
    deadlineSeconds?: number;
}

export interface ExecutorConfig {
    sessionPrivateKey: `0x${string}`;
    kernelAddress: `0x${string}`;
    activeSentinelAddress: `0x${string}`;
    alphaAuditorAddress: `0x${string}`;
    agentId: bigint;
    bundlerUrl: string;
    rpcUrl: string;
    chainId: number;
}

/** Результат исполнения арбитража */
export interface ArbExecutionResult {
    userOpHash: `0x${string}`;
    txHash: `0x${string}`;
    success: boolean;
    nonceKey: string;
    /** Byreal quote ID использованный для маршрутизации */
    quoteId: string;
    /** Estimated output из Byreal */
    estimatedOutput: bigint;
}

// ─── Executor Class ───────────────────────────────────────────────────────────

/**
 * SentinelExecutor — Phase 3: Byreal-powered execution.
 *
 * КЛЮЧЕВЫЕ ИЗМЕНЕНИЯ:
 *   1. Вся DEX маршрутизация через ByrealClient (OpenClaw CLMM aggregation)
 *   2. Bloom Filter hash включается в attestation data
 *   3. Удалена ручная сборка calldata для Merchant Moe / Agni
 *   4. Single calldata path вместо двух dexPayloadRoute (flash → swap → repay)
 *
 * FLOW:
 *   ArbOpportunity → ByrealClient.getQuote() → ByrealClient.buildExecutionPayload()
 *   → encodeFunctionData(ActiveSentinel.executeFlashArbitrage) → UserOperation
 */
export class SentinelExecutor {
    private config: ExecutorConfig;
    private rateLimiter: PaymasterRateLimiter;
    private byrealClient: ByrealClient;
    private bloomFilter: BloomFilter | null = null;

    constructor(
        config: ExecutorConfig,
        rateLimitConfig?: RateLimitConfig,
        byrealClient?: ByrealClient,
        bloomFilter?: BloomFilter
    ) {
        this.config = config;
        this.rateLimiter = new PaymasterRateLimiter(
            rateLimitConfig || {
                maxOpsPerMinute: 5,
                maxOpsPerHour: 30,
                revertCooldownSec: 30,
            }
        );
        this.byrealClient = byrealClient || new ByrealClient();
        this.bloomFilter = bloomFilter || null;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //                    SHARED HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Создаёт ZeroDev Kernel client для отправки UserOperations.
     * Использует Session Key для подписи (TEE → Session Key → Kernel v3.1).
     */
    private async createKernelClient(publicClient: ReturnType<typeof createPublicClient>) {
        const sessionSigner = privateKeyToAccount(this.config.sessionPrivateKey);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sessionKeyValidator = await signerToSessionKeyValidator(publicClient as any, {
            signer: sessionSigner,
            entryPoint: { address: ENTRYPOINT_ADDRESS_V07, version: "0.7" },
            kernelVersion: constants.KERNEL_V3_1,
            validatorData: { permissions: [] },
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const kernelAccount = await createKernelAccount(publicClient as any, {
            entryPoint: { address: ENTRYPOINT_ADDRESS_V07, version: "0.7" },
            kernelVersion: constants.KERNEL_V3_1,
            address: this.config.kernelAddress,
            plugins: { regular: sessionKeyValidator },
        });

        const kernelClient = createKernelAccountClient({
            account: kernelAccount,
            chain: mantle as Chain,
            bundlerTransport: http(this.config.bundlerUrl),
        });

        return kernelClient;
    }

    /**
     * Проверяет текущий baseFee и отклоняет если превышает порог.
     * Защита от gas drain через завышенный maxFeePerGas.
     */
    private async validateGasPrice(
        publicClient: ReturnType<typeof createPublicClient>,
        maxAllowedGwei: bigint = 50n
    ): Promise<{ baseFee: bigint; isAcceptable: boolean }> {
        const block = await publicClient.getBlock({ blockTag: "latest" });
        const baseFee = block.baseFeePerGas || 0n;
        const maxAllowedWei = maxAllowedGwei * 10n ** 9n;

        return {
            baseFee,
            isAcceptable: baseFee <= maxAllowedWei,
        };
    }

    /**
     * Phase 3: Nonce key вычисляется из Byreal quoteId (уникальный per-route).
     */
    public computeRouteNonceKey(quote: ByrealQuote): bigint {
        const routeHash = keccak256(
            encodePacked(
                ["address", "address", "string"],
                [quote.tokenIn, quote.tokenOut, quote.quoteId]
            )
        );
        return BigInt(routeHash.slice(0, 50)); // uint192
    }

    /**
     * Фиксированный nonce key для AlphaAuditor коммитов.
     */
    public get auditorNonceKey(): bigint {
        const hash = keccak256(
            encodePacked(
                ["string", "address"],
                ["alpha_auditor_commit", this.config.alphaAuditorAddress]
            )
        );
        return BigInt(hash.slice(0, 50));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //                    BLOOM FILTER INTEGRATION
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Устанавливает Bloom Filter для использования в attestation.
     */
    setBloomFilter(filter: BloomFilter): void {
        this.bloomFilter = filter;
    }

    /**
     * Возвращает hash конфигурации Bloom Filter.
     * Используется в Remote Attestation (reportData = keccak256(proposalHash, bloomFilterHash)).
     */
    getBloomFilterHash(): Hex | null {
        return this.bloomFilter?.getFilterConfigHash() ?? null;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //                    PROOF-OF-ALPHA COMMIT
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Коммит insightHash в AlphaAuditor on-chain.
     *
     * Flow:
     * 1. Rate limit check (общий пул с арбитражем)
     * 2. Gas price validation
     * 3. Encode calldata: AlphaAuditor.commitInsight(agentId, insightHash)
     * 4. Send UserOperation через Session Key → Private Bundler
     * 5. Await receipt (txHash)
     *
     * ИНВАРИАНТ: если этот метод не возвращает успешный txHash,
     * proposal НЕ ДОЛЖЕН быть опубликован в Redis.
     */
    async commitProofOfAlpha(insightHash: string): Promise<ProofOfAlphaCommitResult> {
        // ─── Step 0: Validate insightHash format ──────────────────────────
        if (!insightHash || !insightHash.startsWith("0x") || insightHash.length !== 66) {
            throw new Error(
                `INVARIANT: invalid insightHash format. Expected bytes32 hex, got: ${insightHash}`
            );
        }

        // ─── Step 1: Rate Limit Check ─────────────────────────────────────
        const rateCheck = this.rateLimiter.canSend();
        if (!rateCheck.allowed) {
            throw new Error(
                `[ProofOfAlpha] Rate limited: ${rateCheck.reason}. ` +
                `Retry after ${rateCheck.retryAfterMs}ms`
            );
        }

        const publicClient = createPublicClient({
            chain: mantle as Chain,
            transport: http(this.config.rpcUrl),
        });

        // ─── Step 2: Gas Price Validation ─────────────────────────────────
        const { baseFee, isAcceptable } = await this.validateGasPrice(publicClient);
        if (!isAcceptable) {
            throw new Error(
                `[ProofOfAlpha] Gas price too high: ${baseFee} wei. ` +
                `Network congestion or manipulation. Aborting commit.`
            );
        }

        // ─── Step 3: Encode calldata ──────────────────────────────────────
        const callData = encodeFunctionData({
            abi: ALPHA_AUDITOR_ABI,
            functionName: "commitInsight",
            args: [this.config.agentId, insightHash as `0x${string}`],
        });

        // ─── Step 4: Create Kernel Client ─────────────────────────────────
        const kernelClient = await this.createKernelClient(publicClient);

        // ─── Step 5: Send UserOperation ───────────────────────────────────
        console.log(`[ProofOfAlpha] Sending commitInsight UserOp...`);
        console.log(`  agentId: ${this.config.agentId}`);
        console.log(`  insightHash: ${insightHash}`);
        console.log(`  auditor: ${this.config.alphaAuditorAddress}`);

        const userOpHash = await kernelClient.sendUserOperation({
            callData: await kernelClient.account.encodeCalls([{
                to: this.config.alphaAuditorAddress,
                value: 0n,
                data: callData,
            }]),
        });

        // ─── Step 6: Wait for receipt ─────────────────────────────────────
        console.log(`[ProofOfAlpha] UserOp submitted: ${userOpHash}`);
        console.log(`[ProofOfAlpha] Waiting for on-chain confirmation...`);

        const receipt = await kernelClient.waitForUserOperationReceipt({
            hash: userOpHash,
            timeout: 30_000,
        });

        // ─── Step 7: Record result for rate limiting ──────────────────────
        this.rateLimiter.recordOp(receipt.success);

        if (!receipt.success) {
            throw new Error(
                `[ProofOfAlpha] UserOp reverted on-chain. ` +
                `txHash: ${receipt.receipt.transactionHash}. ` +
                `Possible causes: unauthorized agent, invalid hash, or contract paused.`
            );
        }

        const txHash = receipt.receipt.transactionHash;
        console.log(`[ProofOfAlpha] ✓ Committed on-chain. txHash: ${txHash}`);

        return {
            txHash,
            insightHash,
            agentId: this.config.agentId,
            success: true,
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //                    FLASH ARBITRAGE EXECUTION (PHASE 3: BYREAL)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Phase 3: Выполняет арбитражную операцию через Byreal OpenClaw.
     *
     * FLOW:
     * 1. Валидация gas price (отклонение при аномалии)
     * 2. ByrealClient.getQuote() — получить оптимальный CLMM маршрут
     * 3. ByrealClient.buildExecutionPayload() — собрать calldata
     * 4. Encode calldata для ActiveSentinel.executeFlashArbitrage
     * 5. Подписание и отправка через Bundler
     * 6. Ожидание receipt
     *
     * ИНВАРИАНТ: TEE-агент НЕ собирает calldata для DEX вручную.
     * Byreal отвечает за fee tiers, tick ranges, split routing.
     */
    async executeArbitrage(opportunity: ArbOpportunity): Promise<ArbExecutionResult> {
        // ─── Step 0: Rate Limit Check ────────────────────────────────
        const rateCheck = this.rateLimiter.canSend();
        if (!rateCheck.allowed) {
            throw new Error(
                `Rate limited: ${rateCheck.reason}. Retry after ${rateCheck.retryAfterMs}ms`
            );
        }

        const publicClient = createPublicClient({
            chain: mantle as Chain,
            transport: http(this.config.rpcUrl),
        });

        // ─── Step 1: Gas Price Validation ────────────────────────────
        const { baseFee, isAcceptable } = await this.validateGasPrice(publicClient);
        if (!isAcceptable) {
            throw new Error(
                `Gas price too high: ${baseFee} wei. ` +
                `Likely manipulation or network congestion. Aborting.`
            );
        }

        // ─── Step 2: Get Quote from Byreal OpenClaw ──────────────────
        console.log(
            `[Executor] Requesting Byreal quote: ` +
            `${opportunity.borrowToken.slice(0, 10)} → ${opportunity.targetToken.slice(0, 10)} ` +
            `amount=${opportunity.borrowAmount}`
        );

        const quote = await this.byrealClient.getQuote(
            opportunity.borrowToken,
            opportunity.targetToken,
            opportunity.borrowAmount
        );

        // Validate quote freshness
        if (!this.byrealClient.isQuoteValid(quote)) {
            throw new Error(
                `[Executor] Byreal quote expired: quoteId=${quote.quoteId}, ` +
                `expiresAt=${quote.expiresAt}`
            );
        }

        // Validate price impact threshold (reject if > 3%)
        if (quote.priceImpactBps > 300) {
            throw new Error(
                `[Executor] Price impact too high: ${quote.priceImpactBps} bps (max: 300). ` +
                `Route: ${quote.routes.map(r => r.protocol).join(" → ")}`
            );
        }

        console.log(
            `[Executor] Byreal quote received: quoteId=${quote.quoteId}, ` +
            `estimatedOut=${quote.estimatedAmountOut}, ` +
            `impact=${quote.priceImpactBps}bps, ` +
            `routes=${quote.routes.length}`
        );

        // ─── Step 3: Build Execution Payload ─────────────────────────
        const payload = await this.byrealClient.buildExecutionPayload(
            quote.quoteId,
            opportunity.slippageBps,
            this.config.activeSentinelAddress,
            opportunity.deadlineSeconds || 300
        );

        // ─── Step 4: Encode ActiveSentinel calldata ──────────────────
        const callData = encodeFunctionData({
            abi: ACTIVE_SENTINEL_ABI,
            functionName: "executeFlashArbitrage",
            args: [
                opportunity.borrowToken,       // borrowToken
                opportunity.borrowAmount,       // borrowAmount
                opportunity.minProfit,          // minProfit
                payload.to,                     // swapTarget (Byreal router)
                payload.data,                   // swapCalldata (from Byreal)
                BigInt(payload.deadline),        // deadline
            ],
        });

        // ─── Step 5: Create Kernel Client ────────────────────────────
        const kernelClient = await this.createKernelClient(publicClient);

        // ─── Step 6: Send UserOperation ──────────────────────────────
        console.log(
            `[Executor] Sending flash arb UserOp via Byreal route...`
        );

        const userOpHash = await kernelClient.sendUserOperation({
            callData: await kernelClient.account.encodeCalls([{
                to: this.config.activeSentinelAddress,
                value: 0n,
                data: callData,
            }]),
        });

        // ─── Step 7: Wait for receipt ────────────────────────────────
        const receipt = await kernelClient.waitForUserOperationReceipt({
            hash: userOpHash,
            timeout: 30_000,
        });

        // ─── Step 8: Record result for rate limiting ─────────────────
        this.rateLimiter.recordOp(receipt.success);

        if (receipt.success) {
            console.log(
                `[Executor] ✓ Arbitrage executed. txHash=${receipt.receipt.transactionHash}, ` +
                `quoteId=${quote.quoteId}`
            );
        } else {
            console.error(
                `[Executor] ✗ Arbitrage reverted. txHash=${receipt.receipt.transactionHash}`
            );
        }

        return {
            userOpHash,
            txHash: receipt.receipt.transactionHash,
            success: receipt.success,
            nonceKey: this.computeRouteNonceKey(quote).toString(16),
            quoteId: quote.quoteId,
            estimatedOutput: quote.estimatedAmountOut,
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //                    UTILITY & MONITORING
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Получить статус rate limiter + Byreal stats (для мониторинга / HITL dashboard).
     */
    getRateLimitStatus() {
        return {
            ...this.rateLimiter.getStatus(),
            auditorNonceKey: this.auditorNonceKey.toString(16),
            byrealStats: this.byrealClient.getStats(),
            bloomFilterStats: this.bloomFilter?.getStats() ?? null,
        };
    }

    /**
     * Принудительная разблокировка (вызывается оператором через Telegram HITL).
     */
    forceUnblock() {
        this.rateLimiter.forceUnblock();
    }

    /**
     * Batch execution: отправляет несколько арбитражных операций параллельно.
     * Каждая пара получает уникальный Byreal quote → уникальный nonce key.
     */
    async executeBatch(
        opportunities: ArbOpportunity[]
    ): Promise<Array<{ success: boolean; hash?: `0x${string}`; error?: string; quoteId?: string }>> {
        const results = await Promise.allSettled(
            opportunities.map((opp) => this.executeArbitrage(opp))
        );

        return results.map((result) => {
            if (result.status === "fulfilled") {
                return {
                    success: result.value.success,
                    hash: result.value.txHash,
                    quoteId: result.value.quoteId,
                };
            } else {
                return { success: false, error: result.reason?.message || "Unknown error" };
            }
        });
    }
}
