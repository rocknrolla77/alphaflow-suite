// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — agent-tee/src/main.ts
// Entry Point для TEE-агента (Phala Network CVM)
//
// БЕЗОПАСНОСТЬ:
// - Приватный ключ генерируется IN-MEMORY при каждом запуске
// - NEVER: не логируется, не записывается на диск, не передаётся по сети
// - Экспортируется ТОЛЬКО публичный адрес (через health endpoint)
// ═══════════════════════════════════════════════════════════════════════════════

import { ethers, Wallet, HDNodeWallet } from "ethers";
import http from "node:http";
import type { AgentConfig, SmartMoneySignal, UserRiskProfile } from "./types/index.js";
import { YieldArchitect } from "./strategies/yieldArchitect.js";

// ─── Конфигурация из Environment Variables ────────────────────────────────────

function loadConfig(): AgentConfig {
    return {
        redisUrl: process.env["REDIS_URL"] ?? "redis://localhost:6379",
        chainId: parseInt(process.env["CHAIN_ID"] ?? "5000", 10),
        proposalTtlSeconds: parseInt(process.env["PROPOSAL_TTL_SECONDS"] ?? "300", 10),
        healthPort: parseInt(process.env["HEALTH_PORT"] ?? "8080", 10),
        attestationEnabled: process.env["ATTESTATION_ENABLED"] === "true",
    };
}

// ─── TEE Key Generation ───────────────────────────────────────────────────────

/**
 * Генерация in-memory ECDSA signer.
 *
 * КРИТИЧЕСКИ ВАЖНО:
 * - Ключ существует ТОЛЬКО в RAM процесса
 * - При перезапуске CVM генерируется НОВЫЙ ключ
 * - Предыдущий публичный адрес должен быть деактивирован (Session Key rotation)
 * - console.log НЕ вызывается для privateKey (даже masked)
 */
function generateTeeSigner(): HDNodeWallet {
    const wallet = Wallet.createRandom();

    // ═══════════════════════════════════════════════════════════════════════════
    // ВНИМАНИЕ: Ниже логируется ТОЛЬКО публичный адрес.
    // Приватный ключ НЕ ДОЛЖЕН появляться ни в каком выводе.
    // ═══════════════════════════════════════════════════════════════════════════
    console.log(`[TEE] Signer initialized. Public address: ${wallet.address}`);

    return wallet;
}

// ─── Health Check HTTP Server ─────────────────────────────────────────────────

function startHealthServer(port: number, signerAddress: string): http.Server {
    const server = http.createServer((_req, res) => {
        const url = _req.url ?? "/";

        if (url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                status: "healthy",
                signerAddress: signerAddress,
                uptime: process.uptime(),
                timestamp: Math.floor(Date.now() / 1000),
            }));
            return;
        }

        if (url === "/attestation") {
            // Placeholder: в production здесь SGX Quote
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                signerAddress: signerAddress,
                attestationType: "mock",
                message: "Remote attestation available in CVM production mode",
            }));
            return;
        }

        res.writeHead(404);
        res.end("Not Found");
    });

    server.listen(port, "0.0.0.0", () => {
        console.log(`[TEE] Health server listening on :${port}`);
    });

    return server;
}

// ─── Main Loop ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  AlphaFlow Suite — TEE Agent (Phala DStack CVM)");
    console.log("═══════════════════════════════════════════════════════════════");

    // ─── 1. Load config ──────────────────────────────────────────────────
    const config = loadConfig();
    console.log(`[TEE] Chain ID: ${config.chainId}`);
    console.log(`[TEE] Proposal TTL: ${config.proposalTtlSeconds}s`);
    console.log(`[TEE] Attestation: ${config.attestationEnabled ? "ENABLED" : "MOCK"}`);

    // ─── 2. Generate in-memory signer (NEVER persisted) ──────────────────
    const signer = generateTeeSigner();

    // ─── 3. Initialize YieldArchitect ────────────────────────────────────
    const architect = new YieldArchitect(signer, config.chainId, 0);
    console.log(`[TEE] YieldArchitect ready. Nonce: ${architect.currentNonce}`);

    // ─── 4. Start health/attestation endpoint ────────────────────────────
    startHealthServer(config.healthPort, architect.signerAddress);

    // ─── 5. Demo: generate a test proposal ───────────────────────────────
    // В production это заменяется на Redis Pub/Sub listener
    // для получения сигналов от NansenClient

    const demoSignal: SmartMoneySignal = {
        walletAddress: "0x28C6c06298d514Db089934071355E5743bf21d60", // Binance 14
        walletTag: "Fund",
        reputationScore: 0.92,
        asset: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8", // WMNT
        assetSymbol: "WMNT",
        action: "BUY",
        tradeVolume: ethers.parseEther("500000"),       // 500k WMNT
        totalPortfolioValue: ethers.parseEther("10000000"), // $10M portfolio
        detectedAt: Math.floor(Date.now() / 1000),
        sourceTxHash: "0xabc123def456789012345678901234567890123456789012345678901234abcd",
    };

    const demoProfile: UserRiskProfile = {
        accountAddress: "0x1234567890abcdef1234567890abcdef12345678",
        availableBalance: ethers.parseEther("10000"),   // 10k WMNT
        riskCoefficient: 0.5,                            // Moderate risk
        maxSlippageBps: 200,                             // 2% max slippage
        minProfitThreshold: ethers.parseEther("10"),     // Min 10 WMNT profit
    };

    try {
        const signed = await architect.generateProposal(
            demoSignal,
            demoProfile,
            config.proposalTtlSeconds
        );

        console.log("\n[TEE] ═══ Proposal Generated ═══");
        console.log(`  Asset:    ${signed.asset}`);
        console.log(`  Action:   ${signed.action}`);
        console.log(`  Amount:   ${ethers.formatEther(signed.recommendedAmount)} tokens`);
        console.log(`  Nonce:    ${signed.nonce}`);
        console.log(`  Deadline: ${new Date(signed.deadline * 1000).toISOString()}`);
        console.log(`  Reasoning Hash: ${signed.reasoningHash}`);
        console.log(`  Signature: ${signed.signature.slice(0, 20)}...`);
        console.log(`  Signer:   ${signed.signerAddress}`);

        // ─── Верификация подписи (self-check) ────────────────────────────
        const isValid = YieldArchitect.verifyProposal(
            signed,
            signed.signature,
            signed.signerAddress,
            config.chainId
        );
        console.log(`  Verified: ${isValid ? "✓ VALID" : "✗ INVALID"}`);

        // ─── Расчёт Weight для демо ─────────────────────────────────────
        const weight = Number(demoSignal.tradeVolume * 10000n / demoSignal.totalPortfolioValue) / 10000;
        console.log(`\n[TEE] Strategy Math:`);
        console.log(`  W (conviction) = ${demoSignal.tradeVolume} / ${demoSignal.totalPortfolioValue} = ${weight}`);
        console.log(`  S_user = ${ethers.formatEther(demoProfile.availableBalance)} × ${weight} × ${demoProfile.riskCoefficient}`);
        console.log(`  S_user = ${ethers.formatEther(signed.recommendedAmount)} tokens`);

    } catch (err) {
        console.error(`[TEE] Error generating proposal: ${(err as Error).message}`);
    }

    // ─── 6. Keep alive (в production: Redis Subscriber loop) ─────────────
    console.log("\n[TEE] Agent running. Waiting for signals...");
    console.log("[TEE] Press Ctrl+C to shutdown.\n");

    // Graceful shutdown
    const shutdown = (): void => {
        console.log("\n[TEE] Shutting down gracefully...");
        console.log("[TEE] Signer key destroyed (garbage collected).");
        process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

// ─── Execution ────────────────────────────────────────────────────────────────

main().catch((err: unknown) => {
    console.error("[TEE] FATAL:", err);
    process.exit(1);
});
