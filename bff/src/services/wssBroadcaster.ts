// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — bff/src/services/wssBroadcaster.ts
// WebSocket Server + Redis Streams consumer (XREAD BLOCK)
//
// АРХИТЕКТУРА:
//   Redis Stream "agent_insights" → XREAD BLOCK 0 → Parse JSON → Broadcast WSS
//
// БЕЗОПАСНОСТЬ:
//   - JWT verification на этапе HTTP Upgrade (handshake)
//   - Token из Authorization header или ?token= query param
//   - Отказ → 401 Unauthorized, соединение НЕ устанавливается
//
// HEARTBEAT:
//   - Ping каждые 30s, клиенты без pong помечаются dead → terminate
//   - Предотвращает memory leak от zombie connections
// ═══════════════════════════════════════════════════════════════════════════════

import { WebSocketServer, WebSocket } from "ws";
import { Redis } from "ioredis";
import jwt from "jsonwebtoken";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

// ─── Configuration ────────────────────────────────────────────────────────────

const STREAM_KEY = "agent_insights";
const JWT_SECRET = process.env["JWT_SECRET"] ?? process.env["HMAC_SECRET"] ?? "";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const HEARTBEAT_INTERVAL_MS = 30_000;

if (!JWT_SECRET) {
    console.warn("[WSS] WARNING: JWT_SECRET not set — WebSocket auth will reject all tokens");
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface AliveWebSocket extends WebSocket {
    isAlive: boolean;
}

// ─── State ────────────────────────────────────────────────────────────────────

let wss: WebSocketServer | null = null;
let streamReader: Redis | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let abortController: AbortController | null = null;

// ─── JWT Verification ─────────────────────────────────────────────────────────

/**
 * Verify JWT token from the upgrade request.
 * Extracts from Authorization: Bearer <token> OR ?token=<token> query param.
 * Returns decoded payload on success, null on failure.
 */
function verifyJwt(req: IncomingMessage): Record<string, unknown> | null {
    let token: string | null = null;

    // 1. Try Authorization header
    const authHeader = req.headers["authorization"];
    if (authHeader?.startsWith("Bearer ")) {
        token = authHeader.slice(7);
    }

    // 2. Fallback to ?token= query parameter
    if (!token) {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        token = url.searchParams.get("token");
    }

    if (!token) return null;

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (typeof decoded === "string") return { sub: decoded };
        return decoded as Record<string, unknown>;
    } catch {
        return null;
    }
}

// ─── WebSocket Server Setup ──────────────────────────────────────────────────

/**
 * Attach WSS to an existing HTTP server (Hono @hono/node-server).
 * Handles upgrade at path '/ws' with JWT verification.
 */
export function attachWebSocketServer(server: { on: Function }): void {
    wss = new WebSocketServer({ noServer: true });

    // ─── HTTP Upgrade Handler (JWT gate) ─────────────────────────────────
    server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

        // Only handle /ws path
        if (url.pathname !== "/ws") {
            socket.destroy();
            return;
        }

        // ─── JWT Verification ────────────────────────────────────────────
        const payload = verifyJwt(req);
        if (!payload) {
            socket.write(
                "HTTP/1.1 401 Unauthorized\r\n" +
                "Connection: close\r\n" +
                "Content-Type: text/plain\r\n" +
                "\r\n" +
                "Invalid or missing JWT token"
            );
            socket.destroy();
            console.warn("[WSS] Rejected upgrade — JWT verification failed");
            return;
        }

        // ─── Upgrade connection ──────────────────────────────────────────
        wss!.handleUpgrade(req, socket, head, (ws) => {
            wss!.emit("connection", ws, req, payload);
        });
    });

    // ─── Connection handler ──────────────────────────────────────────────
    wss.on("connection", (ws: AliveWebSocket, _req: IncomingMessage, payload: Record<string, unknown>) => {
        ws.isAlive = true;

        ws.on("pong", () => {
            ws.isAlive = true;
        });

        ws.on("error", (err) => {
            console.error("[WSS] Client error:", err.message);
        });

        console.log(`[WSS] Client connected | sub=${payload["sub"] ?? "unknown"} | total=${wss!.clients.size}`);

        // Send welcome message
        ws.send(JSON.stringify({
            type: "connected",
            timestamp: Math.floor(Date.now() / 1000),
            message: "AlphaFlow WSS — streaming agent_insights",
        }));
    });

    // ─── Heartbeat (ping/pong) — 30s interval ────────────────────────────
    heartbeatTimer = setInterval(() => {
        if (!wss) return;

        wss.clients.forEach((ws) => {
            const aliveWs = ws as AliveWebSocket;
            if (!aliveWs.isAlive) {
                console.log("[WSS] Terminating dead client (no pong)");
                aliveWs.terminate();
                return;
            }
            aliveWs.isAlive = false;
            aliveWs.ping();
        });
    }, HEARTBEAT_INTERVAL_MS);

    // ─── Start Redis Stream consumer ─────────────────────────────────────
    startStreamConsumer();

    console.log(`[WSS] WebSocket server attached at /ws | heartbeat=${HEARTBEAT_INTERVAL_MS}ms`);
}

// ─── Redis Stream Consumer (XREAD BLOCK) ─────────────────────────────────────

/**
 * Asynchronous loop: XREAD BLOCK 0 STREAMS agent_insights $
 * On new entry → parse JSON payload → broadcast to all WSS clients.
 *
 * Uses a dedicated Redis connection (separate from BFF's main client)
 * because XREAD BLOCK holds the connection.
 */
async function startStreamConsumer(): Promise<void> {
    abortController = new AbortController();

    streamReader = new Redis(REDIS_URL, {
        maxRetriesPerRequest: null, // Required for blocking reads
        retryStrategy(times: number): number | null {
            if (times > 20) return null;
            return Math.min(times * 500, 10_000);
        },
        lazyConnect: false,
    });

    streamReader.on("error", (err: Error) => {
        console.error("[WSS:XREAD] Redis error:", err.message);
    });

    streamReader.on("connect", () => {
        console.log("[WSS:XREAD] Redis stream reader connected");
    });

    // Start reading from the latest entry ($ = only new messages)
    let lastId = "$";

    const loop = async () => {
        while (!abortController?.signal.aborted) {
            try {
                // XREAD BLOCK 0 — blocks indefinitely until new data
                const results = await streamReader!.xread(
                    "BLOCK",
                    0, // Block indefinitely
                    "STREAMS",
                    STREAM_KEY,
                    lastId
                );

                if (!results || results.length === 0) continue;

                for (const [_streamName, entries] of results) {
                    for (const [entryId, fields] of entries) {
                        lastId = entryId;

                        // fields is [key1, val1, key2, val2, ...]
                        const payloadIdx = fields.indexOf("payload");
                        if (payloadIdx === -1 || payloadIdx + 1 >= fields.length) {
                            console.warn(`[WSS:XREAD] Entry ${entryId} missing 'payload' field`);
                            continue;
                        }

                        const rawPayload = fields[payloadIdx + 1];

                        // Parse and validate JSON
                        let parsed: unknown;
                        try {
                            parsed = JSON.parse(rawPayload!);
                        } catch {
                            console.error(`[WSS:XREAD] Invalid JSON in entry ${entryId}`);
                            continue;
                        }

                        // Broadcast to all connected clients
                        broadcastToClients({
                            type: "insight",
                            streamId: entryId,
                            data: parsed,
                            timestamp: Math.floor(Date.now() / 1000),
                        });
                    }
                }
            } catch (err: any) {
                // If Redis disconnected or abort signal — exit loop
                if (abortController?.signal.aborted) break;
                if (err.message?.includes("Connection is closed")) {
                    console.error("[WSS:XREAD] Redis connection closed, waiting 2s before retry...");
                    await sleep(2000);
                    continue;
                }
                console.error("[WSS:XREAD] Error:", err.message);
                await sleep(1000);
            }
        }
    };

    // Fire-and-forget (runs in background)
    loop().catch((err) => {
        console.error("[WSS:XREAD] Fatal loop error:", err);
    });
}

// ─── Broadcast ───────────────────────────────────────────────────────────────

/**
 * Send a message to all connected WebSocket clients.
 * Silently skips clients in non-OPEN state.
 */
function broadcastToClients(message: Record<string, unknown>): void {
    if (!wss || wss.clients.size === 0) return;

    const serialized = JSON.stringify(message);
    let sent = 0;

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(serialized);
            sent++;
        }
    });

    console.log(
        `[WSS] Broadcast insight | streamId=${message["streamId"]} | clients=${sent}/${wss.clients.size}`
    );
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────

/**
 * Graceful shutdown: stop heartbeat, disconnect stream reader, close WSS.
 */
export async function shutdownWss(): Promise<void> {
    console.log("[WSS] Shutting down...");

    // Signal abort to XREAD loop
    abortController?.abort();

    // Stop heartbeat
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }

    // Close all client connections
    if (wss) {
        wss.clients.forEach((client) => {
            client.close(1001, "Server shutting down");
        });
        wss.close();
        wss = null;
    }

    // Disconnect stream reader
    if (streamReader) {
        streamReader.disconnect();
        streamReader = null;
    }

    console.log("[WSS] Shutdown complete");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
