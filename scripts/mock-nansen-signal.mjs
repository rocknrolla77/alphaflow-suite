#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — scripts/mock-nansen-signal.mjs
// Emulates a Nansen signal → TEE insight → ForwardRequest in Redis Stream
//
// Usage:
//   node scripts/mock-nansen-signal.mjs
//   REDIS_URL=redis://:alphaflow_dev@localhost:6379 node scripts/mock-nansen-signal.mjs
//
// This script pushes a mock SignedForwardRequest into the "agent_insights"
// Redis Stream, which:
//   1. BFF picks up and broadcasts to WebSocket clients
//   2. Byreal workers pick up and attempt to relay on-chain
// ═══════════════════════════════════════════════════════════════════════════════

import { createClient } from "redis";
import crypto from "node:crypto";

const REDIS_URL = process.env.REDIS_URL ?? "redis://:alphaflow_dev@localhost:6379";
const STREAM_KEY = process.env.STREAM_KEY ?? "agent_insights";
const DISPATCHER = process.env.DISPATCHER_ADDRESS ?? "0x5FbDB2315678afecb367f032d93F642f64180aa3";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function randomHex(bytes) {
    return "0x" + crypto.randomBytes(bytes).toString("hex");
}

function randomAddress() {
    return "0x" + crypto.randomBytes(20).toString("hex");
}

// ─── Build Mock Insight + ForwardRequest ─────────────────────────────────────

function buildMockPayload() {
    const now = Math.floor(Date.now() / 1000);
    const deadline = now + 120; // 2 minutes from now
    const nonce = Math.floor(Math.random() * 1_000_000);
    const insightHash = randomHex(32);

    const assets = [
        { symbol: "WMNT/USDC", address: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8" },
        { symbol: "WETH/WMNT", address: "0xdEAddEaDdeadDEAdDEADDEAddEADDEAdDeadDEAd" },
        { symbol: "mETH/WMNT", address: "0xCDa86a272531e8640cD7F1a92c01839911B90bb0" },
    ];
    const asset = assets[Math.floor(Math.random() * assets.length)];
    const action = Math.random() > 0.5 ? "BUY" : "SELL";
    const confidence = +(0.7 + Math.random() * 0.29).toFixed(3);

    // Insight portion (for WebSocket display + ProofOfAlpha)
    const insight = {
        type: "ARBITRAGE",
        asset: asset.symbol,
        assetAddress: asset.address,
        action,
        confidence,
        reasoning: `${action} ${asset.symbol} — ${confidence * 100}% conf, spread detected via Nansen Smart Money flow. TEE-signed.`,
        insightHash,
        timestamp: now,
    };

    // ForwardRequest (for workers to relay on-chain)
    const request = {
        target: DISPATCHER,
        data: randomHex(68), // Mock calldata
        value: "0",
        nonce: String(nonce),
        deadline: String(deadline),
    };

    // Fake signature (in E2E against Anvil, this won't verify unless contracts are deployed)
    const signature = randomHex(65);

    return {
        ...insight,
        request,
        signature,
        workerRace: {
            status: "pending",
            participants: ["byreal-worker-1", "byreal-worker-2", "byreal-worker-3"],
        },
    };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  AlphaFlow E2E — Mock Nansen Signal Generator");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(`  Redis: ${REDIS_URL.replace(/:[^:@]+@/, ":***@")}`);
    console.log(`  Stream: ${STREAM_KEY}`);
    console.log("");

    const client = createClient({ url: REDIS_URL });
    client.on("error", (err) => console.error("[Redis] Error:", err.message));
    await client.connect();

    console.log("[✓] Connected to Redis\n");

    // Send a burst of insights
    const count = parseInt(process.argv[2] ?? "3", 10);
    const interval = parseInt(process.argv[3] ?? "2000", 10);

    for (let i = 0; i < count; i++) {
        const payload = buildMockPayload();
        
        const streamId = await client.xAdd(STREAM_KEY, "*", {
            payload: JSON.stringify(payload),
        });

        console.log(`[${i + 1}/${count}] Published: ${payload.action} ${payload.asset}`);
        console.log(`  Stream ID: ${streamId}`);
        console.log(`  Hash: ${payload.insightHash.slice(0, 18)}...`);
        console.log(`  Confidence: ${(payload.confidence * 100).toFixed(1)}%`);
        console.log(`  Workers: ${payload.workerRace.participants.join(", ")}`);
        console.log("");

        if (i < count - 1) {
            await new Promise((r) => setTimeout(r, interval));
        }
    }

    // Simulate race result (worker-1 wins after 3s)
    await new Promise((r) => setTimeout(r, 3000));

    const winPayload = {
        type: "SIGNAL",
        asset: "WMNT/USDC",
        action: "BUY",
        confidence: 0.95,
        reasoning: "Race completed — worker executed ForwardRequest successfully.",
        insightHash: randomHex(32),
        timestamp: Math.floor(Date.now() / 1000),
        workerRace: {
            status: "won",
            winner: "byreal-worker-1",
            winnerAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            txHash: "0x" + crypto.randomBytes(32).toString("hex"),
            participants: ["byreal-worker-1", "byreal-worker-2", "byreal-worker-3"],
            gasRefund: "0.0042",
        },
    };

    const finalId = await client.xAdd(STREAM_KEY, "*", {
        payload: JSON.stringify(winPayload),
    });

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`[RACE WON] ${winPayload.workerRace.winner} → tx: ${winPayload.workerRace.txHash.slice(0, 20)}...`);
    console.log(`  Gas Refund: ${winPayload.workerRace.gasRefund} MNT`);
    console.log(`  Stream ID: ${finalId}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    await client.quit();
    console.log("\n[✓] Done. Check BFF WebSocket and Frontend for real-time updates.");
}

main().catch((err) => {
    console.error("[FATAL]", err);
    process.exit(1);
});
