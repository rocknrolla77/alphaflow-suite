// Файл: agent-tee/src/main.ts
// TEE Agent Entry Point — Phala DStack CVM Runtime
// Orchestrates: Nansen MCP → Strategy → Attestation → Publish

import { PhalaAttestationService } from "./services/remoteAttestation";
import { ProposalPublisher } from "./services/proposalPublisher";

// ═══════════════════════════════════════════════════════════════════════
//                    TEE AGENT MAIN LOOP
// ═══════════════════════════════════════════════════════════════════════

async function main() {
    console.log("═══════════════════════════════════════════════════════");
    console.log("  AlphaFlow TEE Agent — Phala DStack CVM");
    console.log("  Platform: " + (process.env.DSTACK_SIMULATOR_ENDPOINT ? "SIMULATED" : "PRODUCTION"));
    console.log("═══════════════════════════════════════════════════════");

    // ─── 1. Generate Startup Attestation ──────────────────────────────
    const attestation = new PhalaAttestationService(
        process.env.DSTACK_SIMULATOR_ENDPOINT || "http://localhost:8090"
    );

    const startupReportData = attestation.buildReportData(
        "0x" + "00".repeat(32), // Empty hash for startup
        process.env.TEE_SIGNER_ADDRESS || "0x" + "00".repeat(20),
        0
    );

    const startupQuote = await attestation.generateQuote(startupReportData);
    console.log(`[Attestation] MRENCLAVE: ${startupQuote.mrenclave}`);
    console.log(`[Attestation] Platform: ${startupQuote.platform}`);
    console.log(`[Attestation] Quote generated at: ${new Date(startupQuote.timestamp * 1000).toISOString()}`);

    // ─── 2. Start Health Server ───────────────────────────────────────
    const server = Bun?.serve?.({
        port: 8080,
        fetch(req: Request) {
            const url = new URL(req.url);
            if (url.pathname === "/health") {
                return new Response(JSON.stringify({
                    status: "healthy",
                    mrenclave: startupQuote.mrenclave,
                    platform: startupQuote.platform,
                    uptime: process.uptime(),
                }), { headers: { "Content-Type": "application/json" } });
            }
            if (url.pathname === "/attestation") {
                return new Response(JSON.stringify(startupQuote), {
                    headers: { "Content-Type": "application/json" },
                });
            }
            return new Response("Not Found", { status: 404 });
        },
    }) || startHttpServer();

    console.log("[Health] Server listening on :8080");

    // ─── 3. Main Strategy Loop ────────────────────────────────────────
    console.log("[Agent] Starting strategy loop (interval: 30s)...");

    // TODO: Initialize NansenMCPClient, YieldArchitect, SentinelExecutor
    // For now: placeholder loop demonstrating TEE lifecycle
    setInterval(async () => {
        try {
            // In production:
            // 1. Fetch smart money signals from Nansen MCP
            // 2. Run YieldArchitect.generateProposal()
            // 3. Attach Remote Attestation to proposal
            // 4. Publish to Redis for TG Bot
            console.log(`[Agent] Heartbeat: ${new Date().toISOString()}`);
        } catch (err) {
            console.error("[Agent] Strategy loop error:", (err as Error).message);
        }
    }, 30_000);
}

/**
 * Fallback HTTP server when not running on Bun (Node.js + tsx)
 */
function startHttpServer() {
    const http = require("http");
    const server = http.createServer((req: any, res: any) => {
        if (req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "healthy", uptime: process.uptime() }));
        } else {
            res.writeHead(404);
            res.end("Not Found");
        }
    });
    server.listen(8080);
    return server;
}

main().catch((err) => {
    console.error("[FATAL] TEE Agent failed to start:", err);
    process.exit(1);
});
