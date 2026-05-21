// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — bff/src/services/proposalService.ts
// Redis-backed Proposal Store: HMAC verification, optimistic locking, nullifier
// ═══════════════════════════════════════════════════════════════════════════════

import { createHmac, timingSafeEqual } from "node:crypto";
import { Redis } from "ioredis";
import { z } from "zod";

// ─── Configuration ────────────────────────────────────────────────────────────

const HMAC_SECRET = process.env["HMAC_SECRET"];
if (!HMAC_SECRET) {
    throw new Error("FATAL: HMAC_SECRET environment variable is required");
}

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

/**
 * Redis Key Conventions:
 *   proposal:{id}        → JSON string (SignedProposal)
 *   proposal:{id}:status → "pending" | "dispensed" | "consumed" | "expired"
 *   proposal_lock:{id}   → "1" with TTL 60s (optimistic lock)
 *   nullifier:{hash}     → "1" (one-time use, never deleted)
 */
const KEY = {
    proposal: (id: string) => `proposal:${id}`,
    status: (id: string) => `proposal:${id}:status`,
    lock: (id: string) => `proposal_lock:${id}`,
    nullifier: (hash: string) => `nullifier:${hash}`,
} as const;

// ─── Redis Client (singleton) ─────────────────────────────────────────────────

let redis: Redis | null = null;

export function getRedis(): Redis {
    if (!redis) {
        redis = new Redis(REDIS_URL, {
            maxRetriesPerRequest: 3,
            retryStrategy(times: number): number | null {
                if (times > 10) return null; // Stop retrying
                return Math.min(times * 200, 5000);
            },
            lazyConnect: false,
        });

        redis.on("error", (err: Error) => {
            console.error("[BFF] Redis connection error:", err.message);
        });

        redis.on("connect", () => {
            console.log("[BFF] Redis connected");
        });
    }
    return redis;
}

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

export const ProposalSchema = z.object({
    asset: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    action: z.enum(["BUY", "SELL"]),
    recommendedAmount: z.string(), // BigInt serialized as string
    nonce: z.number().int().nonnegative(),
    deadline: z.number().int().positive(),
    reasoningHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
    signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/),
    signerAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    generatedAt: z.number().int().positive(),
    // Optional metadata from TEE
    assetSymbol: z.string().optional(),
    priceAtGeneration: z.string().optional(), // BigInt as string
    maxSlippageBps: z.number().int().optional(),
});

export type StoredProposal = z.infer<typeof ProposalSchema>;

// ─── HMAC Verification ────────────────────────────────────────────────────────

/**
 * Вычисляет HMAC-SHA256 подпись для proposalId.
 *
 * Используется TEE/TG Bot при генерации deep link:
 *   sig = hmac_sha256(HMAC_SECRET, proposalId)
 *
 * @param proposalId — ID proposal (UUID или hex string)
 * @returns hex-encoded HMAC signature
 */
export function computeHmac(proposalId: string): string {
    return createHmac("sha256", HMAC_SECRET!)
        .update(proposalId, "utf8")
        .digest("hex");
}

/**
 * Верифицирует HMAC-подпись timing-safe способом.
 *
 * БЕЗОПАСНОСТЬ:
 * - timingSafeEqual предотвращает timing attack
 * - Сравнение фиксированной длины (Buffer)
 * - Возвращает false при любом несоответствии длины
 *
 * @param proposalId — ID proposal из URL path
 * @param providedSignature — hex signature из заголовка x-hmac-signature
 * @returns true если подпись валидна
 */
export function verifyHmac(proposalId: string, providedSignature: string): boolean {
    const expected = computeHmac(proposalId);

    // Защита от oracle attack по длине
    if (providedSignature.length !== expected.length) {
        return false;
    }

    const expectedBuf = Buffer.from(expected, "hex");
    const providedBuf = Buffer.from(providedSignature, "hex");

    // Если длины Buffer не совпадают (невалидный hex) → false
    if (expectedBuf.length !== providedBuf.length) {
        return false;
    }

    return timingSafeEqual(expectedBuf, providedBuf);
}

// ─── Proposal Operations ──────────────────────────────────────────────────────

export interface ProposalResult {
    success: boolean;
    proposal?: StoredProposal;
    error?: string;
    httpStatus: number;
}

/**
 * Извлекает Proposal из Redis с Optimistic Lock.
 *
 * Механика:
 * 1. Проверяет существование proposal
 * 2. Проверяет текущий статус (pending → можно выдать)
 * 3. Проверяет deadline (не истёк ли)
 * 4. Устанавливает optimistic lock (SETNX + TTL 60s)
 * 5. Обновляет статус на "dispensed"
 * 6. Возвращает данные клиенту
 *
 * STATE DESYNC FIX: Lock ставится ДО выдачи payload.
 * Если TMA закроется без /consume, lock истечёт через 60s
 * и proposal вернётся в статус "pending" (через cron/watcher).
 *
 * @param proposalId — ID proposal
 * @returns ProposalResult с данными или ошибкой
 */
export async function getAndLockProposal(proposalId: string): Promise<ProposalResult> {
    const r = getRedis();

    // ─── Step 1: Fetch proposal from Redis ───────────────────────────────
    const raw = await r.get(KEY.proposal(proposalId));
    if (!raw) {
        return { success: false, error: "Proposal not found", httpStatus: 404 };
    }

    // ─── Step 2: Parse and validate ─────────────────────────────────────
    let proposal: StoredProposal;
    try {
        const parsed: unknown = JSON.parse(raw);
        proposal = ProposalSchema.parse(parsed);
    } catch {
        return { success: false, error: "Proposal data corrupted", httpStatus: 500 };
    }

    // ─── Step 3: Check deadline (staleness by time) ──────────────────────
    const now = Math.floor(Date.now() / 1000);
    if (proposal.deadline <= now) {
        // Mark as expired
        await r.set(KEY.status(proposalId), "expired");
        return { success: false, error: "Proposal expired (deadline passed)", httpStatus: 410 };
    }

    // ─── Step 4: Check current status ───────────────────────────────────
    const currentStatus = await r.get(KEY.status(proposalId));
    if (currentStatus === "consumed") {
        return { success: false, error: "Proposal already consumed (nullifier spent)", httpStatus: 409 };
    }
    if (currentStatus === "dispensed") {
        // Check if lock still active (another session is signing)
        const lockExists = await r.exists(KEY.lock(proposalId));
        if (lockExists) {
            return { success: false, error: "Proposal locked by another session (retry in 60s)", httpStatus: 423 };
        }
        // Lock expired — allow re-dispensing
    }

    // ─── Step 5: Optimistic Lock (SETNX + TTL 60s) ─────────────────────
    // SETNX = SET if Not eXists (atomic, race-condition safe)
    const lockAcquired = await r.set(KEY.lock(proposalId), "1", "EX", 60, "NX");
    if (!lockAcquired) {
        // Another request grabbed the lock between our EXISTS check and SET
        return { success: false, error: "Lock contention (concurrent request)", httpStatus: 423 };
    }

    // ─── Step 6: Update status to "dispensed" ───────────────────────────
    await r.set(KEY.status(proposalId), "dispensed", "EX", 120); // 2x lock TTL

    // ─── Step 7: Check nullifier (double-spend protection) ──────────────
    const nullifierUsed = await r.exists(KEY.nullifier(proposal.reasoningHash));
    if (nullifierUsed) {
        // Release lock since we're rejecting
        await r.del(KEY.lock(proposalId));
        await r.set(KEY.status(proposalId), "consumed");
        return { success: false, error: "Nullifier already spent (replay attempt)", httpStatus: 409 };
    }

    return { success: true, proposal, httpStatus: 200 };
}

/**
 * Consume (burn) a Proposal — marks it as permanently used.
 *
 * Called after successful on-chain execution:
 * 1. TMA calls POST /api/proposal/:id/consume
 * 2. OR OnChainWatcher detects FlashArbitrageExecuted event
 *
 * Effects:
 * - Sets nullifier (reasoningHash → permanent, no TTL)
 * - Updates status to "consumed"
 * - Removes lock
 * - Removes proposal data (optional retention)
 *
 * @param proposalId — ID proposal
 * @returns success/error result
 */
export async function consumeProposal(proposalId: string): Promise<ProposalResult> {
    const r = getRedis();

    // Fetch proposal to get reasoningHash
    const raw = await r.get(KEY.proposal(proposalId));
    if (!raw) {
        return { success: false, error: "Proposal not found", httpStatus: 404 };
    }

    let proposal: StoredProposal;
    try {
        const parsed: unknown = JSON.parse(raw);
        proposal = ProposalSchema.parse(parsed);
    } catch {
        return { success: false, error: "Proposal data corrupted", httpStatus: 500 };
    }

    // Check if already consumed (idempotent)
    const currentStatus = await r.get(KEY.status(proposalId));
    if (currentStatus === "consumed") {
        return { success: true, proposal, httpStatus: 200 }; // Idempotent OK
    }

    // ─── Atomic consume: pipeline for consistency ────────────────────────
    const pipeline = r.pipeline();

    // 1. Set nullifier (permanent — never expires)
    pipeline.set(KEY.nullifier(proposal.reasoningHash), "1");

    // 2. Update status
    pipeline.set(KEY.status(proposalId), "consumed");

    // 3. Remove lock (if exists)
    pipeline.del(KEY.lock(proposalId));

    // 4. Set TTL on proposal data (retain for audit, 7 days)
    pipeline.expire(KEY.proposal(proposalId), 7 * 24 * 3600);

    await pipeline.exec();

    return { success: true, proposal, httpStatus: 200 };
}

/**
 * Проверяет health Redis-соединения.
 */
export async function redisHealthCheck(): Promise<boolean> {
    try {
        const r = getRedis();
        const pong = await r.ping();
        return pong === "PONG";
    } catch {
        return false;
    }
}

/**
 * Graceful shutdown — закрывает Redis-соединение.
 */
export async function shutdownRedis(): Promise<void> {
    if (redis) {
        await redis.quit();
        redis = null;
    }
}
