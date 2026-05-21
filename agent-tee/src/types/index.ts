// Файл: agent-tee/src/types/index.ts
// Общие типы для TEE-агента AlphaFlow Suite

export type NansenTag = "Fund" | "VC" | "90D Smart Trader" | "Whale" | "Flash Trader";

export interface SmartMoneySignal {
    /** Адрес актива на Mantle */
    assetAddress: `0x${string}`;
    /** Действие: покупка или продажа */
    action: "BUY" | "SELL";
    /** Объём сделки кита (USD) */
    sSmart: number;
    /** Общий капитал кита (USD) */
    vSmart: number;
    /** Тег кита из Nansen */
    tag: NansenTag;
    /** Адрес кошелька кита */
    walletAddress: `0x${string}`;
    /** Timestamp транзакции */
    txTimestamp: number;
    /** Hash транзакции для верификации */
    txHash: `0x${string}`;
}

export interface UserRiskProfile {
    /** Баланс пользователя (USD) — V_user */
    balance: number;
    /** Множитель консерватизма: 0 = пауза, 0.1 = консервативный, 1.0 = агрессивный */
    riskFactor: number;
    /** Максимальная доля портфеля на одну позицию (0.2 = 20%) */
    maxPositionPct: number;
    /** Минимальный объём сделки кита для триггера (USD) */
    minSignalUsd: number;
}

export interface Proposal {
    asset: `0x${string}`;
    action: "BUY" | "SELL";
    recommendedAmount: number;
    timestamp: number;
    reasoningHash: `0x${string}`;
    weight: number;
    sourceTag: NansenTag;
    confidence: number;
}

export interface SignedProposal {
    proposal: Proposal;
    proofOfReasoning: `0x${string}`;
    teeSignerAddress: `0x${string}`;
}

export interface NansenWalletData {
    address: `0x${string}`;
    tags: NansenTag[];
    totalValueUsd: number;
    recentTxs: NansenTransaction[];
}

export interface NansenTransaction {
    hash: `0x${string}`;
    timestamp: number;
    tokenAddress: `0x${string}`;
    tokenSymbol: string;
    action: "BUY" | "SELL";
    amountUsd: number;
    chain: string;
}

export interface RateLimitConfig {
    /** Максимум UserOps в минуту */
    maxOpsPerMinute: number;
    /** Максимум UserOps в час */
    maxOpsPerHour: number;
    /** Пауза после revert (секунды) */
    revertCooldownSec: number;
}

export interface ArbOpportunity {
    tokenA: `0x${string}`;
    tokenB: `0x${string}`;
    borrowAmount: bigint;
    minProfitTokenA: bigint;
    dexPayloadRoute1: `0x${string}`;
    dexPayloadRoute2: `0x${string}`;
}
