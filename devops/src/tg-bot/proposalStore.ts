// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — devops/src/tg-bot/proposalStore.ts
// Redis Pub/Sub Subscriber + Proposal Store + HMAC + Nullifier
//
// ИНВАРИАНТЫ:
// - HMAC_SECRET никогда не передаётся на клиент (генерируется здесь)
// - Nullifier устанавливается ПЕРЕД broadcast (защита от двойной отправки)
// - Replay-атака: nullifier:{reasoningHash} = permanent sentinel в Redis
// - При pause-флаге новые proposals НЕ принимаются
// ═══════════════════════════════════════════════════════════════════════════════

import { createHmac } from "node:crypto";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { z } from "zod";

// ─── Environment Validation ───────────────────────────────────────────────────

const HMAC_SECRET = process.env["HMAC_SECRET"];
if (!HMAC_SECRET) {
    throw new Error("FATAL: HMAC_SECRET env var required");
}

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

// ─── Redis Key Conventions ────────────────────────────────────────────────────
//
// Структура ключей в точности совпадает с BFF (proposalService.ts),
// чтобы BFF мог читать/лочить/консьюмить proposals, созданных ботом.
//
//   proposal:{id}            → JSON (StoredProposal), TTL = seconds until deadline
//   proposal:{id}:status     → "pending" | "dispensed" | "consumed" | "expired"
//   nullifier:{reasoningHash}→ "1" (permanent, no TTL — anti-replay)
//   bot:paused               → "1" если бот стоит на паузе
//   bot:signal_count         → INCR counter для статистики

export const REDIS_KEYS = {
    proposal:   (id: string) => `proposal:${id}`,
    status:     (id: string) => `proposal:${id}:status`,
    nullifier:  (hash: string) => `nullifier:${hash}`,
    paused:     "bot:paused",
    signalCount:"bot:signal_count",
} as const;

// ─── Zod Schema — Incoming TEE Proposal ──────────────────────────────────────
//
// Формат, публикуемый agent-tee в канал `tee_proposals`

export const TeeProposalSchema = z.object({
    // EIP-712 signed proposal fields
    asset:             z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid address"),
    assetSymbol:       z.string().min(1).max(20),
    action:            z.enum(["BUY", "SELL"]),
    recommendedAmount: z.string().regex(/^\d+$/, "Must be bigint string"),
    nonce:             z.number().int().nonnegative(),
    deadline:          z.number().int().positive(),
    reasoningHash:     z.string().regex(/^0x[a-fA-F0-9]{64}$/, "Invalid bytes32"),
    signature:         z.string().regex(/^0x[a-fA-F0-9]{130}$/, "Invalid sig"),
    signerAddress:     z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid address"),
    generatedAt:       z.number().int().positive(),
    // Optional enrichment from TEE strategy
    priceAtGeneration: z.string().optional(),
    maxSlippageBps:    z.number().int().min(0).max(10000).optional(),
});

export type TeeProposal = z.infer<typeof TeeProposalSchema>;

// ─── Stored Proposal (добавляем bot-generated поля) ───────────────────────────

export interface StoredProposal extends TeeProposal {
    id:         string;   // UUID, генерирует бот
    createdAt:  number;   // unix timestamp
}

// ─── Result Types ─────────────────────────────────────────────────────────────

export interface StoreResult {
    proposalId:      string;
    hmacSignatureHex: string;   // для хранения / логов
    hmacB64url:      string;    // для URL deep link
    ttlSeconds:      number;
}

// ─── HMAC Helpers ────────────────────────────────────────────────────────────

/**
 * Вычисляет HMAC-SHA256(proposalId) → hex string.
 *
 * Тот же алгоритм что и в BFF (proposalService.ts → computeHmac).
 * BFF верифицирует подпись timing-safe методом.
 */
export function computeHmac(proposalId: string): string {
    return createHmac("sha256", HMAC_SECRET!)
        .update(proposalId, "utf8")
        .digest("hex");
}

/**
 * Кодирует hex HMAC в Base64url (URL-safe, без padding).
 * Используется в startapp параметре Telegram deep link.
 *
 * Telegram обрезает/ломает стандартный Base64 с '=' паддингом,
 * поэтому используем Base64url (RFC 4648 §5).
 *
 * Формат deep link: startapp={proposalId}_{hmacB64url}
 * Frontend декодирует обратно в hex для x-hmac-signature header.
 */
export function hexToBase64url(hex: string): string {
    const bytes = Buffer.from(hex, "hex");
    return bytes
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

// ─── Redis Client (Pub/Sub requires separate connections) ─────────────────────
//
// ВАЖНО: ioredis в режиме subscribe НЕ МОЖЕТ выполнять обычные команды.
// Поэтому используем ДВА клиента:
//   - subscriber: только подписка на каналы
//   - commander:  CRUD операции (GET/SET/DEL/etc.)

let _subscriber: Redis | null = null;
let _commander: Redis | null = null;

function createRedisClient(name: string): Redis {
    const client = new Redis(REDIS_URL, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times: number) => {
            if (times > 10) return null;
            return Math.min(times * 200, 5000);
        },
        lazyConnect: false,
    });
    client.on("error", (err: Error) => {
        console.error(`[Redis:${name}] Error:`, err.message);
    });
    client.on("ready", () => {
        console.log(`[Redis:${name}] Connected`);
    });
    return client;
}

export function getSubscriber(): Redis {
    if (!_subscriber) _subscriber = createRedisClient("sub");
    return _subscriber;
}

export function getCommander(): Redis {
    if (!_commander) _commander = createRedisClient("cmd");
    return _commander;
}

// ─── Core Store Function ──────────────────────────────────────────────────────

/**
 * Принимает raw TEE proposal, валидирует, сохраняет в Redis и возвращает
 * данные для broadcast (proposalId + HMAC signature для deep link).
 *
 * Порядок операций:
 * 1. Проверить pause-флаг (если стоит — отклонить)
 * 2. Валидировать Zod schema
 * 3. Проверить nullifier (replay-защита)
 * 4. Сгенерировать UUID proposalId
 * 5. Вычислить HMAC-SHA256(proposalId)
 * 6. Сохранить proposal + status "pending" в Redis с TTL
 * 7. Установить nullifier (permanent)
 * 8. Вернуть StoreResult для broadcast
 *
 * @param raw — строка из Redis Pub/Sub (JSON)
 * @returns StoreResult или null если proposal отклонён
 */
export async function storeProposal(raw: string): Promise<StoreResult | null> {
    const r = getCommander();

    // ─── Step 0: Check pause flag ────────────────────────────────────────
    const isPaused = await r.get(REDIS_KEYS.paused);
    if (isPaused === "1") {
        console.log("[ProposalStore] Bot is paused — dropping incoming signal");
        return null;
    }

    // ─── Step 1: Parse & Validate ─────────────────────────────────────────
    let proposal: TeeProposal;
    try {
        const parsed: unknown = JSON.parse(raw);
        proposal = TeeProposalSchema.parse(parsed);
    } catch (err) {
        console.error("[ProposalStore] Invalid proposal format:", err);
        return null;
    }

    // ─── Step 2: Check deadline (не принимать устаревшие proposals) ────────
    const now = Math.floor(Date.now() / 1000);
    if (proposal.deadline <= now) {
        console.warn("[ProposalStore] Received expired proposal, ignoring");
        return null;
    }

    // ─── Step 3: Replay check — nullifier ─────────────────────────────────
    const nullifierKey = REDIS_KEYS.nullifier(proposal.reasoningHash);
    const alreadyProcessed = await r.exists(nullifierKey);
    if (alreadyProcessed) {
        console.warn(
            "[ProposalStore] Nullifier already set for reasoningHash:",
            proposal.reasoningHash.slice(0, 18) + "..."
        );
        return null;
    }

    // ─── Step 4: Generate proposalId ──────────────────────────────────────
    const proposalId = randomUUID();

    // ─── Step 5: Compute HMAC ─────────────────────────────────────────────
    const hmacHex = computeHmac(proposalId);
    const hmacB64url = hexToBase64url(hmacHex);

    // ─── Step 6: Build stored proposal ───────────────────────────────────
    const stored: StoredProposal = {
        ...proposal,
        id: proposalId,
        createdAt: now,
    };

    const ttlSeconds = proposal.deadline - now;
    if (ttlSeconds <= 0) return null; // race condition guard

    // ─── Step 7: Atomic pipeline — store + nullifier ───────────────────
    const pipeline = r.pipeline();

    // Store proposal JSON with TTL
    pipeline.set(
        REDIS_KEYS.proposal(proposalId),
        JSON.stringify(stored),
        "EX",
        ttlSeconds
    );

    // Set initial status "pending"
    pipeline.set(
        REDIS_KEYS.status(proposalId),
        "pending",
        "EX",
        ttlSeconds + 120 // slightly longer than proposal TTL
    );

    // Nullifier — permanent (no TTL), prevents replay forever
    pipeline.set(nullifierKey, "1");

    // Increment signal counter (statistics)
    pipeline.incr(REDIS_KEYS.signalCount);

    await pipeline.exec();

    console.log(
        `[ProposalStore] Stored proposal ${proposalId} | TTL=${ttlSeconds}s | ` +
        `Action=${proposal.action} | Asset=${proposal.assetSymbol}`
    );

    return {
        proposalId,
        hmacSignatureHex: hmacHex,
        hmacB64url,
        ttlSeconds,
    };
}

// ─── Redis Health & Control ───────────────────────────────────────────────────

export interface RedisStatus {
    healthy:      boolean;
    paused:       boolean;
    signalCount:  number;
    pingMs:       number;
}

/**
 * Возвращает статус Redis для /status команды.
 */
export async function getRedisStatus(): Promise<RedisStatus> {
    const r = getCommander();
    const t0 = Date.now();
    try {
        await r.ping();
        const pingMs = Date.now() - t0;
        const [pausedRaw, countRaw] = await Promise.all([
            r.get(REDIS_KEYS.paused),
            r.get(REDIS_KEYS.signalCount),
        ]);
        return {
            healthy:     true,
            paused:      pausedRaw === "1",
            signalCount: parseInt(countRaw ?? "0", 10),
            pingMs,
        };
    } catch {
        return { healthy: false, paused: false, signalCount: 0, pingMs: -1 };
    }
}

/**
 * Устанавливает pause-флаг (бот перестаёт принимать сигналы).
 */
export async function pauseBot(): Promise<void> {
    await getCommander().set(REDIS_KEYS.paused, "1");
}

/**
 * Снимает pause-флаг.
 */
export async function resumeBot(): Promise<void> {
    await getCommander().del(REDIS_KEYS.paused);
}

/**
 * Graceful shutdown — закрывает оба Redis-соединения.
 */
export async function shutdownStore(): Promise<void> {
    await Promise.allSettled([
        _subscriber?.quit(),
        _commander?.quit(),
    ]);
    _subscriber = null;
    _commander  = null;
}
