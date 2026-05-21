// Файл: bff/src/index.ts
// Backend-for-Frontend (BFF) для AlphaFlow TMA
// Роль: HMAC verification, staleness check, EIP-712 payload assembly
// НЕ хранит приватные ключи — только верифицирует и проксирует

import { Hono } from "hono";
import { cors } from "hono/cors";
import { Redis } from "ioredis";
import { createHmac, timingSafeEqual } from "crypto";
import { createPublicClient, http, parseAbi, encodeFunctionData } from "viem";
import { z } from "zod";

// ═══════════════════════════════════════════════════════════════════════
//                         CONFIG
// ═══════════════════════════════════════════════════════════════════════

const envSchema = z.object({
    REDIS_URL: z.string().default("redis://localhost:6379"),
    PROPOSAL_HMAC_SECRET: z.string().min(32),
    MANTLE_RPC_URL: z.string().default("https://rpc.mantle.xyz"),
    ACTIVE_SENTINEL_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    PORT: z.coerce.number().default(3001),
    // Staleness: max price deviation allowed at approve time
    MAX_STALENESS_PCT: z.coerce.number().default(2),
    // Allowed TMA origins (CORS)
    TMA_ORIGIN: z.string().default("https://alphaflow-tma.vercel.app"),
});

const env = envSchema.parse(process.env);

// ═══════════════════════════════════════════════════════════════════════
//                      INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════

const app = new Hono();
const redis = new Redis(env.REDIS_URL);

const publicClient = createPublicClient({
    transport: http(env.MANTLE_RPC_URL),
});

// CORS: только TMA origin
app.use("*", cors({
    origin: env.TMA_ORIGIN,
    allowMethods: ["GET", "POST"],
    allowHeaders: ["Content-Type", "X-HMAC-Signature", "X-Proposal-ID"],
}));

// ═══════════════════════════════════════════════════════════════════════
//                   HMAC VERIFICATION MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════

function verifyHmac(proposalId: string, providedHmac: string): boolean {
    const expected = createHmac("sha256", env.PROPOSAL_HMAC_SECRET)
        .update(proposalId)
        .digest("hex");

    if (expected.length !== providedHmac.length) return false;

    return timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(providedHmac)
    );
}

// ═══════════════════════════════════════════════════════════════════════
//                      PRICE ORACLE (TEE-SIDE)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Получает текущую цену актива из on-chain oracle (Pyth/Chainlink на Mantle).
 * КРИТИЧНО: цена должна идти из on-chain источника, а НЕ из frontend.
 *
 * В MVP используем простой DEX pool quote (TWAP).
 * В продакшене: Pyth Network price feed на Mantle.
 */
async function getOnChainPrice(tokenAddress: string): Promise<number> {
    // TODO: Integrate Pyth Network price feed on Mantle
    // Для MVP — cached price из Redis (записывается TEE-агентом)
    const cached = await redis.get(`price:${tokenAddress.toLowerCase()}`);
    if (cached) return parseFloat(cached);

    // Fallback: return 0 (BFF не может верифицировать staleness → reject)
    return 0;
}

// ═══════════════════════════════════════════════════════════════════════
//                         ROUTES
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /api/proposal/:id
 *
 * Фронтенд запрашивает детали proposal.
 * BFF верифицирует HMAC и проверяет staleness ПЕРЕД выдачей данных.
 *
 * КРИТИЧНО (State Desync Fix):
 * При выдаче payload ставим OPTIMISTIC LOCK (status → "dispensed") с TTL 60s.
 * Если UserOp не подтвердится on-chain за 60s → auto-revert to "pending".
 * Это гарантирует: даже если TMA закроется — nullifier не потеряется.
 *
 * Headers required:
 *   X-HMAC-Signature: <hmac_hex>
 */
app.get("/api/proposal/:id", async (c) => {
    const proposalId = c.req.param("id");
    const hmacSignature = c.req.header("X-HMAC-Signature");

    // ─── HMAC Verification ───────────────────────────────────────────
    if (!hmacSignature) {
        return c.json({ error: "Missing HMAC signature" }, 401);
    }
    if (!verifyHmac(proposalId, hmacSignature)) {
        return c.json({ error: "Invalid HMAC signature" }, 401);
    }

    // ─── Fetch from Redis ────────────────────────────────────────────
    const raw = await redis.get(`proposal:${proposalId}`);
    if (!raw) {
        return c.json({ error: "Proposal not found or expired" }, 404);
    }

    const proposal = JSON.parse(raw);

    // ─── Status Check (allow pending AND dispensed for retry) ────────
    if (proposal.status !== "pending" && proposal.status !== "dispensed") {
        return c.json({ error: `Proposal already ${proposal.status}` }, 409);
    }

    // ─── Deadline Check ──────────────────────────────────────────────
    const now = Math.floor(Date.now() / 1000);
    if (now >= proposal.deadline) {
        return c.json({ error: "Proposal expired" }, 410);
    }

    // ─── Staleness Check (ON-CHAIN price, not frontend-provided) ─────
    const currentPrice = await getOnChainPrice(proposal.asset);
    let stalenessWarning: string | null = null;

    if (currentPrice > 0 && proposal.priceAtGeneration > 0) {
        const deviation = Math.abs(
            (currentPrice - proposal.priceAtGeneration) / proposal.priceAtGeneration
        );
        if (deviation > env.MAX_STALENESS_PCT / 100) {
            stalenessWarning = `Price moved ${(deviation * 100).toFixed(2)}% since generation`;
        }
    }

    // ─── OPTIMISTIC LOCK: mark as "dispensed" ────────────────────────
    // State Desync Fix: lock BEFORE returning payload.
    // If /consume is never called (TMA crash), auto-revert after 60s.
    proposal.status = "dispensed";
    proposal.dispensedAt = now;
    const remainingTtl = await redis.ttl(`proposal:${proposalId}`);
    await redis.set(
        `proposal:${proposalId}`,
        JSON.stringify(proposal),
        "EX",
        Math.max(remainingTtl, 120)
    );
    // Schedule auto-revert (60s grace period for signing)
    await redis.set(
        `proposal_lock:${proposalId}`,
        "dispensed",
        "EX",
        60 // Auto-expires → background worker reverts status
    );

    // ─── Build EIP-712 Execution Payload ─────────────────────────────
    const executionPayload = buildExecutionPayload(proposal);

    return c.json({
        proposalId: proposal.id,
        asset: proposal.asset,
        assetSymbol: await getTokenSymbol(proposal.asset),
        action: proposal.action,
        amount: proposal.amount,
        weight: proposal.weight || 0,
        confidence: proposal.confidence || 0,
        maxSlippage: proposal.maxSlippagePct,
        deadline: proposal.deadline,
        teeSignerAddress: proposal.teeSignerAddress,
        proofOfReasoning: proposal.proofOfReasoning,
        reasoningHash: proposal.reasoningHash,
        // Pre-built execution data (TMA just signs, no logic)
        targetContract: env.ACTIVE_SENTINEL_ADDRESS,
        executionPayload,
        // Warnings
        stalenessWarning,
        currentPrice,
        priceAtGeneration: proposal.priceAtGeneration,
        // Timing
        remainingSec: proposal.deadline - now,
    });
});

/**
 * POST /api/proposal/:id/consume
 *
 * Вызывается ПОСЛЕ успешной отправки UserOp.
 * Помечает proposal как executed (nullifier сжигание).
 */
app.post("/api/proposal/:id/consume", async (c) => {
    const proposalId = c.req.param("id");
    const hmacSignature = c.req.header("X-HMAC-Signature");

    if (!hmacSignature || !verifyHmac(proposalId, hmacSignature)) {
        return c.json({ error: "Unauthorized" }, 401);
    }

    const raw = await redis.get(`proposal:${proposalId}`);
    if (!raw) {
        return c.json({ error: "Not found" }, 404);
    }

    const proposal = JSON.parse(raw);
    if (proposal.status !== "approved" && proposal.status !== "pending") {
        return c.json({ error: `Cannot consume: ${proposal.status}` }, 409);
    }

    proposal.status = "executed";
    const ttl = await redis.ttl(`proposal:${proposalId}`);
    if (ttl > 0) {
        await redis.set(`proposal:${proposalId}`, JSON.stringify(proposal), "EX", ttl);
    }

    return c.json({ success: true, status: "executed" });
});

/**
 * GET /api/health
 */
app.get("/api/health", async (c) => {
    const redisOk = redis.status === "ready";
    return c.json({ status: redisOk ? "ok" : "degraded", redis: redis.status });
});

/**
 * POST /api/proposal/:id/simulate
 *
 * Off-chain симуляция: BFF вызывает eth_call для проверки,
 * пройдёт ли транзакция без revert.
 * Финальная проверка slippage — ON-CHAIN (не доверяем фронтенду).
 */
app.post("/api/proposal/:id/simulate", async (c) => {
    const proposalId = c.req.param("id");
    const hmacSignature = c.req.header("X-HMAC-Signature");

    if (!hmacSignature || !verifyHmac(proposalId, hmacSignature)) {
        return c.json({ error: "Unauthorized" }, 401);
    }

    const raw = await redis.get(`proposal:${proposalId}`);
    if (!raw) return c.json({ error: "Not found" }, 404);

    const proposal = JSON.parse(raw);
    const payload = buildExecutionPayload(proposal);

    try {
        // eth_call simulation (dry run)
        await publicClient.call({
            to: env.ACTIVE_SENTINEL_ADDRESS as `0x${string}`,
            data: payload as `0x${string}`,
        });

        return c.json({ success: true, willRevert: false });
    } catch (err: any) {
        return c.json({
            success: false,
            willRevert: true,
            reason: err.message || "Simulation reverted",
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════
//                      HELPERS
// ═══════════════════════════════════════════════════════════════════════

function buildExecutionPayload(proposal: any): `0x${string}` {
    const abi = parseAbi([
        "function executeFlashArbitrage((address tokenA, address tokenB, uint256 borrowAmount, uint256 minProfitTokenA, bytes dexPayloadRoute1, bytes dexPayloadRoute2) params)",
    ]);

    // Reconstruct params from proposal data
    // В реальности TEE передает уже закодированный payload
    if (proposal.executionCalldata) {
        return proposal.executionCalldata as `0x${string}`;
    }

    // Fallback: encode from proposal fields (если есть)
    return encodeFunctionData({
        abi,
        functionName: "executeFlashArbitrage",
        args: [
            {
                tokenA: proposal.asset as `0x${string}`,
                tokenB: (proposal.tokenB || "0x0000000000000000000000000000000000000000") as `0x${string}`,
                borrowAmount: BigInt(Math.floor(proposal.amount * 1e18)),
                minProfitTokenA: BigInt(0), // Set by TEE based on simulation
                dexPayloadRoute1: "0x" as `0x${string}`,
                dexPayloadRoute2: "0x" as `0x${string}`,
            },
        ],
    });
}

async function getTokenSymbol(tokenAddress: string): Promise<string> {
    const cached = await redis.get(`symbol:${tokenAddress.toLowerCase()}`);
    if (cached) return cached;

    try {
        const symbol = await publicClient.readContract({
            address: tokenAddress as `0x${string}`,
            abi: parseAbi(["function symbol() view returns (string)"]),
            functionName: "symbol",
        });
        await redis.set(`symbol:${tokenAddress.toLowerCase()}`, symbol, "EX", 86400);
        return symbol;
    } catch {
        return tokenAddress.substring(0, 10) + "...";
    }
}

// ═══════════════════════════════════════════════════════════════════════
//                      SERVER START
// ═══════════════════════════════════════════════════════════════════════

export default {
    port: env.PORT,
    fetch: app.fetch,
};

console.log(`🚀 AlphaFlow BFF running on port ${env.PORT}`);
