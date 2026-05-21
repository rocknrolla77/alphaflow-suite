// Файл: bff/src/rpcFallback.ts
// Multi-RPC Fallback Client для Mantle Network
// Решает: единая точка отказа при 429 Too Many Requests

import { createPublicClient, http, fallback, type PublicClient } from "viem";
import { defineChain } from "viem";

const mantle = defineChain({
    id: 5000,
    name: "Mantle",
    nativeCurrency: { name: "MNT", symbol: "MNT", decimals: 18 },
    rpcUrls: {
        default: { http: ["https://rpc.mantle.xyz"] },
    },
    blockExplorers: {
        default: { name: "MantleScan", url: "https://mantlescan.xyz" },
    },
});

export interface RpcConfig {
    /** Primary RPC (self-hosted or paid tier) */
    primary: string;
    /** Fallback RPCs in priority order */
    fallbacks: string[];
    /** Timeout per RPC (ms) */
    timeout?: number;
    /** Retry count per RPC before failover */
    retryCount?: number;
}

/**
 * Создает PublicClient с fallback-массивом RPC-провайдеров.
 *
 * Стратегия:
 * 1. Primary (private/paid RPC — no rate limits)
 * 2. Fallback 1 (Alchemy Mantle endpoint)
 * 3. Fallback 2 (Infura/Ankr)
 * 4. Fallback 3 (Public RPC — last resort)
 *
 * При 429/timeout → автоматическое переключение.
 * rank: true → viem отслеживает latency и переранжирует.
 */
export function createFallbackClient(config: RpcConfig): PublicClient {
    const timeout = config.timeout || 10_000;
    const retryCount = config.retryCount || 2;

    const transports = [
        http(config.primary, {
            timeout,
            retryCount,
            retryDelay: 500,
        }),
        ...config.fallbacks.map((url) =>
            http(url, {
                timeout: timeout + 5000, // Fallbacks get extra time
                retryCount: 1,
                retryDelay: 1000,
            })
        ),
    ];

    return createPublicClient({
        chain: mantle,
        transport: fallback(transports, {
            rank: true, // Auto-rank by latency
            retryCount: 1,
        }),
    }) as PublicClient;
}

/**
 * Default RPC config from environment variables.
 *
 * Env vars:
 *   MANTLE_RPC_PRIMARY=https://mantle-mainnet.g.alchemy.com/v2/KEY
 *   MANTLE_RPC_FALLBACKS=https://rpc.mantle.xyz,https://rpc.ankr.com/mantle
 */
export function getRpcConfigFromEnv(): RpcConfig {
    const primary = process.env.MANTLE_RPC_PRIMARY || process.env.MANTLE_RPC_URL || "https://rpc.mantle.xyz";
    const fallbacksRaw = process.env.MANTLE_RPC_FALLBACKS || "https://rpc.mantle.xyz,https://rpc.ankr.com/mantle";
    const fallbacks = fallbacksRaw.split(",").map((s) => s.trim()).filter(Boolean);

    return {
        primary,
        fallbacks,
        timeout: parseInt(process.env.RPC_TIMEOUT_MS || "10000"),
        retryCount: parseInt(process.env.RPC_RETRY_COUNT || "2"),
    };
}
