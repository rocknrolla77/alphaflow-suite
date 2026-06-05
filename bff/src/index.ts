// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — bff/src/index.ts
// Hono API Server — Backend-for-Frontend
//
// Обязанности:
// 1. HMAC verification (timing-safe, secret на сервере)
// 2. Optimistic locking (Redis SETNX + TTL 60s)
// 3. Staleness check (on-chain price via viem, не от клиента)
// 4. EIP-712 payload assembly для TMA
// 5. Nullifier consumption (double-spend protection)
//
// ИНВАРИАНТ: BFF НЕ хранит приватных ключей.
// Он ТОЛЬКО верифицирует, проксирует и координирует состояние.
// ═══════════════════════════════════════════════════════════════════════════════

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { z } from "zod";

import {
    verifyHmac,
    getAndLockProposal,
    consumeProposal,
    redisHealthCheck,
    shutdownRedis,
} from "./services/proposalService.js";

import {
    checkPriceStaleness,
    simulateTransaction,
    rpcHealthCheck,
} from "./services/onChainOracle.js";

import type { Address } from "viem";

import {
    startReputationBatcher,
    stopReputationBatcher,
} from "./services/reputationBatcher.js";

import {
    attachWebSocketServer,
    shutdownWss,
} from "./services/wssBroadcaster.js";

// ─── App Configuration ────────────────────────────────────────────────────────

const PORT = parseInt(process.env["PORT"] ?? "3001", 10);
const ALLOWED_ORIGINS = (process.env["ALLOWED_ORIGINS"] ?? "http://localhost:5173,http://localhost:4173,https://alphaflow.vercel.app").split(",");

// Default DEX pair address for staleness checks (configurable per proposal)
const DEFAULT_PAIR_ADDRESS = (process.env["DEFAULT_PAIR_ADDRESS"] ?? "0x0000000000000000000000000000000000000000") as Address;

// ─── Hono App ─────────────────────────────────────────────────────────────────

const app = new Hono();

// ─── Global Middleware ────────────────────────────────────────────────────────

app.use("*", logger());

app.use("/api/*", cors({
    origin: ALLOWED_ORIGINS,
    allowHeaders: ["Content-Type", "x-hmac-signature"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    maxAge: 3600,
}));

// ─── HMAC Verification Middleware ─────────────────────────────────────────────

/**
 * Middleware: верифицирует HMAC-SHA256 подпись proposalId.
 *
 * Header: x-hmac-signature: <hex_encoded_hmac>
 *
 * БЕЗОПАСНОСТЬ:
 * - HMAC_SECRET живёт ТОЛЬКО на BFF (env var)
 * - timingSafeEqual предотвращает timing oracle
 * - Клиент получает одноразовую подпись через Telegram deep link
 * - Клиент НЕ МОЖЕТ генерировать новые подписи
 */
app.use("/api/proposal/:id", async (c, next) => {
    const proposalId = c.req.param("id");
    const signature = c.req.header("x-hmac-signature");

    if (!signature) {
        return c.json(
            { error: "Missing x-hmac-signature header", code: "HMAC_MISSING" },
            401
        );
    }

    if (!proposalId) {
        return c.json(
            { error: "Missing proposal ID", code: "ID_MISSING" },
            400
        );
    }

    // Timing-safe HMAC verification
    const isValid = verifyHmac(proposalId, signature);
    if (!isValid) {
        console.warn(`[BFF] HMAC verification FAILED for proposal: ${proposalId}`);
        return c.json(
            { error: "Invalid HMAC signature", code: "HMAC_INVALID" },
            401
        );
    }

    return await next();
});

// Отдельно для /consume (тот же HMAC middleware)
app.use("/api/proposal/:id/consume", async (c, next) => {
    const proposalId = c.req.param("id");
    const signature = c.req.header("x-hmac-signature");

    if (!signature || !proposalId) {
        return c.json({ error: "Missing HMAC credentials", code: "HMAC_MISSING" }, 401);
    }

    if (!verifyHmac(proposalId, signature)) {
        return c.json({ error: "Invalid HMAC signature", code: "HMAC_INVALID" }, 401);
    }

    return await next();
});

// Also protect /simulate
app.use("/api/proposal/:id/simulate", async (c, next) => {
    const proposalId = c.req.param("id");
    const signature = c.req.header("x-hmac-signature");

    if (!signature || !proposalId) {
        return c.json({ error: "Missing HMAC credentials", code: "HMAC_MISSING" }, 401);
    }

    if (!verifyHmac(proposalId, signature)) {
        return c.json({ error: "Invalid HMAC signature", code: "HMAC_INVALID" }, 401);
    }

    return await next();
});

// ═══════════════════════════════════════════════════════════════════════════════
//                              ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /api/proposal/:id ────────────────────────────────────────────────────

/**
 * Извлекает Proposal, устанавливает optimistic lock, проверяет staleness.
 *
 * Flow:
 * 1. HMAC verified (middleware)
 * 2. Redis: fetch + lock (60s TTL)
 * 3. On-chain: staleness check (if pair address available)
 * 4. Return: Proposal + EIP-712 payload
 *
 * HTTP Responses:
 * - 200: OK — proposal + payload
 * - 401: HMAC invalid
 * - 404: Proposal not found
 * - 409: Staleness exceeded / already consumed
 * - 410: Proposal expired
 * - 423: Locked by another session
 * - 500: Internal error
 */
app.get("/api/proposal/:id", async (c) => {
    const proposalId = c.req.param("id");

    // ─── Step 1: Fetch + Lock ────────────────────────────────────────────
    const result = await getAndLockProposal(proposalId);

    if (!result.success || !result.proposal) {
        return c.json(
            { error: result.error, code: "PROPOSAL_UNAVAILABLE" },
            result.httpStatus as 404 | 409 | 410 | 423 | 500
        );
    }

    const proposal = result.proposal;

    // ─── Step 2: Staleness Check (on-chain price) ────────────────────────
    // Используем pair address из env или из proposal metadata
    const pairAddress = DEFAULT_PAIR_ADDRESS;
    const maxSlippageBps = proposal.maxSlippageBps ?? 200; // Default 2%

    // Only check if pair address is configured (non-zero)
    if (pairAddress !== "0x0000000000000000000000000000000000000000") {
        try {
            const priceCheck = await checkPriceStaleness(
                pairAddress,
                proposal.priceAtGeneration ?? null,
                maxSlippageBps
            );

            if (priceCheck.isStale) {
                // Price moved too much — reject to protect user
                return c.json({
                    error: "Price staleness exceeded threshold",
                    code: "PRICE_STALE",
                    details: {
                        currentPrice: priceCheck.currentPrice,
                        generationPrice: priceCheck.generationPrice,
                        deviationBps: priceCheck.deviationBps,
                        maxAllowedBps: maxSlippageBps,
                    },
                }, 409);
            }
        } catch (err) {
            // Log but don't block — RPC failure shouldn't prevent legitimate actions
            console.warn("[BFF] Staleness check failed (RPC issue), proceeding:", err);
        }
    }

    // ─── Step 3: Assemble EIP-712 Payload ────────────────────────────────
    const eip712Payload = {
        domain: {
            name: "AlphaFlow_TEE",
            version: "1",
            chainId: 5000,
        },
        types: {
            Proposal: [
                { name: "asset", type: "address" },
                { name: "action", type: "string" },
                { name: "recommendedAmount", type: "uint256" },
                { name: "nonce", type: "uint256" },
                { name: "deadline", type: "uint256" },
                { name: "reasoningHash", type: "bytes32" },
            ],
        },
        primaryType: "Proposal" as const,
        message: {
            asset: proposal.asset,
            action: proposal.action,
            recommendedAmount: proposal.recommendedAmount,
            nonce: proposal.nonce,
            deadline: proposal.deadline,
            reasoningHash: proposal.reasoningHash,
        },
    };

    return c.json({
        proposal: {
            id: proposalId,
            asset: proposal.asset,
            assetSymbol: proposal.assetSymbol ?? "UNKNOWN",
            action: proposal.action,
            recommendedAmount: proposal.recommendedAmount,
            nonce: proposal.nonce,
            deadline: proposal.deadline,
            reasoningHash: proposal.reasoningHash,
            signature: proposal.signature,
            signerAddress: proposal.signerAddress,
            generatedAt: proposal.generatedAt,
        },
        eip712Payload,
        lockExpiresAt: Math.floor(Date.now() / 1000) + 60,
    }, 200);
});

// ─── POST /api/proposal/:id/consume ───────────────────────────────────────────

/**
 * Burns the Proposal nullifier — marks as permanently used.
 *
 * Called by:
 * 1. TMA frontend after successful UserOp submission
 * 2. OnChainWatcher when FlashArbitrageExecuted event detected
 *
 * Idempotent: calling twice returns 200 (not error).
 *
 * HTTP Responses:
 * - 200: OK — consumed (or already consumed)
 * - 401: HMAC invalid
 * - 404: Proposal not found
 * - 500: Internal error
 */
app.post("/api/proposal/:id/consume", async (c) => {
    const proposalId = c.req.param("id");

    const result = await consumeProposal(proposalId);

    if (!result.success) {
        return c.json(
            { error: result.error, code: "CONSUME_FAILED" },
            result.httpStatus as 404 | 500
        );
    }

    return c.json({
        consumed: true,
        proposalId,
        reasoningHash: result.proposal?.reasoningHash,
        consumedAt: Math.floor(Date.now() / 1000),
    }, 200);
});

// ─── POST /api/proposal/:id/simulate ──────────────────────────────────────────

/**
 * Dry-run simulation via eth_call.
 * Detects reverts BEFORE submitting real UserOp.
 *
 * Body: { to: address, data: hex calldata }
 */

const SimulateBodySchema = z.object({
    to: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    data: z.string().regex(/^0x[a-fA-F0-9]*$/),
});

app.post("/api/proposal/:id/simulate", async (c) => {
    const body: unknown = await c.req.json();

    const parsed = SimulateBodySchema.safeParse(body);
    if (!parsed.success) {
        return c.json({
            error: "Invalid request body",
            code: "VALIDATION_ERROR",
            details: parsed.error.issues,
        }, 400);
    }

    const { to, data } = parsed.data;

    const simulation = await simulateTransaction(
        to as Address,
        data as `0x${string}`
    );

    if (!simulation.success) {
        return c.json({
            success: false,
            error: simulation.error,
            code: "SIMULATION_REVERTED",
        }, 200); // 200 because the request itself succeeded; the simulation result is "revert"
    }

    return c.json({
        success: true,
        result: simulation.result,
        simulatedAt: Math.floor(Date.now() / 1000),
    }, 200);
});

// ─── GET /api/health ──────────────────────────────────────────────────────────

/**
 * System health check — Redis + RPC status.
 * No HMAC required (public endpoint for monitoring).
 */
app.get("/api/health", async (c) => {
    const [redisOk, rpcStatus] = await Promise.all([
        redisHealthCheck(),
        rpcHealthCheck(),
    ]);

    const healthy = redisOk && rpcStatus.healthy;

    return c.json({
        status: healthy ? "healthy" : "degraded",
        components: {
            redis: redisOk ? "up" : "down",
            rpc: rpcStatus.healthy ? "up" : "down",
            rpcBlockNumber: rpcStatus.blockNumber?.toString() ?? null,
        },
        uptime: process.uptime(),
        timestamp: Math.floor(Date.now() / 1000),
    }, healthy ? 200 : 503);
});

// ═══════════════════════════════════════════════════════════════════════════════
//                        SWARM ECONOMY ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /api/swarm/balances ──────────────────────────────────────────────────

/**
 * Public endpoint: returns Dispatcher pool balance + worker balances.
 * Used by frontend SwarmMetrics panel (polled every 10s).
 * No auth required (Observer Mode).
 */
app.get("/api/swarm/balances", async (c) => {
    try {
        const { createPublicClient, http, formatEther } = await import("viem");
        const { mantle } = await import("viem/chains");

        const rpcUrl = process.env["MANTLE_RPC_PRIMARY"] ?? "https://rpc.mantle.xyz";
        const client = createPublicClient({
            chain: mantle,
            transport: http(rpcUrl),
        });

        const dispatcherAddress = process.env["DISPATCHER_ADDRESS"] as `0x${string}` | undefined;
        const worker1 = process.env["WORKER_1_ADDRESS"] as `0x${string}` | undefined;
        const worker2 = process.env["WORKER_2_ADDRESS"] as `0x${string}` | undefined;
        const worker3 = process.env["WORKER_3_ADDRESS"] as `0x${string}` | undefined;

        // Fetch balances in parallel
        const addresses = [dispatcherAddress, worker1, worker2, worker3].filter(Boolean) as `0x${string}`[];

        const balances = await Promise.all(
            addresses.map((addr) => client.getBalance({ address: addr }).catch(() => 0n))
        );

        const [dispBal, w1Bal, w2Bal, w3Bal] = balances;

        return c.json({
            dispatcherBalance: formatEther(dispBal ?? 0n),
            workers: [
                { id: "byreal-worker-1", address: worker1 ?? "0x???", balance: formatEther(w1Bal ?? 0n), relayCount: 0 },
                { id: "byreal-worker-2", address: worker2 ?? "0x???", balance: formatEther(w2Bal ?? 0n), relayCount: 0 },
                { id: "byreal-worker-3", address: worker3 ?? "0x???", balance: formatEther(w3Bal ?? 0n), relayCount: 0 },
            ],
            timestamp: Math.floor(Date.now() / 1000),
        }, 200);
    } catch (err) {
        console.error("[BFF] /api/swarm/balances error:", err);
        return c.json({
            dispatcherBalance: "—",
            workers: [
                { id: "byreal-worker-1", address: "0x???", balance: "—", relayCount: 0 },
                { id: "byreal-worker-2", address: "0x???", balance: "—", relayCount: 0 },
                { id: "byreal-worker-3", address: "0x???", balance: "—", relayCount: 0 },
            ],
            error: "RPC unavailable",
            timestamp: Math.floor(Date.now() / 1000),
        }, 200);
    }
});

// ─── 404 Fallback ─────────────────────────────────────────────────────────

app.notFound((c) => {
    return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
});

// ─── Global Error Handler ─────────────────────────────────────────────────────

app.onError((err, c) => {
    console.error("[BFF] Unhandled error:", err);
    return c.json({
        error: "Internal server error",
        code: "INTERNAL_ERROR",
        message: process.env["NODE_ENV"] === "development" ? err.message : undefined,
    }, 500);
});

// ─── Server Bootstrap ─────────────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════════════════════");
console.log("  AlphaFlow Suite — BFF (Backend-for-Frontend)");
console.log("═══════════════════════════════════════════════════════════════");
console.log(`[BFF] Port: ${PORT}`);
console.log(`[BFF] CORS origins: ${ALLOWED_ORIGINS.join(", ")}`);
console.log(`[BFF] HMAC_SECRET: ${"*".repeat(8)} (loaded)`);

const server = serve({
    fetch: app.fetch,
    port: PORT,
}, (info) => {
    console.log(`[BFF] Server listening on http://0.0.0.0:${info.port}`);

    // ─── Attach WebSocket Server (WSS + Redis Streams consumer) ──────────
    attachWebSocketServer(server);
    console.log(`[BFF] WSS attached at ws://0.0.0.0:${info.port}/ws`);

    // ─── Start Reputation Batcher Daemon ──────────────────────────────────
    // Агрегирует голоса из Redis и отправляет batch tx в ReputationRegistry.
    // Запускается только если переменные окружения настроены.
    if (
        process.env["RELAYER_PRIVATE_KEY"] &&
        process.env["REPUTATION_REGISTRY_ADDRESS"]
    ) {
        startReputationBatcher();
    } else {
        console.warn(
            "[BFF] ReputationBatcher DISABLED " +
            "(RELAYER_PRIVATE_KEY or REPUTATION_REGISTRY_ADDRESS not set)"
        );
    }
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

const shutdown = async (): Promise<void> => {
    console.log("\n[BFF] Shutting down gracefully...");
    await shutdownWss();
    await stopReputationBatcher();
    await shutdownRedis();
    console.log("[BFF] All services stopped. Bye.");
    process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export { app };
