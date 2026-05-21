// Файл: agent-tee/src/test/yieldArchitect.test.ts
// Unit tests для Yield Architect Strategy Engine

import { describe, it, expect, beforeEach } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import { YieldArchitect } from "../strategies/yieldArchitect";
import { NansenMCPClient } from "../services/nansenClient";
import type { SmartMoneySignal, UserRiskProfile } from "../types";

// ═══════════════════════════════════════════════════════════════════════
//                       MOCK NANSEN CLIENT
// ═══════════════════════════════════════════════════════════════════════

class MockNansenClient extends NansenMCPClient {
    constructor() {
        super({
            apiUrl: "http://mock.nansen.local",
            apiKey: "test-key",
            chain: "mantle",
            timeoutMs: 5000,
            maxRetries: 0,
        });
    }

    // Override для тестов — не делает реальных HTTP запросов
    async getSmartMoneyWallets() {
        return [
            {
                address: "0x1111111111111111111111111111111111111111" as `0x${string}`,
                tags: ["Fund" as const],
                totalValueUsd: 50_000_000,
                recentTxs: [],
            },
        ];
    }

    async getRecentTransactions() {
        return [
            {
                hash: "0xabc123" as `0x${string}`,
                timestamp: Math.floor(Date.now() / 1000) - 300,
                tokenAddress: "0x2222222222222222222222222222222222222222" as `0x${string}`,
                tokenSymbol: "WMNT",
                action: "BUY" as const,
                amountUsd: 500_000,
                chain: "mantle",
            },
        ];
    }
}

// ═══════════════════════════════════════════════════════════════════════
//                          TESTS
// ═══════════════════════════════════════════════════════════════════════

describe("YieldArchitect", () => {
    let architect: YieldArchitect;
    let teePrivateKey: `0x${string}`;
    let teeAddress: `0x${string}`;

    const defaultSignal: SmartMoneySignal = {
        assetAddress: "0x2222222222222222222222222222222222222222",
        action: "BUY",
        sSmart: 500_000, // Кит купил на $500k
        vSmart: 50_000_000, // Его портфель $50M
        tag: "Fund",
        walletAddress: "0x1111111111111111111111111111111111111111",
        txTimestamp: Math.floor(Date.now() / 1000),
        txHash: "0xabc123def456abc123def456abc123def456abc123def456abc123def456abc1",
    };

    const defaultProfile: UserRiskProfile = {
        balance: 100_000, // $100k пользователя
        riskFactor: 0.5, // Moderate
        maxPositionPct: 0.2, // Max 20% в одну позицию
        minSignalUsd: 10_000, // Игнорировать сделки < $10k
    };

    beforeEach(() => {
        teePrivateKey = generatePrivateKey();
        teeAddress = privateKeyToAccount(teePrivateKey).address;
        const mockClient = new MockNansenClient();
        architect = new YieldArchitect(mockClient, teePrivateKey);
    });

    // ─── Math & Bounds Tests ─────────────────────────────────────────

    describe("Weight Calculation (W = S_smart / V_smart)", () => {
        it("should calculate correct weight", async () => {
            const result = await architect.generateProposal(defaultSignal, defaultProfile);
            // W = 500_000 / 50_000_000 = 0.01
            expect(result.proposal.weight).toBeCloseTo(0.01, 4);
        });

        it("should calculate correct recommendedAmount", async () => {
            const result = await architect.generateProposal(defaultSignal, defaultProfile);
            // S_user = 100_000 * 0.01 * 0.5 = 500
            expect(result.proposal.recommendedAmount).toBeCloseTo(500, 0);
        });

        it("W=1.0 when whale invests entire portfolio (S_smart = V_smart)", async () => {
            const allInSignal = { ...defaultSignal, sSmart: 50_000_000, vSmart: 50_000_000 };
            const result = await architect.generateProposal(allInSignal, defaultProfile);
            // W = 1.0, S_user = 100_000 * 1.0 * 0.5 = 50_000
            // But maxPositionPct = 0.2, so cap = 100_000 * 0.2 = 20_000
            expect(result.proposal.recommendedAmount).toBeLessThanOrEqual(20_000);
        });
    });

    describe("Safety Caps", () => {
        it("recommendedAmount NEVER exceeds balance * maxPositionPct", async () => {
            // Extreme signal: huge W
            const extremeSignal = { ...defaultSignal, sSmart: 25_000_000, vSmart: 50_000_000 };
            // W = 0.5, S_user = 100_000 * 0.5 * 0.5 = 25_000
            // maxPosition = 100_000 * 0.2 = 20_000
            const result = await architect.generateProposal(extremeSignal, defaultProfile);
            const maxAllowed = defaultProfile.balance * defaultProfile.maxPositionPct;
            expect(result.proposal.recommendedAmount).toBeLessThanOrEqual(maxAllowed);
        });

        it("K_risk = 0 → recommendedAmount = 0 (full pause)", async () => {
            const pausedProfile = { ...defaultProfile, riskFactor: 0 };
            const result = await architect.generateProposal(defaultSignal, pausedProfile);
            expect(result.proposal.recommendedAmount).toBe(0);
        });

        it("recommendedAmount is never negative", async () => {
            const result = await architect.generateProposal(defaultSignal, defaultProfile);
            expect(result.proposal.recommendedAmount).toBeGreaterThanOrEqual(0);
        });

        it("recommendedAmount NEVER exceeds user balance", async () => {
            const aggressiveProfile = {
                ...defaultProfile,
                riskFactor: 1.0,
                maxPositionPct: 1.0,
            };
            const hugeSignal = { ...defaultSignal, sSmart: 50_000_000, vSmart: 50_000_000 };
            const result = await architect.generateProposal(hugeSignal, aggressiveProfile);
            expect(result.proposal.recommendedAmount).toBeLessThanOrEqual(
                aggressiveProfile.balance
            );
        });
    });

    describe("Input Validation", () => {
        it("should throw on V_smart = 0 (division by zero)", async () => {
            const badSignal = { ...defaultSignal, vSmart: 0 };
            await expect(
                architect.generateProposal(badSignal, defaultProfile)
            ).rejects.toThrow("Invalid Smart Money volume");
        });

        it("should throw on V_smart < 0", async () => {
            const badSignal = { ...defaultSignal, vSmart: -1 };
            await expect(
                architect.generateProposal(badSignal, defaultProfile)
            ).rejects.toThrow("Invalid Smart Money volume");
        });

        it("should throw on signal below minSignalUsd", async () => {
            const tinySignal = { ...defaultSignal, sSmart: 5_000 }; // Below 10k threshold
            await expect(
                architect.generateProposal(tinySignal, defaultProfile)
            ).rejects.toThrow("Signal too small");
        });

        it("should throw on riskFactor > 1", async () => {
            const badProfile = { ...defaultProfile, riskFactor: 1.5 };
            await expect(
                architect.generateProposal(defaultSignal, badProfile)
            ).rejects.toThrow("riskFactor must be in [0, 1]");
        });

        it("should throw on riskFactor < 0", async () => {
            const badProfile = { ...defaultProfile, riskFactor: -0.1 };
            await expect(
                architect.generateProposal(defaultSignal, badProfile)
            ).rejects.toThrow("riskFactor must be in [0, 1]");
        });
    });

    // ─── EIP-712 Signature Tests ─────────────────────────────────────

    describe("Proof-of-Reasoning (EIP-712 Signature)", () => {
        it("should produce valid signature from TEE key", async () => {
            const result = await architect.generateProposal(defaultSignal, defaultProfile);
            expect(result.proofOfReasoning).toMatch(/^0x[a-fA-F0-9]{130}$/);
        });

        it("teeSignerAddress matches the TEE key", async () => {
            const result = await architect.generateProposal(defaultSignal, defaultProfile);
            expect(result.teeSignerAddress.toLowerCase()).toBe(teeAddress.toLowerCase());
        });

        it("signature is deterministic for same inputs", async () => {
            // Freeze timestamp for determinism
            const now = Math.floor(Date.now() / 1000);
            const signal = { ...defaultSignal, txTimestamp: now };

            const result1 = await architect.generateProposal(signal, defaultProfile);
            const result2 = await architect.generateProposal(signal, defaultProfile);

            // reasoningHash should be identical
            expect(result1.proposal.reasoningHash).toBe(result2.proposal.reasoningHash);
        });

        it("different signals produce different signatures", async () => {
            const signal2 = { ...defaultSignal, sSmart: 1_000_000 };

            const result1 = await architect.generateProposal(defaultSignal, defaultProfile);
            const result2 = await architect.generateProposal(signal2, defaultProfile);

            expect(result1.proofOfReasoning).not.toBe(result2.proofOfReasoning);
        });
    });

    // ─── Confidence Scoring ──────────────────────────────────────────

    describe("Confidence by Tag", () => {
        it("Fund tag → confidence 0.9", async () => {
            const result = await architect.generateProposal(defaultSignal, defaultProfile);
            expect(result.proposal.confidence).toBe(0.9);
        });

        it("VC tag → confidence 0.85", async () => {
            const vcSignal = { ...defaultSignal, tag: "VC" as const };
            const result = await architect.generateProposal(vcSignal, defaultProfile);
            expect(result.proposal.confidence).toBe(0.85);
        });

        it("90D Smart Trader → confidence 0.7", async () => {
            const traderSignal = { ...defaultSignal, tag: "90D Smart Trader" as const };
            const result = await architect.generateProposal(traderSignal, defaultProfile);
            expect(result.proposal.confidence).toBe(0.7);
        });
    });

    // ─── Aggregation Tests ───────────────────────────────────────────

    describe("Multi-Signal Aggregation", () => {
        it("multiple whales buying → boosted confidence", async () => {
            const signals: SmartMoneySignal[] = [
                defaultSignal,
                { ...defaultSignal, walletAddress: "0x3333333333333333333333333333333333333333", sSmart: 300_000 },
                { ...defaultSignal, walletAddress: "0x4444444444444444444444444444444444444444", sSmart: 700_000 },
            ];

            const result = await architect.generateAggregatedProposal(signals, defaultProfile);

            // 3 signals → boost factor = 1 + log2(3) * 0.1 ≈ 1.158
            // Confidence = 0.9 * 1.158 ≈ 1.04 → capped at 0.95
            expect(result.proposal.confidence).toBeLessThanOrEqual(0.95);
            expect(result.proposal.confidence).toBeGreaterThan(0.9);
        });

        it("should throw on mixed assets in aggregation", async () => {
            const signals: SmartMoneySignal[] = [
                defaultSignal,
                { ...defaultSignal, assetAddress: "0x9999999999999999999999999999999999999999" },
            ];

            await expect(
                architect.generateAggregatedProposal(signals, defaultProfile)
            ).rejects.toThrow("Cannot aggregate signals for different assets");
        });

        it("should throw on empty signals array", async () => {
            await expect(
                architect.generateAggregatedProposal([], defaultProfile)
            ).rejects.toThrow("No signals to aggregate");
        });
    });
});
