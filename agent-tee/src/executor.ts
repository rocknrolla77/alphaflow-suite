// Файл: agent-tee/src/executor.ts
// Модуль исполнения арбитража TEE-агентом через Session Key
// Поддержка 2D Nonces (ERC-4337 v0.7) для параллельного пакетирования

import { createPublicClient, http, encodeFunctionData, parseAbi, keccak256, encodePacked } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createKernelAccountClient, createKernelAccount } from "@zerodev/sdk";
import { signerToSessionKeyValidator } from "@zerodev/session-key";
import { ENTRYPOINT_ADDRESS_V07 } from "permissionless";
import { PaymasterRateLimiter } from "./services/rateLimiter";
import type { RateLimitConfig } from "./types";

// ABI для кодирования вызовов
const ACTIVE_SENTINEL_ABI = parseAbi([
    "function executeFlashArbitrage((address tokenA, address tokenB, uint256 borrowAmount, uint256 minProfitTokenA, uint256 amountOutMinRoute1, uint256 amountOutMinRoute2, bytes dexPayloadRoute1, bytes dexPayloadRoute2) params)",
]);

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
    bundlerUrl: string;
    rpcUrl: string;
    chainId: number;
}

/**
 * TEE Executor — отправляет арбитражные UserOperations.
 *
 * Ключевые особенности:
 * 1. 2D Nonce: каждая пара токенов получает свой nonce key,
 *    позволяя параллельные UserOps для разных пар без конфликтов.
 * 2. Gas Price Validation: отклоняет отправку если baseFee > порога
 * 3. Profit Verification: двойная проверка (off-chain + on-chain invariant)
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

    /**
     * Вычисляет уникальный nonce key для полного маршрута.
     *
     * ИСПРАВЛЕНО: Ранее использовалась пара tokenA/tokenB, что вызывало коллизию
     * при одинаковом стартовом активе (USDC→WMNT vs USDC→FBTC получали одинаковый key).
     *
     * Теперь: uint192(bytes24(keccak256(abi.encode(tokenA, tokenB, dexPayloadRoute1))))
     * Это гарантирует уникальность для каждого полного маршрута.
     */
    private computeNonceKey(opportunity: ArbOpportunity): bigint {
        const routeHash = keccak256(
            encodePacked(
                ["address", "address", "bytes"],
                [opportunity.tokenA, opportunity.tokenB, opportunity.dexPayloadRoute1]
            )
        );
        // Берём первые 24 байта (192 бита) хеша как nonce key
        const keyHex = routeHash.slice(0, 50); // "0x" + 48 hex chars = 24 bytes
        return BigInt(keyHex);
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
     * Выполняет арбитражную операцию через UserOperation.
     *
     * Flow:
     * 1. Валидация gas price (отклонение при аномалии)
     * 2. Кодирование calldata для executeFlashArbitrage
     * 3. Назначение 2D nonce key по паре токенов
     * 4. Подписание и отправка через Bundler
     * 5. Ожидание receipt
     */
    async executeArbitrage(opportunity: ArbOpportunity): Promise<{
        userOpHash: `0x${string}`;
        txHash: `0x${string}`;
        success: boolean;
    }> {
        // ─── Step 0: Rate Limit Check ────────────────────────────────
        const rateCheck = this.rateLimiter.canSend();
        if (!rateCheck.allowed) {
            throw new Error(
                `Rate limited: ${rateCheck.reason}. Retry after ${rateCheck.retryAfterMs}ms`
            );
        }

        const publicClient = createPublicClient({
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

        // ─── Step 3: 2D Nonce Key (route-based, collision-resistant) ─
        const nonceKey = this.computeNonceKey(opportunity);

        // ─── Step 4: Create Kernel Client & Send UserOp ──────────────
        const sessionSigner = privateKeyToAccount(this.config.sessionPrivateKey);

        const sessionKeyValidator = await signerToSessionKeyValidator(publicClient, {
            signer: sessionSigner,
            entryPoint: ENTRYPOINT_ADDRESS_V07,
            validatorData: { permissions: [] },
        });

        const kernelAccount = await createKernelAccount(publicClient, {
            entryPoint: ENTRYPOINT_ADDRESS_V07,
            address: this.config.kernelAddress,
            plugins: { regular: sessionKeyValidator },
        });

        const kernelClient = createKernelAccountClient({
            account: kernelAccount,
            entryPoint: ENTRYPOINT_ADDRESS_V07,
            bundlerTransport: http(this.config.bundlerUrl),
            middleware: {
                // Gas estimation с safety margin
                gasPrice: async () => ({
                    maxFeePerGas: baseFee * 2n, // 2x baseFee buffer
                    maxPriorityFeePerGas: baseFee / 10n, // 10% tip
                }),
            },
        });

        // ─── Step 5: Send UserOperation ──────────────────────────────
        const userOpHash = await kernelClient.sendUserOperation({
            userOperation: {
                callData,
                // 2D nonce: nonceKey сдвинут на 64 бита влево
                nonce: nonceKey << 64n,
            },
        });

        // ─── Step 6: Wait for receipt ────────────────────────────────
        const receipt = await kernelClient.waitForUserOperationReceipt({
            hash: userOpHash,
            timeout: 30_000, // 30 seconds
        });

        // ─── Step 7: Record result for rate limiting ─────────────────
        this.rateLimiter.recordOp(receipt.success);

        return {
            userOpHash,
            txHash: receipt.receipt.transactionHash,
            success: receipt.success,
        };
    }

    /**
     * Получить статус rate limiter (для мониторинга / HITL dashboard).
     */
    getRateLimitStatus() {
        return this.rateLimiter.getStatus();
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
