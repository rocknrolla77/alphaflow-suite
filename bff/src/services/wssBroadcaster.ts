// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — bff/src/services/wssBroadcaster.ts
// WebSocket Server + Redis Streams consumer (XREAD BLOCK)
//
// Phase 3 PIVOT: Observer Mode — PUBLIC WebSocket (no JWT required)
//
// АРХИТЕКТУРА:
//   Redis Stream "agent_insights" → XREAD BLOCK 0 → Parse JSON → Broadcast WSS
//
// HEARTBEAT:
//   - Ping каждые 30s, клиенты без pong помечаются dead → terminate
//   - Предотвращает memory leak от zombie connections
// ═══════════════════════════════════════════════════════════════════════════════

import { WebSocketServer, WebSocket } from "ws";
import { Redis } from "ioredis";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

// ─── Configuration ────────────────────────────────────────────────────────────

const STREAM_KEY = "agent_insights";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const HEARTBEAT_INTERVAL_MS = 30_000;

// ─── Types ────────────────────────────────────────────────────────────────────

interface AliveWebSocket extends WebSocket {
    isAlive: boolean;
}

// ─── State ────────────────────────────────────────────────────────────────────

let wss: WebSocketServer | null = null;
let streamReader: Redis | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let abortController: AbortController | null = null;

// ─── WebSocket Server Setup ──────────────────────────────────────────────────

/**
 * Attach WSS to an existing HTTP server (Hono @hono/node-server).
 * Phase 3: PUBLIC access — no JWT required. Observer Mode.
 */
export function attachWebSocketServer(server: { on: Function }): void {
    wss = new WebSocketServer({ noServer: true });

    // ─── HTTP Upgrade Handler (PUBLIC — no auth) ─────────────────────────
    server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

        // Only handle /ws path
        if (url.pathname !== "/ws") {
            socket.destroy();
            return;
        }

        // Observer Mode: accept all connections (no JWT gate)
        wss!.handleUpgrade(req, socket, head, (ws) => {
            wss!.emit("connection", ws, req);
        });
    });

    // ─── Connection handler ──────────────────────────────────────────────
    wss.on("connection", (ws: AliveWebSocket, _req: IncomingMessage) => {
        ws.isAlive = true;

        ws.on("pong", () => {
            ws.isAlive = true;
        });

        ws.on("error", (err) => {
            console.error("[WSS] Client error:", err.message);
        });

        console.log(`[WSS] Observer connected | total=${wss!.clients.size}`);

        // Send welcome message
        ws.send(JSON.stringify({
            type: "connected",
            timestamp: Math.floor(Date.now() / 1000),
            message: "AlphaFlow WSS — Observer Mode (streaming agent_insights)",
            mode: "observer",
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

    console.log(`[WSS] WebSocket server attached at /ws (PUBLIC Observer Mode) | heartbeat=${HEARTBEAT_INTERVAL_MS}ms`);
}

// ─── Redis Stream Consumer (XREAD BLOCK) ─────────────────────────────────────

async function startStreamConsumer(): Promise<void> {
    abortController = new AbortController();

    streamReader = new Redis(REDIS_URL, {
        maxRetriesPerRequest: null,
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

    let lastId = "$";

    const loop = async () => {
        while (!abortController?.signal.aborted) {
            try {
                const results = await streamReader!.xread(
                    "BLOCK", 0,
                    "STREAMS", STREAM_KEY, lastId
                );

                if (!results || results.length === 0) continue;

                for (const [_streamName, entries] of results) {
                    for (const [entryId, fields] of entries) {
                        lastId = entryId;

                        const payloadIdx = fields.indexOf("payload");
                        if (payloadIdx === -1 || payloadIdx + 1 >= fields.length) {
                            console.warn(`[WSS:XREAD] Entry ${entryId} missing 'payload' field`);
                            continue;
                        }

                        const rawPayload = fields[payloadIdx + 1];

                        let parsed: unknown;
                        try {
                            parsed = JSON.parse(rawPayload!);
                        } catch {
                            console.error(`[WSS:XREAD] Invalid JSON in entry ${entryId}`);
                            continue;
                        }

                        broadcastToClients({
                            type: "insight",
                            streamId: entryId,
                            data: parsed,
                            timestamp: Math.floor(Date.now() / 1000),
                        });
                    }
                }
            } catch (err: any) {
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

    loop().catch((err) => {
        console.error("[WSS:XREAD] Fatal loop error:", err);
    });
}

// ─── Broadcast ───────────────────────────────────────────────────────────────

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

export async function shutdownWss(): Promise<void> {
    console.log("[WSS] Shutting down...");

    abortController?.abort();

    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }

    if (wss) {
        wss.clients.forEach((client) => {
            client.close(1001, "Server shutting down");
        });
        wss.close();
        wss = null;
    }

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
