// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — agent-tee/src/strategies/clusteringEngine.ts
// Phase 4: Heuristic Clustering Engine — автоматическое расширение watchlist
//
// АЛГОРИТМ:
//   На каждом polling tick:
//   1. Получаем список watched_wallets из Redis
//   2. Для каждого: запрашиваем последние outgoing transfers через RPC/MCP
//   3. Применяем правила:
//      Rule 1 — Direct Transfer >$50k WMNT/USDC → автодобавление получателя
//      Rule 2 — Gas Funding (первый tx нового адреса) → автодобавление получателя
//   4. Новые адреса записываются в DynamicWatchlist (Redis)
//
// БЕЗОПАСНОСТЬ:
//   - Rate limiting: max N адресов за epoch (предотвращает взрывной рост)
//   - Capacity cap: max 10,000 адресов в watchlist
//   - Deduplication: SADD идемпотентен
//   - Audit trail: каждое добавление логируется с reason + txHash
//
// RPC ЗАВИСИМОСТИ:
//   - eth_getBlockByNumber (latest)
//   - eth_getLogs (Transfer events)
//   - eth_getTransactionCount (для Rule 2 — nonce check)
//   - Nansen MCP (опционально, для обогащения тегами)
// ═══════════════════════════════════════════════════════════════════════════════

import { createPublicClient, fallback, http, parseAbiItem, type Address, type Hex } from "viem";
import { mantle } from "viem/chains";
import { DynamicWatchlist } from "../services/dynamicWatchlist.js";

// ─── Configuration ────────────────────────────────────────────────────────────

export interface ClusteringEngineConfig {
    /** RPC URL (primary) */
    rpcUrl: string;
    /** Fallback RPC URLs */
    rpcFallbacks: string[];
    /** Минимальная сумма перевода в USD для Rule 1 */
    minTransferThresholdUsd: number;
    /** Количество блоков назад для сканирования Transfer events */
    lookbackBlocks: number;
    /** Токены для мониторинга (address → symbol + decimals + priceUsd) */
    monitoredTokens: MonitoredToken[];
    /** Включить Rule 2 (gas funding detection) */
    enableGasFundingRule: boolean;
    /** Максимум новых адресов за один tick */
    maxDiscoveriesPerTick: number;
}

export interface MonitoredToken {
    address: Address;
    symbol: string;
    decimals: number;
    /** Приблизительная цена в USD (обновляется из oracle / hardcode для stablecoins) */
    priceUsd: number;
}

/** Результат одного tick-а clustering engine */
export interface ClusteringTickResult {
    /** Количество проанализированных transfer events */
    transfersAnalyzed: number;
    /** Количество новых адресов, добавленных по Rule 1 */
    addedByTransfer: number;
    /** Количество новых адресов, добавленных по Rule 2 */
    addedByGasFunding: number;
    /** Количество пропущенных (rate limit / capacity) */
    skipped: number;
    /** Время выполнения tick-а (ms) */
    durationMs: number;
}

// ─── ERC-20 Transfer Event ABI ────────────────────────────────────────────────

const TRANSFER_EVENT = parseAbiItem(
    "event Transfer(address indexed from, address indexed to, uint256 value)"
);

// ─── Default Config ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ClusteringEngineConfig = {
    rpcUrl: "https://rpc.mantle.xyz",
    rpcFallbacks: [
        "https://rpc.ankr.com/mantle",
        "https://mantle.public-rpc.com",
    ],
    minTransferThresholdUsd: 50_000,
    lookbackBlocks: 100,  // ~200 секунд на Mantle (2s blocks)
    monitoredTokens: [
        {
            address: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8" as Address, // WMNT
            symbol: "WMNT",
            decimals: 18,
            priceUsd: 0.75, // Обновляется из on-chain oracle в production
        },
        {
            address: "0x09Bc4E0D10C5E81aFb4473028e6eC5F35E7B126e" as Address, // USDC on Mantle
            symbol: "USDC",
            decimals: 6,
            priceUsd: 1.0,
        },
    ],
    enableGasFundingRule: true,
    maxDiscoveriesPerTick: 20,
};

// ═══════════════════════════════════════════════════════════════════════════════
//                          ClusteringEngine CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class ClusteringEngine {
    private readonly watchlist: DynamicWatchlist;
    private readonly config: ClusteringEngineConfig;
    private readonly publicClient: ReturnType<typeof createPublicClient>;

    /** Кэш проверенных nonce (address → nonce), живёт один tick */
    private nonceCache: Map<string, number> = new Map();

    constructor(watchlist: DynamicWatchlist, config?: Partial<ClusteringEngineConfig>) {
        this.watchlist = watchlist;
        this.config = { ...DEFAULT_CONFIG, ...config };

        // ─── Viem Public Client с fallback RPC ────────────────────────────────
        const transports = [
            http(this.config.rpcUrl),
            ...this.config.rpcFallbacks.map((url) => http(url)),
        ];

        this.publicClient = createPublicClient({
            chain: mantle,
            transport: fallback(transports, { rank: false }),
        });
    }

    // ─── Main Tick ────────────────────────────────────────────────────────────

    /**
     * Выполняет один цикл кластеризации.
     *
     * Flow:
     * 1. Получает текущий watchlist из Redis
     * 2. Определяет диапазон блоков для сканирования
     * 3. Для каждого monitored token: запрашивает Transfer events от watched wallets
     * 4. Применяет Rule 1 (Direct Transfer >$50k)
     * 5. Применяет Rule 2 (Gas Funding) — если включено
     * 6. Возвращает статистику
     */
    async runTick(): Promise<ClusteringTickResult> {
        const startTime = Date.now();
        let transfersAnalyzed = 0;
        let addedByTransfer = 0;
        let addedByGasFunding = 0;
        let skipped = 0;
        let totalDiscoveries = 0;

        // Очищаем nonce cache на каждом tick
        this.nonceCache.clear();

        console.log(`[ClusteringEngine] ═══ Tick started ═══`);

        // ─── 1. Get current watchlist ─────────────────────────────────────
        const watchedWallets = await this.watchlist.getWatchedWalletsArray();
        if (watchedWallets.length === 0) {
            console.log("[ClusteringEngine] Watchlist is empty — nothing to analyze.");
            return { transfersAnalyzed: 0, addedByTransfer: 0, addedByGasFunding: 0, skipped: 0, durationMs: Date.now() - startTime };
        }

        console.log(`[ClusteringEngine] Watching ${watchedWallets.length} wallets`);

        // ─── 2. Determine block range ─────────────────────────────────────
        const latestBlock = await this.publicClient.getBlockNumber();
        const fromBlock = latestBlock - BigInt(this.config.lookbackBlocks);

        console.log(
            `[ClusteringEngine] Scanning blocks ${fromBlock}..${latestBlock} ` +
            `(${this.config.lookbackBlocks} blocks lookback)`
        );

        // ─── 3. Scan Transfer events for each monitored token ─────────────
        for (const token of this.config.monitoredTokens) {
            if (totalDiscoveries >= this.config.maxDiscoveriesPerTick) break;

            console.log(
                `[ClusteringEngine] Scanning ${token.symbol} transfers from watched wallets...`
            );

            // Запрашиваем Transfer events где from ∈ watchedWallets
            // Для оптимизации: batch по 20 адресов (RPC topic filter limit)
            const batches = chunkArray(watchedWallets, 20);

            for (const batch of batches) {
                if (totalDiscoveries >= this.config.maxDiscoveriesPerTick) break;

                try {
                    const logs = await this.publicClient.getLogs({
                        address: token.address,
                        event: TRANSFER_EVENT,
                        args: {
                            from: batch as Address[],
                        },
                        fromBlock,
                        toBlock: latestBlock,
                    });

                    transfersAnalyzed += logs.length;

                    // ─── Rule 1: Direct Transfer ──────────────────────────
                    for (const log of logs) {
                        if (totalDiscoveries >= this.config.maxDiscoveriesPerTick) break;

                        const from = (log.args.from as string).toLowerCase();
                        const to = (log.args.to as string).toLowerCase();
                        const value = log.args.value as bigint;

                        // Пропускаем если получатель уже в watchlist
                        if (await this.watchlist.isWatched(to)) continue;

                        // Пропускаем transfers на known контракты (DEX routers, etc.)
                        if (await this.isKnownContract(to)) continue;

                        // Вычисляем USD эквивалент
                        const amountUsd = this.computeUsdValue(value, token);

                        if (amountUsd >= this.config.minTransferThresholdUsd) {
                            const added = await this.watchlist.addDiscoveredByTransfer(
                                to,
                                from,
                                amountUsd,
                                log.transactionHash as string
                            );

                            if (added) {
                                addedByTransfer++;
                                totalDiscoveries++;
                            } else {
                                skipped++;
                            }
                        }
                    }
                } catch (err) {
                    console.error(
                        `[ClusteringEngine] Error scanning ${token.symbol} transfers:`,
                        err instanceof Error ? err.message : err
                    );
                }
            }
        }

        // ─── 4. Rule 2: Gas Funding Detection ─────────────────────────────
        if (this.config.enableGasFundingRule && totalDiscoveries < this.config.maxDiscoveriesPerTick) {
            console.log("[ClusteringEngine] Checking gas funding patterns...");

            try {
                const gasFundingResults = await this.detectGasFunding(
                    watchedWallets,
                    fromBlock,
                    latestBlock,
                    this.config.maxDiscoveriesPerTick - totalDiscoveries
                );

                addedByGasFunding = gasFundingResults.added;
                skipped += gasFundingResults.skipped;
                totalDiscoveries += gasFundingResults.added;
            } catch (err) {
                console.error(
                    "[ClusteringEngine] Error in gas funding detection:",
                    err instanceof Error ? err.message : err
                );
            }
        }

        const durationMs = Date.now() - startTime;

        console.log(
            `[ClusteringEngine] ═══ Tick complete ═══ | ` +
            `duration=${durationMs}ms | ` +
            `transfers=${transfersAnalyzed} | ` +
            `+transfer=${addedByTransfer} | ` +
            `+gas=${addedByGasFunding} | ` +
            `skipped=${skipped}`
        );

        return {
            transfersAnalyzed,
            addedByTransfer,
            addedByGasFunding,
            skipped,
            durationMs,
        };
    }

    // ─── Rule 2: Gas Funding Detection ────────────────────────────────────────

    /**
     * Обнаруживает паттерн "gas funding":
     * Кит отправляет ETH/MNT на адрес с nonce=0 (первая транзакция).
     *
     * Эвристика:
     * - Watched wallet → native transfer → recipient с tx_count == 1
     * - Это означает, что watched wallet "создал" (финансировал) новый адрес
     * - Новый адрес добавляется в мониторинг как sub-cluster
     */
    private async detectGasFunding(
        watchedWallets: string[],
        fromBlock: bigint,
        toBlock: bigint,
        maxDiscoveries: number
    ): Promise<{ added: number; skipped: number }> {
        let added = 0;
        let skipped = 0;

        // Сканируем internal transactions (native MNT transfers)
        // На Mantle: нативные переводы видны через trace_block или через
        // обычные транзакции (value > 0, input = 0x)
        // Для простоты: используем getLogs без фильтра по контракту
        // и проверяем block transactions

        // Оптимизация: проверяем только последние N блоков
        const blocksToCheck = Math.min(Number(toBlock - fromBlock), 50);
        const startBlock = toBlock - BigInt(blocksToCheck);

        for (let blockNum = startBlock; blockNum <= toBlock; blockNum++) {
            if (added >= maxDiscoveries) break;

            try {
                const block = await this.publicClient.getBlock({
                    blockNumber: blockNum,
                    includeTransactions: true,
                });

                for (const tx of block.transactions) {
                    if (added >= maxDiscoveries) break;

                    // Фильтр: from ∈ watchedWallets И value > 0 И input == "0x"
                    if (typeof tx === "string") continue;

                    const from = tx.from.toLowerCase();
                    if (!watchedWallets.includes(from)) continue;
                    if (tx.value === 0n) continue;
                    if (tx.input !== "0x") continue; // Простой перевод, не contract call

                    const to = tx.to?.toLowerCase();
                    if (!to) continue; // Contract creation — skip

                    // Пропускаем если уже в watchlist
                    if (await this.watchlist.isWatched(to)) continue;

                    // Проверяем: у получателя nonce == 1 (только что получил первый перевод)
                    const recipientNonce = await this.getTransactionCount(to as Address);

                    if (recipientNonce <= 1) {
                        // Это свежий адрес, финансируемый китом → добавляем
                        const wasAdded = await this.watchlist.addDiscoveredByGasFunding(
                            to,
                            from,
                            tx.hash
                        );

                        if (wasAdded) {
                            added++;
                        } else {
                            skipped++;
                        }
                    }
                }
            } catch (err) {
                // Не критично — пропускаем блок и продолжаем
                console.warn(
                    `[ClusteringEngine] Failed to process block ${blockNum}:`,
                    err instanceof Error ? err.message : err
                );
            }
        }

        if (added > 0) {
            console.log(
                `[ClusteringEngine] Gas funding: discovered ${added} new wallets`
            );
        }

        return { added, skipped };
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    /**
     * Вычисляет USD эквивалент для данного количества токенов.
     */
    private computeUsdValue(amount: bigint, token: MonitoredToken): number {
        const divisor = 10 ** token.decimals;
        const tokenAmount = Number(amount) / divisor;
        return tokenAmount * token.priceUsd;
    }

    /**
     * Проверяет, является ли адрес известным контрактом (DEX, bridge, etc.).
     * В production: подгружается из Redis SET "known_contracts".
     * Здесь: базовая проверка через getCode.
     */
    private async isKnownContract(address: string): Promise<boolean> {
        try {
            const code = await this.publicClient.getCode({
                address: address as Address,
            });
            // Если есть bytecode — это контракт, пропускаем
            return code !== undefined && code !== "0x";
        } catch {
            return false;
        }
    }

    /**
     * Получает transaction count (nonce) с кешированием на один tick.
     */
    private async getTransactionCount(address: Address): Promise<number> {
        const cached = this.nonceCache.get(address.toLowerCase());
        if (cached !== undefined) return cached;

        const count = await this.publicClient.getTransactionCount({ address });
        this.nonceCache.set(address.toLowerCase(), count);
        return count;
    }

    /**
     * Обновляет цены токенов (вызывается перед tick-ом из oracle).
     */
    updateTokenPrice(tokenAddress: string, newPriceUsd: number): void {
        const token = this.config.monitoredTokens.find(
            (t) => t.address.toLowerCase() === tokenAddress.toLowerCase()
        );
        if (token) {
            (token as { priceUsd: number }).priceUsd = newPriceUsd;
            console.log(
                `[ClusteringEngine] Updated ${token.symbol} price: $${newPriceUsd}`
            );
        }
    }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}
