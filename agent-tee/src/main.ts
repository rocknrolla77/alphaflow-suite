// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — agent-tee/src/main.ts
// Entry Point для TEE-агента (Phala Network CVM)
// Phase 2: Pipeline Invariant — commit on-chain BEFORE publish
//
// БЕЗОПАСНОСТЬ:
// - Приватный ключ генерируется IN-MEMORY при каждом запуске
// - NEVER: не логируется, не записывается на диск, не передаётся по сети
// - Экспортируется ТОЛЬКО публичный адрес (через health endpoint)
//
// PIPELINE INVARIANT:
// 1. YieldArchitect.generateProposal() → proposal + insightHash
// 2. SentinelExecutor.commitProofOfAlpha(insightHash) → commitTxHash
// 3. Assemble final proposal with commitTxHash
// 4. ONLY THEN → redisPublisher.publish(proposal)
//
// Если шаг 2 fails → шаг 4 НИКОГДА не выполняется.
// ═══════════════════════════════════════════════════════════════════════════════

import { ethers, Wallet, HDNodeWallet } from "ethers";
import { z } from "zod";
import http from "node:http";
import type { AgentConfig, SmartMoneySignal, UserRiskProfile, SignedProposal } from "./types/index.js";
import { YieldArchitect } from "./strategies/yieldArchitect.js";
import { SentinelExecutor, type ExecutorConfig } from "./executor.js";
import { ProposalPublisher } from "./services/proposalPublisher.js";

// ─── Zod Schema для валидации конфигурации ────────────────────────────────────

const AgentConfigSchema = z.object({
    redisUrl: z.string().min(1, "REDIS_URL is required"),
    chainId: z.number().int().positive(),
    proposalTtlSeconds: z.number().int().min(30).max(3600),
    healthPort: z.number().int().min(1024).max(65535),
    attestationEnabled: z.boolean(),
    alphaAuditorAddress: z.string()
        .regex(/^0x[a-fA-F0-9]{40}$/, "ALPHA_AUDITOR_ADDRESS must be valid Ethereum address"),
    agentId: z.bigint().positive("AGENT_ID must be positive uint256"),
});

// ─── Конфигурация из Environment Variables ────────────────────────────────────

function loadConfig(): AgentConfig {
    const raw = {
        redisUrl: process.env["REDIS_URL"] ?? "redis://localhost:6379",
        chainId: parseInt(process.env["CHAIN_ID"] ?? "5000", 10),
        proposalTtlSeconds: parseInt(process.env["PROPOSAL_TTL_SECONDS"] ?? "300", 10),
        healthPort: parseInt(process.env["HEALTH_PORT"] ?? "8080", 10),
        attestationEnabled: process.env["ATTESTATION_ENABLED"] === "true",
        alphaAuditorAddress: process.env["ALPHA_AUDITOR_ADDRESS"] ?? "",
        agentId: BigInt(process.env["AGENT_ID"] ?? "0"),
    };

    // Strict validation with zod — crash early on misconfiguration
    const result = AgentConfigSchema.safeParse(raw);
    if (!result.success) {
        const errors = result.error.issues
            .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
            .join("\n");
        throw new Error(
            `[TEE] Configuration validation failed:\n${errors}\n\n` +
            `Required env vars: REDIS_URL, CHAIN_ID, ALPHA_AUDITOR_ADDRESS, AGENT_ID`
        );
    }

    return result.data;
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

function startHealthServer(port: number, signerAddress: string, config: AgentConfig): http.Server {
    const startTime = Date.now();

    const server = http.createServer((_req, res) => {
        const url = _req.url ?? "/";

        if (url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                status: "healthy",
                signerAddress: signerAddress,
                alphaAuditor: config.alphaAuditorAddress,
                agentId: config.agentId.toString(),
                uptime: Math.floor((Date.now() - startTime) / 1000),
                timestamp: Math.floor(Date.now() / 1000),
            }));
            return;
        }

        if (url === "/attestation") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                signerAddress: signerAddress,
                attestationType: config.attestationEnabled ? "sgx" : "mock",
                message: config.attestationEnabled
                    ? "Remote attestation enabled"
                    : "Remote attestation available in CVM production mode",
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

// ═══════════════════════════════════════════════════════════════════════════════
//              PIPELINE: Generate → Commit → Publish
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ProposalPipeline — оркестрирует жёсткий инвариант потока:
 *
 * 1. YieldArchitect.generateProposal() → proposal (insightHash computed)
 * 2. SentinelExecutor.commitProofOfAlpha(insightHash) → commitTxHash
 * 3. Re-sign proposal с commitTxHash
 * 4. ProposalPublisher.publish() → Redis → Telegram Bot
 *
 * ИНВАРИАНТ: если шаг 2 fails, шаг 4 НИКОГДА не выполняется.
 * Proposal без on-chain Proof-of-Alpha НЕ публикуется.
 */
export class ProposalPipeline {
    private readonly architect: YieldArchitect;
    private readonly executor: SentinelExecutor;
    private readonly publisher: ProposalPublisher;
    private readonly config: AgentConfig;

    constructor(
        architect: YieldArchitect,
        executor: SentinelExecutor,
        publisher: ProposalPublisher,
        config: AgentConfig
    ) {
        this.architect = architect;
        this.executor = executor;
        this.publisher = publisher;
        this.config = config;
    }

    /**
     * Полный pipeline: signal → on-chain commit → publish.
     *
     * @param signal — Smart Money сигнал от Nansen MCP
     * @param profile — риск-профиль пользователя
     * @returns SignedProposal (published) или throws Error (NOT published)
     *
     * @throws Error если:
     *   - YieldArchitect rejects signal (dust, invalid bounds)
     *   - AlphaAuditor commit fails (RPC error, bundler reject, revert)
     *   - Redis publish fails
     *
     * В случае любого throw — proposal НЕ опубликован в Telegram.
     */
    async processSignal(
        signal: SmartMoneySignal,
        profile: UserRiskProfile
    ): Promise<SignedProposal> {
        const pipelineId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        console.log(`\n[Pipeline:${pipelineId}] ═══ Starting ═══`);
        console.log(`[Pipeline:${pipelineId}] Signal: ${signal.assetSymbol} ${signal.action}`);
        console.log(`[Pipeline:${pipelineId}] Source: ${signal.walletTag} (rep: ${signal.reputationScore})`);

        // ─── STEP 1: Generate Proposal (compute volumes + hashes) ─────────
        console.log(`[Pipeline:${pipelineId}] Step 1: Generating proposal...`);

        const preliminaryProposal = await this.architect.generateProposal(
            signal,
            profile,
            this.config.proposalTtlSeconds
        );

        console.log(`[Pipeline:${pipelineId}] Step 1 ✓ Proposal generated`);
        console.log(`  Amount: ${ethers.formatEther(preliminaryProposal.recommendedAmount)} tokens`);
        console.log(`  InsightHash: ${preliminaryProposal.insightHash}`);
        console.log(`  Nonce: ${preliminaryProposal.nonce}`);

        // ─── STEP 2: Commit insightHash on-chain (BLOCKING) ───────────────
        // ИНВАРИАНТ: Если этот шаг fails — pipeline прерывается.
        // Proposal НИКОГДА не публикуется без on-chain Proof-of-Alpha.
        console.log(`[Pipeline:${pipelineId}] Step 2: Committing Proof-of-Alpha on-chain...`);

        let commitTxHash: `0x${string}`;
        try {
            const commitResult = await this.executor.commitProofOfAlpha(
                preliminaryProposal.insightHash
            );
            commitTxHash = commitResult.txHash;
        } catch (commitError) {
            // ═══════════════════════════════════════════════════════════════
            // CRITICAL: On-chain commit failed.
            // Pipeline ABORTED. Proposal will NOT be published to Telegram.
            // ═══════════════════════════════════════════════════════════════
            const errMsg = commitError instanceof Error
                ? commitError.message
                : String(commitError);

            console.error(`[Pipeline:${pipelineId}] Step 2 ✗ FAILED: ${errMsg}`);
            console.error(`[Pipeline:${pipelineId}] ═══ ABORTED ═══ Proposal NOT published.`);

            throw new Error(
                `[Pipeline] Proof-of-Alpha commit failed. Proposal discarded.\n` +
                `  Reason: ${errMsg}\n` +
                `  InsightHash: ${preliminaryProposal.insightHash}\n` +
                `  AgentId: ${this.config.agentId}`
            );
        }

        console.log(`[Pipeline:${pipelineId}] Step 2 ✓ Committed on-chain`);
        console.log(`  TxHash: ${commitTxHash}`);

        // ─── STEP 3: Re-sign proposal with commitTxHash ──────────────────
        // Финальный proposal включает commitTxHash — повторная подпись
        // гарантирует, что подпись покрывает ВСЕ данные включая txHash.
        console.log(`[Pipeline:${pipelineId}] Step 3: Re-signing with commitTxHash...`);

        const finalProposal = await this.architect.generateProposal(
            signal,
            profile,
            this.config.proposalTtlSeconds,
            commitTxHash
        );

        console.log(`[Pipeline:${pipelineId}] Step 3 ✓ Final proposal signed`);

        // ─── STEP 4: Publish to Redis → Telegram Bot ──────────────────────
        // ТОЛЬКО после успешного on-chain commit.
        console.log(`[Pipeline:${pipelineId}] Step 4: Publishing to Redis...`);

        await this.publisher.publish(
            {
                proposal: finalProposal,
                proofOfReasoning: finalProposal.reasoningHash,
                teeSignerAddress: finalProposal.signerAddress,
            },
            0, // currentPrice (заполняется в production из on-chain oracle)
            profile.maxSlippageBps / 100
        );

        console.log(`[Pipeline:${pipelineId}] Step 4 ✓ Published to Redis`);
        console.log(`[Pipeline:${pipelineId}] ═══ COMPLETE ═══`);
        console.log(`  Asset: ${finalProposal.asset}`);
        console.log(`  Action: ${finalProposal.action}`);
        console.log(`  Amount: ${ethers.formatEther(finalProposal.recommendedAmount)}`);
        console.log(`  InsightHash: ${finalProposal.insightHash}`);
        console.log(`  CommitTxHash: ${finalProposal.commitTxHash}`);
        console.log(`  Deadline: ${new Date(finalProposal.deadline * 1000).toISOString()}`);

        return finalProposal;
    }
}

// ─── Main Loop ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  AlphaFlow Suite — TEE Agent (Phala DStack CVM)");
    console.log("  Phase 2: Proof-of-Alpha Pipeline");
    console.log("═══════════════════════════════════════════════════════════════");

    // ─── 1. Load & validate config ────────────────────────────────────────
    const config = loadConfig();
    console.log(`[TEE] Chain ID: ${config.chainId}`);
    console.log(`[TEE] Proposal TTL: ${config.proposalTtlSeconds}s`);
    console.log(`[TEE] Attestation: ${config.attestationEnabled ? "ENABLED" : "MOCK"}`);
    console.log(`[TEE] AlphaAuditor: ${config.alphaAuditorAddress}`);
    console.log(`[TEE] Agent ID: ${config.agentId}`);

    // ─── 2. Generate in-memory signer (NEVER persisted) ──────────────────
    const signer = generateTeeSigner();

    // ─── 3. Initialize YieldArchitect ─────────────────────────────────────
    const architect = new YieldArchitect(signer, config.chainId, 0);
    console.log(`[TEE] YieldArchitect ready. Nonce: ${architect.currentNonce}`);

    // ─── 4. Initialize SentinelExecutor (for Proof-of-Alpha commits) ──────
    const executorConfig: ExecutorConfig = {
        sessionPrivateKey: process.env["SESSION_PRIVATE_KEY"] as `0x${string}` ?? "0x",
        kernelAddress: process.env["KERNEL_ADDRESS"] as `0x${string}` ?? "0x",
        activeSentinelAddress: process.env["ACTIVE_SENTINEL_ADDRESS"] as `0x${string}` ?? "0x",
        alphaAuditorAddress: config.alphaAuditorAddress as `0x${string}`,
        agentId: config.agentId,
        bundlerUrl: process.env["BUNDLER_URL"] ?? "",
        rpcUrl: process.env["MANTLE_RPC_URL"] ?? "https://rpc.mantle.xyz",
        chainId: config.chainId,
    };
    const executor = new SentinelExecutor(executorConfig);
    console.log(`[TEE] SentinelExecutor ready (Proof-of-Alpha + Flash Arb)`);

    // ─── 5. Initialize ProposalPublisher ──────────────────────────────────
    const publisher = new ProposalPublisher(
        {
            redisUrl: config.redisUrl,
            channel: "tee_proposals",
            defaultDeadlineOffsetSec: config.proposalTtlSeconds,
        },
        null // Redis client injected lazily in production
    );
    console.log(`[TEE] ProposalPublisher ready (channel: tee_proposals)`);

    // ─── 6. Create Pipeline ───────────────────────────────────────────────
    const pipeline = new ProposalPipeline(architect, executor, publisher, config);
    console.log(`[TEE] ProposalPipeline ready (commit-before-publish invariant)`);

    // ─── 7. Start health/attestation endpoint ─────────────────────────────
    startHealthServer(config.healthPort, architect.signerAddress, config);

    // ─── 8. Demo: full pipeline run ───────────────────────────────────────
    // В production это заменяется на Redis Pub/Sub listener для сигналов

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
        // В demo-режиме: генерация без on-chain commit (нет bundler)
        // Production: pipeline.processSignal(signal, profile) — полный flow
        if (executorConfig.bundlerUrl && executorConfig.sessionPrivateKey !== "0x") {
            // Production mode: full pipeline with on-chain commit
            console.log("\n[TEE] Running FULL pipeline (on-chain commit + publish)...");
            const published = await pipeline.processSignal(demoSignal, demoProfile);
            console.log(`\n[TEE] Pipeline SUCCESS. Proposal published with commitTxHash.`);
            console.log(`  CommitTxHash: ${published.commitTxHash}`);
        } else {
            // Dev mode: demonstrate generation without bundler
            console.log("\n[TEE] Running in DEV mode (no bundler configured)...");
            console.log("[TEE] Demonstrating proposal generation + insight hashing...\n");

            const signed = await architect.generateProposal(
                demoSignal,
                demoProfile,
                config.proposalTtlSeconds
            );

            console.log("[TEE] ═══ Proposal Generated (DEV) ═══");
            console.log(`  Asset:       ${signed.asset}`);
            console.log(`  Action:      ${signed.action}`);
            console.log(`  Amount:      ${ethers.formatEther(signed.recommendedAmount)} tokens`);
            console.log(`  Nonce:       ${signed.nonce}`);
            console.log(`  Deadline:    ${new Date(signed.deadline * 1000).toISOString()}`);
            console.log(`  ReasonHash:  ${signed.reasoningHash}`);
            console.log(`  InsightHash: ${signed.insightHash}`);
            console.log(`  CommitTx:    ${signed.commitTxHash} (placeholder in dev)`);
            console.log(`  Signature:   ${signed.signature.slice(0, 20)}...`);
            console.log(`  Signer:      ${signed.signerAddress}`);

            // Verification self-check
            const isValid = YieldArchitect.verifyProposal(
                signed,
                signed.signature,
                signed.signerAddress,
                config.chainId
            );
            console.log(`  Verified:    ${isValid ? "✓ VALID" : "✗ INVALID"}`);

            // Show insight hash computation
            const insightHashVerify = architect.computeInsightHash(
                signed.asset,
                signed.action,
                signed.recommendedAmount,
                signed.generatedAt
            );
            console.log(`  InsightHash (recomputed): ${insightHashVerify}`);
            console.log(`  Match: ${insightHashVerify === signed.insightHash ? "✓" : "✗"}`);

            console.log("\n[TEE] ⚠️  In production, this proposal would be:");
            console.log("  1. commitProofOfAlpha(insightHash) → txHash");
            console.log("  2. Re-signed with commitTxHash");
            console.log("  3. Published to Redis → Telegram");
        }
    } catch (err) {
        console.error(`[TEE] Pipeline error: ${(err as Error).message}`);
    }

    // ─── 9. Keep alive (в production: Redis Subscriber loop) ─────────────
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
