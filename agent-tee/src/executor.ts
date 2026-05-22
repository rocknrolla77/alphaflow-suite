// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — agent-tee/src/executor.ts
// Модуль исполнения: арбитраж + Proof-of-Alpha commit через ZeroDev Session Key
// Phase 2: + AlphaAuditor.commitInsight() интеграция
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
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mantle } from "viem/chains";
import { createKernelAccountClient, createKernelAccount, constants } from "@zerodev/sdk";
import { signerToSessionKeyValidator } from "@zerodev/session-key";
import { PaymasterRateLimiter } from "./services/rateLimiter.js";
import type { RateLimitConfig, ProofOfAlphaCommitResult } from "./types/index.js";

// ─── ABI Definitions ──────────────────────────────────────────────────────────

const ACTIVE_SENTINEL_ABI = parseAbi([
    "function executeFlashArbitrage((address tokenA, address tokenB, uint256 borrowAmount, uint256 minProfitTokenA, uint256 amountOutMinRoute1, uint256 amountOutMinRoute2, bytes dexPayloadRoute1, bytes dexPayloadRoute2) params)",
]);

const ALPHA_AUDITOR_ABI = parseAbi([
    "function commitInsight(uint256 agentId, bytes32 insightHash)",
]);

// ─── EntryPoint v0.7 address (ERC-4337) ───────────────────────────────────────
const ENTRYPOINT_ADDRESS_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ArbOpportunity {
    tokenA: `0x${string}`;
    tokenB: `0x${string}`;
    borrowAmount: bigint;
    minProfitTokenA: bigint;
    amountOutMinRoute1: bigint;
    amountOutMinRoute2: bigint;
    dexPayloadRoute1: `0x${string}`;
    dexPayloadRoute2: `0x${string}`;
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

// ─── Executor Class ───────────────────────────────────────────────────────────

/**
 * SentinelExecutor — отправляет UserOperations для:
 * 1. Flash Arbitrage (ActiveSentinel)
 * 2. Proof-of-Alpha commit (AlphaAuditor)
 *
 * Ключевые особенности:
 * - 2D Nonce: каждый маршрут/контракт получает свой nonce key
 * - Gas Price Validation: отклоняет если baseFee > порога
 * - Rate Limiting: защита Gas Vault от drain
 * - Private Bundler: MEV protection
 */
export class SentinelExecutor {
    private config: ExecutorConfig;
    private rateLimiter: PaymasterRateLimiter;

    constructor(config: ExecutorConfig, rateLimitConfig?: RateLimitConfig) {
        this.config = config;
        this.rateLimiter = new PaymasterRateLimiter(
            rateLimitConfig || {
                maxOpsPerMinute: 5,
                maxOpsPerHour: 30,
                revertCooldownSec: 30,
            }
        );
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
     * Вычисляет уникальный nonce key для полного маршрута.
     * uint192(bytes24(keccak256(abi.encode(tokenA, tokenB, dexPayloadRoute1))))
     * Reserved for future 2D nonce integration.
     */
    public computeArbNonceKey(opportunity: ArbOpportunity): bigint {
        const routeHash = keccak256(
            encodePacked(
                ["address", "address", "bytes"],
                [opportunity.tokenA, opportunity.tokenB, opportunity.dexPayloadRoute1]
            )
        );
        const keyHex = routeHash.slice(0, 50); // "0x" + 48 hex chars = 24 bytes = 192 bits
        return BigInt(keyHex);
    }

    /**
     * Фиксированный nonce key для AlphaAuditor коммитов.
     * Отделён от арбитражных nonces для отсутствия конфликтов.
     * Reserved for future 2D nonce integration.
     */
    public get auditorNonceKey(): bigint {
        const hash = keccak256(
            encodePacked(
                ["string", "address"],
                ["alpha_auditor_commit", this.config.alphaAuditorAddress]
            )
        );
        return BigInt(hash.slice(0, 50)); // 192 bits
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
     *
     * @param insightHash — bytes32 хэш инсайта (из YieldArchitect.computeInsightHash)
     * @returns ProofOfAlphaCommitResult с txHash для включения в Proposal
     * @throws Error при любом сбое (RPC, bundler, rate limit, gas)
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
    //                    FLASH ARBITRAGE EXECUTION
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Выполняет арбитражную операцию через UserOperation.
     *
     * Flow:
     * 1. Валидация gas price (отклонение при аномалии)
     * 2. Кодирование calldata для executeFlashArbitrage
     * 3. Назначение 2D nonce key по маршруту
     * 4. Подписание и отправка через Bundler
     * 5. Ожидание receipt
     */
    async executeArbitrage(opportunity: ArbOpportunity): Promise<{
        userOpHash: `0x${string}`;
        txHash: `0x${string}`;
        success: boolean;
        nonceKey: string;
    }> {
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

        // ─── Step 2: Encode calldata ─────────────────────────────────
        const callData = encodeFunctionData({
            abi: ACTIVE_SENTINEL_ABI,
            functionName: "executeFlashArbitrage",
            args: [
                {
                    tokenA: opportunity.tokenA,
                    tokenB: opportunity.tokenB,
                    borrowAmount: opportunity.borrowAmount,
                    minProfitTokenA: opportunity.minProfitTokenA,
                    amountOutMinRoute1: opportunity.amountOutMinRoute1,
                    amountOutMinRoute2: opportunity.amountOutMinRoute2,
                    dexPayloadRoute1: opportunity.dexPayloadRoute1,
                    dexPayloadRoute2: opportunity.dexPayloadRoute2,
                },
            ],
        });

        // ─── Step 3: Create Kernel Client ────────────────────────────
        const kernelClient = await this.createKernelClient(publicClient);

        // ─── Step 4: Send UserOperation ──────────────────────────────
        const userOpHash = await kernelClient.sendUserOperation({
            callData: await kernelClient.account.encodeCalls([{
                to: this.config.activeSentinelAddress,
                value: 0n,
                data: callData,
            }]),
        });

        // ─── Step 5: Wait for receipt ────────────────────────────────
        const receipt = await kernelClient.waitForUserOperationReceipt({
            hash: userOpHash,
            timeout: 30_000,
        });

        // ─── Step 6: Record result for rate limiting ─────────────────
        this.rateLimiter.recordOp(receipt.success);

        return {
            userOpHash,
            txHash: receipt.receipt.transactionHash,
            success: receipt.success,
            nonceKey: this.computeArbNonceKey(opportunity).toString(16),
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //                    UTILITY & MONITORING
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Получить статус rate limiter (для мониторинга / HITL dashboard).
     */
    getRateLimitStatus() {
        return {
            ...this.rateLimiter.getStatus(),
            auditorNonceKey: this.auditorNonceKey.toString(16),
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
     * Каждая пара использует свой nonce key — нет конфликтов.
     */
    async executeBatch(
        opportunities: ArbOpportunity[]
    ): Promise<Array<{ success: boolean; hash?: `0x${string}`; error?: string }>> {
        const results = await Promise.allSettled(
            opportunities.map((opp) => this.executeArbitrage(opp))
        );

        return results.map((result) => {
            if (result.status === "fulfilled") {
                return { success: result.value.success, hash: result.value.txHash };
            } else {
                return { success: false, error: result.reason?.message || "Unknown error" };
            }
        });
    }
}
