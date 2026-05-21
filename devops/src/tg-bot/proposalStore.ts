// Файл: devops/src/tg-bot/proposalStore.ts
// Redis-backed Proposal Store с TTL, nullifier и staleness detection

import { Redis } from "ioredis";
import { createHmac, randomUUID } from "crypto";

export interface StoredProposal {
    id: string;
    asset: string;
    action: "BUY" | "SELL";
    amount: number;
    deadline: number;
    reasoningHash: string;
    proofOfReasoning: string;
    teeSignerAddress: string;
    createdAt: number;
    status: "pending" | "approved" | "rejected" | "expired" | "executed";
    /** Цена актива на момент генерации (для staleness detection) */
    priceAtGeneration: number;
    /** Допустимое отклонение цены (%) */
    maxSlippagePct: number;
    /** HMAC подпись proposalId для TMA deep-link */
    hmacSignature: string;
}

/**
 * ProposalStore — безопасное хранилище предложений.
 * 
 * Защиты:
 * 1. TTL: proposal автоматически истекает (Redis EXPIRE)
 * 2. Nullifier: reasoningHash записывается в SET — повторный proposal отклоняется
 * 3. Status FSM: pending → approved/rejected/expired (одностороннее)
 * 4. HMAC: proposalId подписан — предотвращает URL injection
 * 5. Staleness: проверка актуальности цены при approve
 */
export class ProposalStore {
    private redis: Redis;
    private hmacSecret: string;
    private defaultTtlSec: number;

    // Redis key prefixes
    private readonly PREFIX_PROPOSAL = "proposal:";
    private readonly PREFIX_NULLIFIER = "nullifier:";
    private readonly SET_USED_HASHES = "used_reasoning_hashes";

    constructor(redis: Redis, hmacSecret: string, defaultTtlSec: number = 300) {
        this.redis = redis;
        this.hmacSecret = hmacSecret;
        this.defaultTtlSec = defaultTtlSec;
    }

    /**
     * Сохраняет новый Proposal из TEE.
     * Проверяет nullifier — отклоняет дубликаты по reasoningHash.
     */
    async store(proposal: Omit<StoredProposal, "id" | "status" | "hmacSignature" | "createdAt">): Promise<{
        stored: boolean;
        id?: string;
        hmac?: string;
        reason?: string;
    }> {
        // ─── Nullifier Check: replay protection ──────────────────────
        const isUsed = await this.redis.sismember(this.SET_USED_HASHES, proposal.reasoningHash);
        if (isUsed) {
            return { stored: false, reason: "Replay detected: reasoningHash already used" };
        }

        // ─── Deadline Check ──────────────────────────────────────────
        const now = Math.floor(Date.now() / 1000);
        if (proposal.deadline <= now) {
            return { stored: false, reason: "Proposal already expired at submission time" };
        }

        // ─── Generate secure ID + HMAC ───────────────────────────────
        const id = randomUUID();
        const hmacSignature = this.computeHmac(id);

        // ─── TTL = min(defaultTtl, time until deadline) ──────────────
        const ttl = Math.min(this.defaultTtlSec, proposal.deadline - now);

        const stored: StoredProposal = {
            ...proposal,
            id,
            status: "pending",
            hmacSignature,
            createdAt: now,
        };

        // Атомарная запись: proposal + nullifier
        const pipeline = this.redis.pipeline();
        pipeline.set(
            `${this.PREFIX_PROPOSAL}${id}`,
            JSON.stringify(stored),
            "EX",
            ttl
        );
        pipeline.sadd(this.SET_USED_HASHES, proposal.reasoningHash);
        // Nullifier тоже с TTL (24h) чтобы не расти бесконечно
        pipeline.set(
            `${this.PREFIX_NULLIFIER}${proposal.reasoningHash}`,
            id,
            "EX",
            86400
        );
        await pipeline.exec();

        return { stored: true, id, hmac: hmacSignature };
    }

    /**
     * Получает proposal по ID.
     * Верифицирует HMAC (защита от подбора UUID).
     */
    async get(id: string, hmac: string): Promise<StoredProposal | null> {
        // ─── HMAC Verification ───────────────────────────────────────
        const expectedHmac = this.computeHmac(id);
        if (!this.timingSafeEqual(hmac, expectedHmac)) {
            return null; // Invalid HMAC — potential URL tampering
        }

        const data = await this.redis.get(`${this.PREFIX_PROPOSAL}${id}`);
        if (!data) return null;

        return JSON.parse(data) as StoredProposal;
    }

    /**
     * Пользователь нажал Approve.
     * Проверяет: deadline не истёк, staleness (цена не уехала).
     */
    async approve(
        id: string,
        hmac: string,
        currentPrice: number
    ): Promise<{
        success: boolean;
        proposal?: StoredProposal;
        reason?: string;
    }> {
        const proposal = await this.get(id, hmac);
        if (!proposal) {
            return { success: false, reason: "Proposal not found or invalid HMAC" };
        }

        // ─── Status Check (FSM: only pending → approved) ─────────────
        if (proposal.status !== "pending") {
            return { success: false, reason: `Cannot approve: status is ${proposal.status}` };
        }

        // ─── Deadline Check ──────────────────────────────────────────
        const now = Math.floor(Date.now() / 1000);
        if (now >= proposal.deadline) {
            await this.updateStatus(id, "expired");
            return { success: false, reason: "Proposal expired" };
        }

        // ─── Staleness Detection (Race Condition mitigation) ─────────
        // Если цена изменилась более чем на maxSlippagePct — отклоняем
        const priceDeviation = Math.abs(
            (currentPrice - proposal.priceAtGeneration) / proposal.priceAtGeneration
        );
        if (priceDeviation > proposal.maxSlippagePct / 100) {
            await this.updateStatus(id, "rejected");
            return {
                success: false,
                reason: `Price moved ${(priceDeviation * 100).toFixed(2)}% > max ${proposal.maxSlippagePct}% slippage`,
            };
        }

        // ─── Approve ─────────────────────────────────────────────────
        await this.updateStatus(id, "approved");
        proposal.status = "approved";
        return { success: true, proposal };
    }

    /**
     * Отклонение пользователем.
     */
    async reject(id: string, hmac: string): Promise<boolean> {
        const proposal = await this.get(id, hmac);
        if (!proposal || proposal.status !== "pending") return false;
        await this.updateStatus(id, "rejected");
        return true;
    }

    /**
     * Получить все pending proposals (для recovery при рестарте).
     */
    async getPendingProposals(): Promise<StoredProposal[]> {
        const keys = await this.redis.keys(`${this.PREFIX_PROPOSAL}*`);
        if (keys.length === 0) return [];

        const values = await this.redis.mget(keys);
        return values
            .filter((v): v is string => v !== null)
            .map((v) => JSON.parse(v) as StoredProposal)
            .filter((p) => p.status === "pending");
    }

    // ─── Private Helpers ─────────────────────────────────────────────

    private async updateStatus(id: string, status: StoredProposal["status"]): Promise<void> {
        const key = `${this.PREFIX_PROPOSAL}${id}`;
        const data = await this.redis.get(key);
        if (!data) return;

        const proposal = JSON.parse(data) as StoredProposal;
        proposal.status = status;

        // Сохраняем с оставшимся TTL
        const ttl = await this.redis.ttl(key);
        if (ttl > 0) {
            await this.redis.set(key, JSON.stringify(proposal), "EX", ttl);
        }
    }

    private computeHmac(id: string): string {
        return createHmac("sha256", this.hmacSecret).update(id).digest("hex");
    }

    /**
     * Timing-safe string comparison (предотвращает timing attacks на HMAC).
     */
    private timingSafeEqual(a: string, b: string): boolean {
        if (a.length !== b.length) return false;
        const bufA = Buffer.from(a);
        const bufB = Buffer.from(b);
        // Node.js crypto.timingSafeEqual
        const { timingSafeEqual: tse } = require("crypto");
        return tse(bufA, bufB);
    }
}
