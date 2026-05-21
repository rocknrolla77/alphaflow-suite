// Файл: agent-tee/src/services/mevProtection.ts
// MEV Protection — маршрутизация UserOps через приватные bundler endpoints
// Защита от sandwich attacks на Mantle Network

/**
 * MEV Protection Strategy для Mantle Network:
 *
 * Проблема: Публичный мемпул Mantle (как и любой EVM-чейн) позволяет
 * MEV-ботам видеть pending транзакции и строить sandwich attacks.
 * Для flash arbitrage это катастрофа — бот может front-run наш арбитраж.
 *
 * Решение: Отправка UserOps через приватные bundler endpoints,
 * которые НЕ транслируют в публичный мемпул.
 *
 * Порядок приоритета:
 * 1. Flashbots Protect (если поддерживается на Mantle)
 * 2. Pimlico Private Bundler (ERC-4337 native)
 * 3. Alchemy Private Bundler
 * 4. Public bundler (fallback, vulnerable)
 */

export interface MevConfig {
    /** Private bundler endpoint (primary) */
    privateBundlerUrl: string;
    /** Fallback bundler endpoints */
    fallbackBundlers: string[];
    /** Max priority fee to prevent overbidding */
    maxPriorityFeeGwei: number;
    /** Enable private mempool routing */
    usePrivateMempool: boolean;
}

export class MevProtectionService {
    private config: MevConfig;

    constructor(config: MevConfig) {
        this.config = config;
    }

    /**
     * Выбирает оптимальный bundler endpoint.
     * В случае недоступности приватного — переключается на fallback.
     */
    async selectBundler(): Promise<string> {
        if (!this.config.usePrivateMempool) {
            return this.config.privateBundlerUrl;
        }

        // Check primary bundler health
        try {
            const res = await fetch(this.config.privateBundlerUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    method: "eth_supportedEntryPoints",
                    params: [],
                    id: 1,
                }),
                signal: AbortSignal.timeout(3000),
            });

            if (res.ok) return this.config.privateBundlerUrl;
        } catch {
            console.warn("[MEV] Primary bundler unavailable, trying fallbacks...");
        }

        // Try fallbacks
        for (const url of this.config.fallbackBundlers) {
            try {
                const res = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        jsonrpc: "2.0",
                        method: "eth_supportedEntryPoints",
                        params: [],
                        id: 1,
                    }),
                    signal: AbortSignal.timeout(3000),
                });
                if (res.ok) return url;
            } catch {
                continue;
            }
        }

        throw new Error("[MEV] All bundlers unavailable");
    }

    /**
     * Проверяет, не превышает ли priority fee разумный порог.
     * Защита от gas price manipulation (MEV bot inflating gas).
     */
    validateGasPrice(maxFeePerGas: bigint, maxPriorityFeePerGas: bigint): boolean {
        const maxPriorityWei = BigInt(this.config.maxPriorityFeeGwei) * 10n ** 9n;
        return maxPriorityFeePerGas <= maxPriorityWei;
    }
}

export function getDefaultMevConfig(): MevConfig {
    return {
        privateBundlerUrl: process.env.PRIVATE_BUNDLER_URL || "https://api.pimlico.io/v2/5000/rpc",
        fallbackBundlers: [
            process.env.ALCHEMY_BUNDLER_URL || "https://mantle-mainnet.g.alchemy.com/v2/bundler",
            "https://bundler.mantle.xyz", // Public fallback (last resort)
        ],
        maxPriorityFeeGwei: 5, // Refuse to pay > 5 gwei priority
        usePrivateMempool: true,
    };
}
