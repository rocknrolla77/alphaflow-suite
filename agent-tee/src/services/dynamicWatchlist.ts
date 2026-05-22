// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — agent-tee/src/services/dynamicWatchlist.ts
// Phase 4: Dynamic Watchlist — Redis-backed whale/cluster wallet tracking
//
// АРХИТЕКТУРА:
//   Полный отказ от state.json. Все данные живут в Redis SET/HASH.
//   TEE-агент при каждом поллинг-цикле запрашивает SMEMBERS watched_wallets.
//
// REDIS СТРУКТУРЫ:
//   SET  watched_wallets                → все отслеживаемые адреса (lowercase)
//   SET  cluster:{parentAddr}           → sub-cluster адресов, связанных с китом
//   HASH wallet_meta:{addr}             → { addedAt, reason, parentWallet, tag }
//   SET  watched_wallets:seeds          → изначальные seed-адреса (для аудита)
//
// ИНВАРИАНТЫ:
//   - Все адреса нормализованы к lowercase (checksumming не хранится)
//   - Добавление идемпотентно (SADD игнорирует дубликаты)
//   - seed-адреса НИКОГДА не удаляются из watched_wallets:seeds
//   - Удаление из watched_wallets возможно только вручную (admin cleanup)
//   - Максимум MAX_WATCHLIST_SIZE адресов (защита от неконтролируемого роста)
// ═══════════════════════════════════════════════════════════════════════════════

import { Redis } from "ioredis";

// ─── Redis Key Constants ──────────────────────────────────────────────────────

export const REDIS_KEYS = {
    /** Основной SET всех отслеживаемых адресов */
    watchedWallets: "watched_wallets",
    /** SET seed-адресов (начальные киты, заданные оператором) */
    seeds: "watched_wallets:seeds",
    /** SET sub-cluster для конкретного родительского кошелька */
    cluster: (parent: string) => `cluster:${parent.toLowerCase()}`,
    /** HASH метаданных кошелька */
    walletMeta: (addr: string) => `wallet_meta:${addr.toLowerCase()}`,
    /** Счётчик добавленных адресов за текущий epoch (rate limiting) */
    additionsCounter: "watched_wallets:additions_count",
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WalletMetadata {
    /** Unix timestamp добавления */
    addedAt: number;
    /** Причина добавления: "seed" | "direct_transfer" | "gas_funding" | "manual" */
    reason: "seed" | "direct_transfer" | "gas_funding" | "manual";
    /** Родительский кошелёк (кит, от которого обнаружена связь) */
    parentWallet: string | null;
    /** Тег: "Whale", "Fund", "VC", "Sub-Cluster" и т.д. */
    tag: string;
    /** Сумма перевода в USD (для direct_transfer) */
    transferAmountUsd?: number;
    /** Tx hash, послуживший причиной добавления */
    discoveryTxHash?: string;
}

export interface WatchlistStats {
    /** Общее количество адресов в watchlist */
    totalWallets: number;
    /** Количество seed-адресов */
    seedCount: number;
    /** Количество адресов, добавленных через clustering */
    discoveredCount: number;
    /** Количество уникальных кластеров */
    clusterCount: number;
}

export interface DynamicWatchlistConfig {
    /** Максимальный размер watchlist (защита от взрыва) */
    maxWatchlistSize: number;
    /** Максимум добавлений за один epoch (rate limit) */
    maxAdditionsPerEpoch: number;
    /** Длительность epoch для rate limiting (секунды) */
    epochDurationSec: number;
}

// ─── Default Config ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG: DynamicWatchlistConfig = {
    maxWatchlistSize: 10_000,
    maxAdditionsPerEpoch: 50,
    epochDurationSec: 300, // 5 minutes
};

// ═══════════════════════════════════════════════════════════════════════════════
//                          DynamicWatchlist CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class DynamicWatchlist {
    private readonly redis: Redis;
    private readonly config: DynamicWatchlistConfig;

    constructor(redis: Redis, config?: Partial<DynamicWatchlistConfig>) {
        this.redis = redis;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // ─── Core Operations ──────────────────────────────────────────────────────

    /**
     * Возвращает ВСЕ текущие отслеживаемые адреса.
     * Используется polling loop для итерации по кошелькам.
     *
     * @returns Set<string> — lowercase addresses
     */
    async getWatchedWallets(): Promise<Set<string>> {
        const members = await this.redis.smembers(REDIS_KEYS.watchedWallets);
        return new Set(members);
    }

    /**
     * Возвращает массив адресов (для передачи в NansenClient / RPC batch).
     */
    async getWatchedWalletsArray(): Promise<string[]> {
        return this.redis.smembers(REDIS_KEYS.watchedWallets);
    }

    /**
     * Проверяет, отслеживается ли адрес.
     */
    async isWatched(address: string): Promise<boolean> {
        return (await this.redis.sismember(
            REDIS_KEYS.watchedWallets,
            address.toLowerCase()
        )) === 1;
    }

    /**
     * Возвращает количество адресов в watchlist.
     */
    async size(): Promise<number> {
        return this.redis.scard(REDIS_KEYS.watchedWallets);
    }

    // ─── Seed Management ──────────────────────────────────────────────────────

    /**
     * Добавляет seed-адреса (начальные киты, заданные оператором).
     * Seed-адреса — корни графа кластеризации.
     *
     * @param addresses — массив адресов-китов
     * @param tag — тег для всех (default: "Whale")
     */
    async addSeeds(addresses: string[], tag: string = "Whale"): Promise<number> {
        if (addresses.length === 0) return 0;

        const normalized = addresses.map((a) => a.toLowerCase());
        const pipeline = this.redis.pipeline();

        // Добавляем в оба SET-а
        pipeline.sadd(REDIS_KEYS.watchedWallets, ...normalized);
        pipeline.sadd(REDIS_KEYS.seeds, ...normalized);

        // Метаданные для каждого
        const now = Math.floor(Date.now() / 1000);
        for (const addr of normalized) {
            const meta: WalletMetadata = {
                addedAt: now,
                reason: "seed",
                parentWallet: null,
                tag,
            };
            pipeline.hset(REDIS_KEYS.walletMeta(addr), this.metaToHash(meta));
        }

        const results = await pipeline.exec();
        // Первый результат — SADD watched_wallets → количество новых
        const added = (results?.[0]?.[1] as number) ?? 0;

        console.log(
            `[DynamicWatchlist] Added ${added} new seed wallets (${normalized.length} total submitted)`
        );

        return added;
    }

    /**
     * Возвращает все seed-адреса.
     */
    async getSeeds(): Promise<string[]> {
        return this.redis.smembers(REDIS_KEYS.seeds);
    }

    // ─── Discovery (Clustering Engine использует эти методы) ──────────────────

    /**
     * Добавляет адрес, обнаруженный через direct transfer (Правило 1).
     *
     * @param address — новый адрес для мониторинга
     * @param parentWallet — кит, совершивший перевод
     * @param transferAmountUsd — сумма перевода в USD
     * @param discoveryTxHash — hash транзакции-перевода
     * @returns true если адрес был добавлен (false если уже существует или лимит)
     */
    async addDiscoveredByTransfer(
        address: string,
        parentWallet: string,
        transferAmountUsd: number,
        discoveryTxHash: string
    ): Promise<boolean> {
        const addr = address.toLowerCase();
        const parent = parentWallet.toLowerCase();

        // ─── Guard: size limit ────────────────────────────────────────────
        if (await this.isOverCapacity()) {
            console.warn(
                `[DynamicWatchlist] CAPACITY LIMIT reached (${this.config.maxWatchlistSize}). ` +
                `Skipping: ${addr}`
            );
            return false;
        }

        // ─── Guard: rate limit ────────────────────────────────────────────
        if (await this.isRateLimited()) {
            console.warn(
                `[DynamicWatchlist] RATE LIMITED (max ${this.config.maxAdditionsPerEpoch}/epoch). ` +
                `Skipping: ${addr}`
            );
            return false;
        }

        // ─── Guard: already watched ──────────────────────────────────────
        if (await this.isWatched(addr)) {
            return false;
        }

        // ─── Atomic add ───────────────────────────────────────────────────
        const meta: WalletMetadata = {
            addedAt: Math.floor(Date.now() / 1000),
            reason: "direct_transfer",
            parentWallet: parent,
            tag: "Sub-Cluster",
            transferAmountUsd,
            discoveryTxHash,
        };

        const pipeline = this.redis.pipeline();
        pipeline.sadd(REDIS_KEYS.watchedWallets, addr);
        pipeline.sadd(REDIS_KEYS.cluster(parent), addr);
        pipeline.hset(REDIS_KEYS.walletMeta(addr), this.metaToHash(meta));
        pipeline.incr(REDIS_KEYS.additionsCounter);
        await pipeline.exec();

        console.log(
            `[DynamicWatchlist] ✅ DISCOVERED (transfer): ${addr} ` +
            `← ${parent.slice(0, 10)}... | $${transferAmountUsd.toLocaleString()} | ` +
            `tx: ${discoveryTxHash.slice(0, 16)}...`
        );

        return true;
    }

    /**
     * Добавляет адрес, обнаруженный через gas funding (Правило 2).
     *
     * @param address — новый адрес (получатель gas)
     * @param funderWallet — кит, оплативший gas
     * @param discoveryTxHash — hash funding транзакции
     * @returns true если адрес был добавлен
     */
    async addDiscoveredByGasFunding(
        address: string,
        funderWallet: string,
        discoveryTxHash: string
    ): Promise<boolean> {
        const addr = address.toLowerCase();
        const funder = funderWallet.toLowerCase();

        if (await this.isOverCapacity()) {
            console.warn(
                `[DynamicWatchlist] CAPACITY LIMIT reached. Skipping gas-funded: ${addr}`
            );
            return false;
        }

        if (await this.isRateLimited()) {
            console.warn(
                `[DynamicWatchlist] RATE LIMITED. Skipping gas-funded: ${addr}`
            );
            return false;
        }

        if (await this.isWatched(addr)) {
            return false;
        }

        const meta: WalletMetadata = {
            addedAt: Math.floor(Date.now() / 1000),
            reason: "gas_funding",
            parentWallet: funder,
            tag: "Gas-Funded",
            discoveryTxHash,
        };

        const pipeline = this.redis.pipeline();
        pipeline.sadd(REDIS_KEYS.watchedWallets, addr);
        pipeline.sadd(REDIS_KEYS.cluster(funder), addr);
        pipeline.hset(REDIS_KEYS.walletMeta(addr), this.metaToHash(meta));
        pipeline.incr(REDIS_KEYS.additionsCounter);
        await pipeline.exec();

        console.log(
            `[DynamicWatchlist] ✅ DISCOVERED (gas-funding): ${addr} ` +
            `← funder: ${funder.slice(0, 10)}... | ` +
            `tx: ${discoveryTxHash.slice(0, 16)}...`
        );

        return true;
    }

    // ─── Cluster Queries ──────────────────────────────────────────────────────

    /**
     * Возвращает все адреса в sub-cluster конкретного кита.
     */
    async getCluster(parentWallet: string): Promise<string[]> {
        return this.redis.smembers(REDIS_KEYS.cluster(parentWallet.toLowerCase()));
    }

    /**
     * Возвращает метаданные кошелька.
     */
    async getWalletMeta(address: string): Promise<WalletMetadata | null> {
        const raw = await this.redis.hgetall(REDIS_KEYS.walletMeta(address.toLowerCase()));
        if (!raw || Object.keys(raw).length === 0) return null;

        return {
            addedAt: parseInt(raw["addedAt"] ?? "0", 10),
            reason: (raw["reason"] as WalletMetadata["reason"]) ?? "manual",
            parentWallet: raw["parentWallet"] === "null" ? null : (raw["parentWallet"] ?? null),
            tag: raw["tag"] ?? "Unknown",
            transferAmountUsd: raw["transferAmountUsd"]
                ? parseFloat(raw["transferAmountUsd"])
                : undefined,
            discoveryTxHash: raw["discoveryTxHash"] || undefined,
        };
    }

    // ─── Statistics ───────────────────────────────────────────────────────────

    /**
     * Возвращает агрегированную статистику watchlist.
     */
    async getStats(): Promise<WatchlistStats> {
        const [totalWallets, seedCount] = await Promise.all([
            this.redis.scard(REDIS_KEYS.watchedWallets),
            this.redis.scard(REDIS_KEYS.seeds),
        ]);

        // Подсчёт кластеров через SCAN (ключи cluster:*)
        let clusterCount = 0;
        let cursor = "0";
        do {
            const [nextCursor, keys] = await this.redis.scan(
                cursor, "MATCH", "cluster:*", "COUNT", "100"
            );
            cursor = nextCursor;
            clusterCount += keys.length;
        } while (cursor !== "0");

        return {
            totalWallets,
            seedCount,
            discoveredCount: totalWallets - seedCount,
            clusterCount,
        };
    }

    // ─── Admin Operations ─────────────────────────────────────────────────────

    /**
     * Удаляет адрес из watchlist (admin-only, не используется автоматически).
     * НЕ удаляет из seeds (seed-адреса перманентные).
     */
    async removeWallet(address: string): Promise<boolean> {
        const addr = address.toLowerCase();
        const isSeed = await this.redis.sismember(REDIS_KEYS.seeds, addr);

        if (isSeed) {
            console.warn(
                `[DynamicWatchlist] Cannot remove seed wallet: ${addr}. Use removeForce() if intended.`
            );
            return false;
        }

        const pipeline = this.redis.pipeline();
        pipeline.srem(REDIS_KEYS.watchedWallets, addr);
        pipeline.del(REDIS_KEYS.walletMeta(addr));

        // Удаляем из родительского cluster
        const meta = await this.getWalletMeta(addr);
        if (meta?.parentWallet) {
            pipeline.srem(REDIS_KEYS.cluster(meta.parentWallet), addr);
        }

        await pipeline.exec();
        console.log(`[DynamicWatchlist] Removed wallet: ${addr}`);
        return true;
    }

    /**
     * Сброс rate limit counter (вызывается при старте нового epoch).
     */
    async resetEpochCounter(): Promise<void> {
        await this.redis.set(
            REDIS_KEYS.additionsCounter,
            "0",
            "EX",
            this.config.epochDurationSec
        );
    }

    // ─── Private Helpers ──────────────────────────────────────────────────────

    private async isOverCapacity(): Promise<boolean> {
        const currentSize = await this.redis.scard(REDIS_KEYS.watchedWallets);
        return currentSize >= this.config.maxWatchlistSize;
    }

    private async isRateLimited(): Promise<boolean> {
        const countRaw = await this.redis.get(REDIS_KEYS.additionsCounter);
        const count = parseInt(countRaw ?? "0", 10);
        return count >= this.config.maxAdditionsPerEpoch;
    }

    private metaToHash(meta: WalletMetadata): Record<string, string> {
        const hash: Record<string, string> = {
            addedAt: meta.addedAt.toString(),
            reason: meta.reason,
            parentWallet: meta.parentWallet ?? "null",
            tag: meta.tag,
        };
        if (meta.transferAmountUsd !== undefined) {
            hash["transferAmountUsd"] = meta.transferAmountUsd.toString();
        }
        if (meta.discoveryTxHash) {
            hash["discoveryTxHash"] = meta.discoveryTxHash;
        }
        return hash;
    }
}
