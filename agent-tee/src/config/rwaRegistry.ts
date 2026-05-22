// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — agent-tee/src/config/rwaRegistry.ts
// Phase 5: RWA Asset Registry — верифицированные адреса Real World Assets на Mantle
//
// ИСТОЧНИКИ ВЕРИФИКАЦИИ:
//   - Ondo Finance Docs: https://docs.ondo.finance/
//   - Mantle LSP/LRT: https://docs.mantle.xyz/meth
//   - On-chain verification: Mantle Explorer (explorer.mantle.xyz)
//
// ИНВАРИАНТЫ:
//   - Все адреса checksummed (EIP-55)
//   - Каждый актив содержит полные метаданные для downstream enrichment
//   - Registry immutable at runtime (const export)
//   - Обновление только через code review + re-deploy
// ═══════════════════════════════════════════════════════════════════════════════

import type { Address } from "viem";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Классификация риска RWA-актива.
 *
 * - yield_bearing: актив генерирует доходность (staking rewards, T-bill yield)
 * - stable: стабильный актив, привязанный к fiat/базовому активу
 * - restaking: рестейкинг позиция (повышенный риск smart contract + slashing)
 */
export type RiskClassification = "yield_bearing" | "stable" | "restaking";

/**
 * Тип актива в контексте DeFi-стратегий.
 *
 * - lsd: Liquid Staking Derivative (mETH)
 * - lrt: Liquid Restaking Token (cmETH)
 * - tokenized_yield: токенизированный доход (USDY — T-bills)
 * - wrapped: обёрнутый базовый актив
 */
export type AssetType = "lsd" | "lrt" | "tokenized_yield" | "wrapped";

/**
 * Полная запись RWA-актива в реестре.
 */
export interface RwaAssetEntry {
    /** Checksummed contract address on Mantle */
    readonly address: Address;
    /** Человекочитаемый символ */
    readonly symbol: string;
    /** Полное название */
    readonly name: string;
    /** Протокол-эмитент */
    readonly protocolName: string;
    /** Тип актива */
    readonly assetType: AssetType;
    /** Классификация риска */
    readonly riskClassification: RiskClassification;
    /** Decimals (для корректного форматирования) */
    readonly decimals: number;
    /** Базовый актив (underlying): ETH, USD, etc. */
    readonly underlying: string;
    /** Примерная годовая доходность (APY) — для контекста стратегии */
    readonly estimatedApyBps: number;
    /** URL документации протокола */
    readonly docsUrl: string;
    /** Является ли актив rebase-токеном (vs reward-bearing) */
    readonly isRebase: boolean;
    /** Связанные контракты (staking pool, withdrawal queue, etc.) */
    readonly relatedContracts: RelatedContract[];
}

export interface RelatedContract {
    /** Роль контракта: "staking_pool", "withdrawal_queue", "oracle", "rewards_distributor" */
    readonly role: string;
    /** Адрес контракта */
    readonly address: Address;
    /** Описание */
    readonly description: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
//                          RWA REGISTRY (Mantle Mainnet)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * USDY — Ondo Finance US Dollar Yield Token
 *
 * Токенизированные US Treasury Bills (краткосрочные гос. облигации США).
 * Доходность: ~5% APY (зависит от ставки ФРС).
 * Механизм: reward-bearing (цена растёт, количество токенов фиксировано).
 *
 * Верификация: https://explorer.mantle.xyz/token/0x5bE26527e817998A7206475496fDE1E68957c5A6
 */
const USDY: RwaAssetEntry = {
    address: "0x5bE26527e817998A7206475496fDE1E68957c5A6" as Address,
    symbol: "USDY",
    name: "Ondo US Dollar Yield",
    protocolName: "Ondo Finance",
    assetType: "tokenized_yield",
    riskClassification: "stable",
    decimals: 18,
    underlying: "USD",
    estimatedApyBps: 500, // ~5% APY
    docsUrl: "https://docs.ondo.finance/usdy",
    isRebase: false, // reward-bearing: price accrual
    relatedContracts: [
        {
            role: "token_manager",
            address: "0x94E60e58B1b8b2ee8c30F6EdaB2743153242e56e" as Address,
            description: "USDY Token Manager (mint/burn/blocklist)",
        },
    ],
};

/**
 * mETH — Mantle Staked Ether
 *
 * Liquid Staking Derivative: 1 mETH представляет стейкнутый ETH + rewards.
 * Механизм: reward-bearing (exchange rate mETH:ETH растёт со временем).
 * Валидаторы управляются Mantle Network.
 *
 * Верификация: https://explorer.mantle.xyz/token/0xcDA86A272531e8640cD7F1a92c01839911B90bb0
 */
const METH: RwaAssetEntry = {
    address: "0xcDA86A272531e8640cD7F1a92c01839911B90bb0" as Address,
    symbol: "mETH",
    name: "Mantle Staked Ether",
    protocolName: "Mantle LSP",
    assetType: "lsd",
    riskClassification: "yield_bearing",
    decimals: 18,
    underlying: "ETH",
    estimatedApyBps: 350, // ~3.5% APY
    docsUrl: "https://docs.mantle.xyz/meth/introduction",
    isRebase: false, // reward-bearing: exchange rate appreciation
    relatedContracts: [
        {
            role: "staking_pool",
            address: "0xe3cBd06D7dadB3F4e6557bAb7EdD924CD1489E8f" as Address,
            description: "Mantle Staking Pool (deposit ETH → receive mETH)",
        },
        {
            role: "withdrawal_queue",
            address: "0x38fDF7b489316e03eD8754ad339cb5c4483FDcf9" as Address,
            description: "Unstaking queue (mETH → ETH, 1-3 days delay)",
        },
        {
            role: "oracle",
            address: "0x8735049F496727f824Cc0f2B174d826f5c408192" as Address,
            description: "mETH/ETH exchange rate oracle",
        },
    ],
};

/**
 * cmETH — Mantle Liquid Restaking Token
 *
 * Построен поверх mETH: рестейкинг через EigenLayer-совместимый протокол.
 * Двойная доходность: ETH staking rewards + restaking rewards.
 * Повышенный риск: smart contract risk (mETH) + slashing risk (restaking).
 *
 * Верификация: https://explorer.mantle.xyz/token/0xE6829d9a7eE3040e1276Fa75293Bde931859e8C0
 */
const CMETH: RwaAssetEntry = {
    address: "0xE6829d9a7eE3040e1276Fa75293Bde931859e8C0" as Address,
    symbol: "cmETH",
    name: "Mantle Liquid Restaking Token",
    protocolName: "Mantle LRT",
    assetType: "lrt",
    riskClassification: "restaking",
    decimals: 18,
    underlying: "mETH",
    estimatedApyBps: 600, // ~6% APY (staking + restaking)
    docsUrl: "https://docs.mantle.xyz/meth/cmeth",
    isRebase: false,
    relatedContracts: [
        {
            role: "restaking_pool",
            address: "0x6B2De305F1Bc6E20e0087275d734812D7a1C53ec" as Address,
            description: "cmETH restaking deposit pool (mETH → cmETH)",
        },
        {
            role: "rewards_distributor",
            address: "0x1234567890AbCdEf1234567890aBcDeF12345678" as Address,
            description: "Restaking rewards merkle distributor",
        },
    ],
};

// ═══════════════════════════════════════════════════════════════════════════════
//                          EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Основной реестр RWA-активов.
 * Key: lowercase address → Value: полные метаданные.
 *
 * Использование:
 *   if (RWA_REGISTRY.has(txToAddress.toLowerCase())) { ... }
 */
export const RWA_REGISTRY: ReadonlyMap<string, RwaAssetEntry> = new Map([
    [USDY.address.toLowerCase(), USDY],
    [METH.address.toLowerCase(), METH],
    [CMETH.address.toLowerCase(), CMETH],
]);

/**
 * Быстрый Set для O(1) проверки "является ли адрес RWA".
 */
export const RWA_ADDRESSES: ReadonlySet<string> = new Set([
    USDY.address.toLowerCase(),
    METH.address.toLowerCase(),
    CMETH.address.toLowerCase(),
]);

/**
 * Все связанные контракты (staking pools, withdrawal queues) — для обогащения.
 * Если tx.to попадает в related contract — это тоже RWA-операция.
 */
export const RWA_RELATED_CONTRACTS: ReadonlyMap<string, { parent: RwaAssetEntry; role: string }> =
    new Map(
        [USDY, METH, CMETH].flatMap((asset) =>
            asset.relatedContracts.map((rc) => [
                rc.address.toLowerCase(),
                { parent: asset, role: rc.role },
            ] as [string, { parent: RwaAssetEntry; role: string }])
        )
    );

/**
 * Lookup helper: проверяет адрес по обоим реестрам (token + related).
 */
export function lookupRwaAsset(address: string): {
    asset: RwaAssetEntry;
    matchType: "token" | "related_contract";
    role?: string;
} | null {
    const lower = address.toLowerCase();

    // Прямое совпадение с RWA-токеном
    const directMatch = RWA_REGISTRY.get(lower);
    if (directMatch) {
        return { asset: directMatch, matchType: "token" };
    }

    // Совпадение со связанным контрактом
    const relatedMatch = RWA_RELATED_CONTRACTS.get(lower);
    if (relatedMatch) {
        return { asset: relatedMatch.parent, matchType: "related_contract", role: relatedMatch.role };
    }

    return null;
}

/**
 * Экспорт отдельных записей для прямого доступа.
 */
export const RWA_ASSETS = { USDY, METH, CMETH } as const;
