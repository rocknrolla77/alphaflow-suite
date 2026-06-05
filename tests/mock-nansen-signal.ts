#!/usr/bin/env npx tsx
// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — tests/mock-nansen-signal.ts
// Mock Nansen Signal Injection → Redis Stream (agent_insights)
//
// Simulates the TEE agent publishing a signed ForwardRequest to Redis.
// Used for E2E testing: workers should race to relay the transaction.
//
// USAGE:
//   npx tsx tests/mock-nansen-signal.ts
//   docker compose exec bff npx tsx /app/tests/mock-nansen-signal.ts
// ═══════════════════════════════════════════════════════════════════════════════

import { Redis } from "ioredis";
import { encodeFunctionData, parseAbi, keccak256, toHex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

// ─── Config ──────────────────────────────────────────────────────────────────

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://:alphaflow_dev@localhost:6379";
const STREAM_KEY = "agent_insights";
const DISPATCHER_ADDRESS = process.env["DISPATCHER_ADDRESS"] ?? "0x0000000000000000000000000000000000000001";
const ACTIVE_SENTINEL_ADDRESS = process.env["ACTIVE_SENTINEL_ADDRESS"] ?? "0x0000000000000000000000000000000000000002";

// ─── ABI ─────────────────────────────────────────────────────────────────────

const SENTINEL_ABI = parseAbi([
    "function executeFlashArbitrage(address borrowToken, uint256 borrowAmount, uint256 minProfit, address swapTarget, bytes calldata swapCalldata) external",
]);

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  AlphaFlow — Mock Nansen Signal Injector (E2E Test)");
    console.log("═══════════════════════════════════════════════════════════════");

    // Generate ephemeral signer (simulates TEE agent)
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    console.log(`[Mock TEE] Signer: ${account.address}`);

    // Connect to Redis
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
    console.log(`[Mock TEE] Connected to Redis: ${REDIS_URL.replace(/:[^:@]+@/, ":***@")}`);

    // ─── Simulate Insight Generation ─────────────────────────────────────

    const borrowToken = "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8"; // WMNT
    const borrowAmount = "1000000000000000000000"; // 1000 WMNT
    const minProfit = "5000000000000000000"; // 5 MNT
    const swapTarget = "0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57"; // Mock DEX
    const swapCalldata = "0xdeadbeef";

    // Encode calldata for ActiveSentinel.executeFlashArbitrage()
    const calldata = encodeFunctionData({
        abi: SENTINEL_ABI,
        functionName: "executeFlashArbitrage",
        args: [
            borrowToken as `0x${string}`,
            BigInt(borrowAmount),
            BigInt(minProfit),
            swapTarget as `0x${string}`,
            swapCalldata as `0x${string}`,
        ],
    });

    // Generate ForwardRequest
    const nonce = BigInt(Date.now());
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300); // 5 min from now

    const request = {
        target: ACTIVE_SENTINEL_ADDRESS,
        data: calldata,
        value: "0",
        nonce: nonce.toString(),
        deadline: deadline.toString(),
    };

    // Compute insight hash (like TEE agent does)
    const insightHash = keccak256(
        toHex(`${borrowToken}:BUY:${borrowAmount}:${Math.floor(Date.now() / 1000)}`)
    );

    // Sign the ForwardRequest (EIP-712 domain)
    const signature = await account.signTypedData({
        domain: {
            name: "AlphaFlow_TEE",
            version: "1",
            chainId: 5000,
            verifyingContract: DISPATCHER_ADDRESS as `0x${string}`,
        },
        types: {
            ForwardRequest: [
                { name: "target", type: "address" },
                { name: "data", type: "bytes" },
                { name: "value", type: "uint256" },
                { name: "nonce", type: "uint256" },
                { name: "deadline", type: "uint256" },
            ],
        },
        primaryType: "ForwardRequest",
        message: {
            target: request.target as `0x${string}`,
            data: request.data as `0x${string}`,
            value: BigInt(request.value),
            nonce: BigInt(request.nonce),
            deadline: BigInt(request.deadline),
        },
    });

    // ─── Publish to Redis Stream ─────────────────────────────────────────

    const payload = JSON.stringify({
        request,
        signature,
        signerAddress: account.address,
        generatedAt: Math.floor(Date.now() / 1000),
        insightHash,
        commitTxHash: "0x" + "ab".repeat(32), // Mock commit tx
    });

    console.log("\n[Mock TEE] ─── ForwardRequest ───");
    console.log(`  Target:     ${request.target}`);
    console.log(`  Nonce:      ${request.nonce}`);
    console.log(`  Deadline:   ${new Date(Number(deadline) * 1000).toISOString()}`);
    console.log(`  InsightHash: ${insightHash}`);
    console.log(`  Signer:     ${account.address}`);

    const streamId = await redis.xadd(
        STREAM_KEY,
        "MAXLEN", "~", "1000",
        "*",
        "payload", payload
    );

    console.log(`\n[Mock TEE] ✓ Published to Redis Stream`);
    console.log(`  Stream Key: ${STREAM_KEY}`);
    console.log(`  Entry ID:   ${streamId}`);
    console.log(`\n[Mock TEE] Swarm Workers should pick this up now.`);
    console.log("═══════════════════════════════════════════════════════════════\n");

    // Also publish a BFF-friendly insight (for WebSocket broadcast)
    const bffInsight = JSON.stringify({
        id: streamId,
        type: "ARBITRAGE",
        asset: "WMNT",
        action: "BUY",
        confidence: 0.92,
        reasoning: `Flash arb opportunity: borrow ${Number(BigInt(borrowAmount)) / 1e18} WMNT, min profit ${Number(BigInt(minProfit)) / 1e18} MNT`,
        timestamp: Date.now(),
        insightHash,
        forwardRequest: request,
        workerRace: {
            status: "pending",
            participants: ["byreal-worker-1", "byreal-worker-2", "byreal-worker-3"],
        },
    });

    await redis.xadd(
        STREAM_KEY,
        "MAXLEN", "~", "1000",
        "*",
        "payload", bffInsight
    );

    console.log("[Mock TEE] ✓ Also published BFF-friendly insight for WebSocket broadcast\n");

    await redis.quit();
    process.exit(0);
}

main().catch((err) => {
    console.error("[Mock TEE] FATAL:", err);
    process.exit(1);
});
