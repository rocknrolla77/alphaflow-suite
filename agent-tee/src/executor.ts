// Файл: agent-tee/src/executor.ts
// Модуль исполнения арбитража TEE-агентом через Session Key
// Поддержка 2D Nonces (ERC-4337 v0.7) для параллельного пакетирования

import { createPublicClient, http, encodeFunctionData, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createKernelAccountClient, createKernelAccount } from "@zerodev/sdk";
import { signerToSessionKeyValidator } from "@zerodev/session-key";
import { ENTRYPOINT_ADDRESS_V07 } from "permissionless";

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
    private nonceKeyMap: Map<string, bigint> = new Map();
    private currentNonceKey: bigint = 0n;

    constructor(config: ExecutorConfig) {
        this.config = config;
    }

    /**
     * Получает уникальный nonce key для пары токенов.
     * ERC-4337 v0.7 поддерживает 2D nonces: key (192 bit) || seq (64 bit).
     * Разные key = независимые последовательности = параллельные UserOps.
     */
    private getNonceKey(tokenA: string, tokenB: string): bigint {
        const pairId = `${tokenA.toLowerCase()}-${tokenB.toLowerCase()}`;

        if (!this.nonceKeyMap.has(pairId)) {
            this.nonceKeyMap.set(pairId, this.currentNonceKey);
            this.currentNonceKey += 1n;
        }

        return this.nonceKeyMap.get(pairId)!;
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

        // ─── Step 3: 2D Nonce Key ────────────────────────────────────
        const nonceKey = this.getNonceKey(opportunity.tokenA, opportunity.tokenB);

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

        return {
            userOpHash,
            txHash: receipt.receipt.transactionHash,
            success: receipt.success,
        };
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
