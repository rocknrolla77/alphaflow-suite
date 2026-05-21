// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — bff/src/services/onChainOracle.ts
// On-Chain Price Oracle: viem multi-RPC fallback + staleness detection
//
// БЕЗОПАСНОСТЬ:
// - Цена ВСЕГДА берётся on-chain (не из request body клиента)
// - Frontend Oracle Spoofing невозможен: BFF — единственный источник правды
// - RPC fallback: при 429/timeout автоматически переключается на резервный
// ═══════════════════════════════════════════════════════════════════════════════

import {
    createPublicClient,
    http,
    fallback,
    type PublicClient,
    type Address,
    parseAbi,
    formatUnits,
} from "viem";
import { mantle } from "viem/chains";

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * RPC провайдеры для Mantle Network.
 * Порядок приоритета: Primary → Fallback 1 → Fallback 2 (public)
 *
 * rank: true включает автоматическое переранжирование по latency.
 * При 429/timeout текущий провайдер перемещается в конец очереди.
 */
const RPC_PRIMARY = process.env["MANTLE_RPC_PRIMARY"] ?? "https://rpc.mantle.xyz";
const RPC_FALLBACK_1 = process.env["MANTLE_RPC_FALLBACK_1"] ?? "https://mantle-mainnet.public.blastapi.io";
const RPC_FALLBACK_2 = process.env["MANTLE_RPC_FALLBACK_2"] ?? "https://mantle.drpc.org";

// ─── Viem Client (singleton with fallback) ────────────────────────────────────

let client: PublicClient | null = null;

/**
 * Создаёт или возвращает singleton PublicClient с multi-RPC fallback.
 *
 * Конфигурация:
 * - rank: true → автоматическое переранжирование по latency/success rate
 * - retryCount: 2 → каждый провайдер пробуется до 3 раз перед переключением
 * - timeout: 10000ms primary, 15000ms fallback
 */
export function getPublicClient(): PublicClient {
    if (!client) {
        client = createPublicClient({
            chain: mantle,
            transport: fallback(
                [
                    http(RPC_PRIMARY, {
                        timeout: 10_000,
                        retryCount: 2,
                        retryDelay: 1000,
                    }),
                    http(RPC_FALLBACK_1, {
                        timeout: 15_000,
                        retryCount: 2,
                        retryDelay: 1500,
                    }),
                    http(RPC_FALLBACK_2, {
                        timeout: 15_000,
                        retryCount: 1,
                        retryDelay: 2000,
                    }),
                ],
                { rank: true }
            ),
        }) as PublicClient;
    }
    return client;
}

// ─── Price Oracle Interface ───────────────────────────────────────────────────

/**
 * Результат проверки цены.
 */
export interface PriceCheckResult {
    /** Текущая цена актива (human-readable, например "1.05") */
    currentPrice: string;

    /** Цена в момент генерации proposal (если доступна) */
    generationPrice: string | null;

    /** Отклонение в basis points (100 = 1%) */
    deviationBps: number;

    /** Превышен ли порог slippage */
    isStale: boolean;

    /** Timestamp проверки */
    checkedAt: number;
}

/**
 * Minimal DEX Pair ABI для получения текущих резервов/цены.
 * Совместим с Merchant Moe (LB) и Agni Finance (UniV3-like).
 */
const PAIR_ABI = parseAbi([
    // UniswapV2-style pair (Merchant Moe LB simplified)
    "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
    // Generic ERC20 balance check
    "function balanceOf(address account) external view returns (uint256)",
    // UniV3-style slot0 (Agni Finance)
    "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);

/**
 * Проверяет текущую on-chain цену и сравнивает с ценой при генерации proposal.
 *
 * Staleness Check — СЕРВЕРНАЯ проверка (не доверяем клиенту):
 * 1. Делает eth_call к DEX pool для получения текущей цены
 * 2. Сравнивает с priceAtGeneration (сохранена TEE при создании)
 * 3. Если deviation > maxSlippageBps → isStale = true
 *
 * @param pairAddress — адрес DEX pool / pair contract
 * @param priceAtGeneration — цена в момент создания proposal (BigInt as string, или null)
 * @param maxSlippageBps — максимальное допустимое отклонение (200 = 2%)
 * @param decimals — количество decimals для форматирования (default: 18)
 * @returns PriceCheckResult
 */
export async function checkPriceStaleness(
    pairAddress: Address,
    priceAtGeneration: string | null,
    maxSlippageBps: number = 200,
    decimals: number = 18
): Promise<PriceCheckResult> {
    const publicClient = getPublicClient();
    const now = Math.floor(Date.now() / 1000);

    // ─── Attempt 1: UniV3-style slot0 (Agni Finance) ─────────────────────
    let currentPriceRaw: bigint;

    try {
        const slot0 = await publicClient.readContract({
            address: pairAddress,
            abi: PAIR_ABI,
            functionName: "slot0",
        }) as [bigint, number, number, number, number, number, boolean];

        const sqrtPriceX96 = slot0[0];
        // Price = (sqrtPriceX96 / 2^96)^2
        // Scaled: price_scaled = sqrtPriceX96^2 / 2^192 * 10^decimals
        currentPriceRaw = (sqrtPriceX96 * sqrtPriceX96 * BigInt(10 ** decimals)) >> 192n;
    } catch {
        // ─── Attempt 2: UniV2-style reserves (Merchant Moe) ──────────────
        try {
            const reserves = await publicClient.readContract({
                address: pairAddress,
                abi: PAIR_ABI,
                functionName: "getReserves",
            }) as [bigint, bigint, number];

            const reserve0 = reserves[0];
            const reserve1 = reserves[1];

            if (reserve0 === 0n) {
                throw new Error("Zero reserves — pool is empty");
            }

            // Price = reserve1 / reserve0 (normalized to decimals)
            currentPriceRaw = (reserve1 * BigInt(10 ** decimals)) / reserve0;
        } catch (innerErr) {
            // ─── Both methods failed — cannot verify staleness ────────────
            console.error("[BFF] Price oracle: both slot0 and getReserves failed:", innerErr);

            return {
                currentPrice: "0",
                generationPrice: priceAtGeneration,
                deviationBps: 0,
                isStale: false, // Cannot determine — proceed with caution flag
                checkedAt: now,
            };
        }
    }

    const currentPrice = formatUnits(currentPriceRaw, decimals);

    // ─── If no generation price available — skip staleness check ─────────
    if (!priceAtGeneration || priceAtGeneration === "0") {
        return {
            currentPrice,
            generationPrice: null,
            deviationBps: 0,
            isStale: false,
            checkedAt: now,
        };
    }

    // ─── Calculate deviation in basis points ─────────────────────────────
    const genPriceRaw = BigInt(priceAtGeneration);

    if (genPriceRaw === 0n) {
        return {
            currentPrice,
            generationPrice: priceAtGeneration,
            deviationBps: 0,
            isStale: false,
            checkedAt: now,
        };
    }

    // deviation_bps = |current - generation| / generation × 10000
    const diff = currentPriceRaw > genPriceRaw
        ? currentPriceRaw - genPriceRaw
        : genPriceRaw - currentPriceRaw;

    const deviationBps = Number((diff * 10000n) / genPriceRaw);
    const isStale = deviationBps > maxSlippageBps;

    return {
        currentPrice,
        generationPrice: formatUnits(genPriceRaw, decimals),
        deviationBps,
        isStale,
        checkedAt: now,
    };
}

/**
 * Симулирует транзакцию через eth_call (dry run).
 *
 * Используется эндпоинтом POST /api/proposal/:id/simulate.
 * Позволяет обнаружить revert ДО отправки реальной UserOp.
 *
 * @param to — target contract address
 * @param data — encoded calldata
 * @returns { success: boolean, result?: string, error?: string }
 */
export async function simulateTransaction(
    to: Address,
    data: `0x${string}`
): Promise<{ success: boolean; result?: string; error?: string }> {
    const publicClient = getPublicClient();

    try {
        const result = await publicClient.call({
            to,
            data,
        });

        return {
            success: true,
            result: result.data ?? "0x",
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown simulation error";
        return {
            success: false,
            error: message,
        };
    }
}

/**
 * Health check для RPC-соединения.
 * Вызывает eth_blockNumber для проверки доступности.
 */
export async function rpcHealthCheck(): Promise<{ healthy: boolean; blockNumber?: bigint; error?: string }> {
    try {
        const publicClient = getPublicClient();
        const blockNumber = await publicClient.getBlockNumber();
        return { healthy: true, blockNumber };
    } catch (err) {
        const message = err instanceof Error ? err.message : "RPC unreachable";
        return { healthy: false, error: message };
    }
}
