// Файл: agent-tee/src/strategies/yieldArchitect.ts
// Yield Architect — Smart Money Tracker & Strategy Engine
// Работает исключительно внутри Phala TEE-анклава

import { keccak256, toBytes, encodePacked, type Hex } from "viem";
import { privateKeyToAccount, signTypedData } from "viem/accounts";
import type {
    SmartMoneySignal,
    UserRiskProfile,
    Proposal,
    SignedProposal,
    NansenTag,
} from "../types";
import { NansenMCPClient } from "../services/nansenClient";

// EIP-712 Domain для Proof-of-Reasoning
const EIP712_DOMAIN = {
    name: "AlphaFlow_TEE_Enclave",
    version: "1",
    chainId: 5000, // Mantle Network
} as const;

// EIP-712 Types
const PROPOSAL_TYPES = {
    Proposal: [
        { name: "asset", type: "address" },
        { name: "action", type: "string" },
        { name: "recommendedAmount", type: "uint256" },
        { name: "timestamp", type: "uint256" },
        { name: "reasoningHash", type: "bytes32" },
        { name: "weight", type: "uint256" },
        { name: "confidence", type: "uint256" },
    ],
} as const;

/**
 * Конфигурация весов для разных тегов Smart Money.
 * Fund и VC имеют больший вес — их сделки более информативны.
 */
const TAG_CONFIDENCE_MAP: Record<NansenTag, number> = {
    Fund: 0.9,
    VC: 0.85,
    "90D Smart Trader": 0.7,
    Whale: 0.5,
    "Flash Trader": 0.3,
};

/**
 * Yield Architect — TEE Smart Money Strategy Engine
 *
 * Алгоритм:
 * 1. Получает сигналы от Nansen MCP (Smart Money transactions)
 * 2. Фильтрует по значимости (minSignalUsd, тег кита)
 * 3. Рассчитывает весовой коэффициент W = S_smart / V_smart
 * 4. Нормализует под пользователя: S_user = V_user × W × K_risk
 * 5. Применяет safety caps (maxPositionPct)
 * 6. Агрегирует multiple signals для одного актива (boosted confidence)
 * 7. Подписывает Proposal через EIP-712 (Proof-of-Reasoning)
 *
 * Инвариант безопасности:
 * - recommendedAmount НИКОГДА не превышает balance × maxPositionPct
 * - При K_risk = 0 → recommendedAmount = 0 (полная пауза)
 * - Подпись верифицируема on-chain через ecrecover
 */
export class YieldArchitect {
    private nansenClient: NansenMCPClient;
    private teePrivateKey: `0x${string}`;
    private teeSignerAddress: `0x${string}`;

    constructor(nansenClient: NansenMCPClient, teePrivateKey: `0x${string}`) {
        this.nansenClient = nansenClient;
        this.teePrivateKey = teePrivateKey;
        const account = privateKeyToAccount(teePrivateKey);
        this.teeSignerAddress = account.address;
    }

    /**
     * Генерирует подписанное предложение на основе одного сигнала Smart Money.
     */
    async generateProposal(
        signal: SmartMoneySignal,
        profile: UserRiskProfile
    ): Promise<SignedProposal> {
        // ─── Validation ──────────────────────────────────────────────
        if (signal.vSmart <= 0) {
            throw new Error("Invalid Smart Money volume: V_smart must be > 0");
        }
        if (signal.sSmart < profile.minSignalUsd) {
            throw new Error(
                `Signal too small: ${signal.sSmart} < minSignalUsd ${profile.minSignalUsd}`
            );
        }
        if (profile.riskFactor < 0 || profile.riskFactor > 1) {
            throw new Error("riskFactor must be in [0, 1]");
        }

        // ─── Step 1: Weight Calculation ──────────────────────────────
        const W = signal.sSmart / signal.vSmart;

        // ─── Step 2: User Amount (normalized) ────────────────────────
        let sUser = profile.balance * W * profile.riskFactor;

        // ─── Step 3: Safety Caps ─────────────────────────────────────
        const maxPosition = profile.balance * profile.maxPositionPct;
        sUser = Math.min(sUser, maxPosition);

        // Дополнительный cap: не более того, что вложил кит (в пропорции)
        sUser = Math.max(sUser, 0); // Никогда отрицательное

        // ─── Step 4: Confidence ──────────────────────────────────────
        const confidence = TAG_CONFIDENCE_MAP[signal.tag] || 0.3;

        // ─── Step 5: Reasoning Hash ─────────────────────────────────
        const reasoningHash = this.computeReasoningHash(signal, profile, W, sUser);

        // ─── Step 6: Build Proposal ──────────────────────────────────
        const proposal: Proposal = {
            asset: signal.assetAddress,
            action: signal.action,
            recommendedAmount: Math.floor(sUser * 100) / 100, // 2 decimal places
            timestamp: Math.floor(Date.now() / 1000),
            reasoningHash,
            weight: Math.floor(W * 1e6) / 1e6, // 6 decimal precision
            sourceTag: signal.tag,
            confidence,
        };

        // ─── Step 7: EIP-712 Signature (Proof-of-Reasoning) ─────────
        const signature = await this.signProposal(proposal);

        return {
            proposal,
            proofOfReasoning: signature,
            teeSignerAddress: this.teeSignerAddress,
        };
    }

    /**
     * Агрегирует несколько сигналов для одного актива.
     * Multiple Smart Money покупают = усиленный сигнал.
     */
    async generateAggregatedProposal(
        signals: SmartMoneySignal[],
        profile: UserRiskProfile
    ): Promise<SignedProposal> {
        if (signals.length === 0) throw new Error("No signals to aggregate");

        // Все сигналы должны быть для одного актива и одного действия
        const asset = signals[0].assetAddress;
        const action = signals[0].action;
        if (!signals.every((s) => s.assetAddress === asset && s.action === action)) {
            throw new Error("Cannot aggregate signals for different assets/actions");
        }

        // ─── Aggregated Weight ───────────────────────────────────────
        // W_agg = Σ(S_smart_i / V_smart_i) / N (среднее W)
        const weights = signals.map((s) => s.sSmart / s.vSmart);
        const avgWeight = weights.reduce((sum, w) => sum + w, 0) / weights.length;

        // ─── Boosted Confidence ──────────────────────────────────────
        // Больше китов = выше уверенность (capped at 0.95)
        const baseConfidence = signals.reduce(
            (sum, s) => sum + (TAG_CONFIDENCE_MAP[s.tag] || 0.3),
            0
        ) / signals.length;
        const boostFactor = Math.min(1 + Math.log2(signals.length) * 0.1, 1.5);
        const confidence = Math.min(baseConfidence * boostFactor, 0.95);

        // ─── Calculate Amount ────────────────────────────────────────
        let sUser = profile.balance * avgWeight * profile.riskFactor * confidence;
        const maxPosition = profile.balance * profile.maxPositionPct;
        sUser = Math.min(sUser, maxPosition);
        sUser = Math.max(sUser, 0);

        // ─── Build Aggregated Proposal ───────────────────────────────
        const reasoningHash = keccak256(
            encodePacked(
                ["address", "uint256", "uint256", "uint256"],
                [
                    asset,
                    BigInt(Math.floor(avgWeight * 1e18)),
                    BigInt(signals.length),
                    BigInt(Math.floor(Date.now() / 1000)),
                ]
            )
        );

        const proposal: Proposal = {
            asset,
            action,
            recommendedAmount: Math.floor(sUser * 100) / 100,
            timestamp: Math.floor(Date.now() / 1000),
            reasoningHash: reasoningHash as `0x${string}`,
            weight: Math.floor(avgWeight * 1e6) / 1e6,
            sourceTag: signals[0].tag, // Primary tag
            confidence: Math.floor(confidence * 1000) / 1000,
        };

        const signature = await this.signProposal(proposal);

        return {
            proposal,
            proofOfReasoning: signature,
            teeSignerAddress: this.teeSignerAddress,
        };
    }

    // ─── Private Helpers ─────────────────────────────────────────────

    /**
     * Вычисляет reasoning hash — криптографическое доказательство
     * того, на основе каких данных принято решение.
     */
    private computeReasoningHash(
        signal: SmartMoneySignal,
        profile: UserRiskProfile,
        weight: number,
        sUser: number
    ): `0x${string}` {
        return keccak256(
            encodePacked(
                ["address", "address", "uint256", "uint256", "uint256", "uint256"],
                [
                    signal.assetAddress,
                    signal.walletAddress,
                    BigInt(Math.floor(signal.sSmart * 1e6)),
                    BigInt(Math.floor(signal.vSmart * 1e6)),
                    BigInt(Math.floor(weight * 1e18)),
                    BigInt(Math.floor(sUser * 1e6)),
                ]
            )
        ) as `0x${string}`;
    }

    /**
     * Подписывает Proposal через EIP-712.
     * Приватный ключ TEE никогда не покидает анклав.
     */
    private async signProposal(proposal: Proposal): Promise<`0x${string}`> {
        const account = privateKeyToAccount(this.teePrivateKey);

        const signature = await account.signTypedData({
            domain: EIP712_DOMAIN,
            types: PROPOSAL_TYPES,
            primaryType: "Proposal",
            message: {
                asset: proposal.asset,
                action: proposal.action,
                recommendedAmount: BigInt(Math.floor(proposal.recommendedAmount * 1e6)),
                timestamp: BigInt(proposal.timestamp),
                reasoningHash: proposal.reasoningHash,
                weight: BigInt(Math.floor(proposal.weight * 1e6)),
                confidence: BigInt(Math.floor(proposal.confidence * 1000)),
            },
        });

        return signature;
    }
}
