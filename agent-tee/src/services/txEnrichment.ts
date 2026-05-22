// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — agent-tee/src/services/txEnrichment.ts
// Phase 5: Transaction Enrichment — RWA context identification + metadata
//
// PIPELINE:
//   Raw Transaction (from Nansen/RPC)
//     → decode Transfer/Approval events (eth_getLogs)
//     → match token addresses against rwaRegistry
//     → classify action_type (deposit | withdraw | transfer)
//     → attach rwaContext to enriched transaction
//
// ИНВАРИАНТЫ:
//   - Enrichment — pure data transformation, no side effects
//   - Не модифицирует исходную транзакцию (возвращает новый объект)
//   - Graceful: если RPC fails, rwaContext = null (не блокирует pipeline)
//   - Все адреса нормализованы к lowercase для lookup
// ═══════════════════════════════════════════════════════════════════════════════

import {
    createPublicClient,
    fallback,
    http,
    parseAbiItem,
    decodeEventLog,
    type Address,
    type Hex,
    type Log,
    type PublicClient,
    type Transport,
    type Chain,
} from "viem";
import { mantle } from "viem/chains";
import {
    RWA_REGISTRY,
    RWA_ADDRESSES,
    RWA_RELATED_CONTRACTS,
    lookupRwaAsset,
    type RwaAssetEntry,
    type RiskClassification,
    type AssetType,
} from "../config/rwaRegistry.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Тип операции с RWA-активом.
 *
 * - deposit: средства входят в RWA-протокол (mint mETH, buy USDY)
 * - withdraw: средства выходят из RWA (redeem, unstake)
 * - transfer: перемещение RWA-токенов между кошельками (P2P, CEX deposit)
 */
export type RwaActionType = "deposit" | "withdraw" | "transfer";

/**
 * Контекст RWA для обогащённой транзакции.
 * Присутствует ТОЛЬКО если транзакция взаимодействует с RWA-активом.
 */
export interface RwaContext {
    /** Флаг: транзакция содержит RWA-взаимодействие */
    isRwa: true;
    /** Название протокола-эмитента (Ondo Finance, Mantle LSP, etc.) */
    protocol: string;
    /** Символ RWA-актива (USDY, mETH, cmETH) */
    symbol: string;
    /** Тип операции: deposit / withdraw / transfer */
    actionType: RwaActionType;
    /** Тип актива (lsd, lrt, tokenized_yield) */
    assetType: AssetType;
    /** Классификация риска */
    riskClassification: RiskClassification;
    /** Примерная APY в bps */
    estimatedApyBps: number;
    /** Базовый актив (ETH, USD, mETH) */
    underlying: string;
    /** Если совпадение через related contract — его роль */
    contractRole?: string;
}

/**
 * Сырая транзакция (вход для enrichment).
 */
export interface RawTransaction {
    hash: Hex;
    from: Address;
    to: Address | null;
    value: bigint;
    input: Hex;
    blockNumber: bigint;
    /** Token transfers extracted from logs (может быть пустым до enrichment) */
    tokenTransfers?: TokenTransfer[];
}

/**
 * Извлечённый ERC-20 Transfer из event log.
 */
export interface TokenTransfer {
    tokenAddress: Address;
    from: Address;
    to: Address;
    value: bigint;
    /** Заполняется при enrichment если token ∈ RWA_REGISTRY */
    symbol?: string;
}

/**
 * Обогащённая транзакция — результат enrichment pipeline.
 */
export interface EnrichedTransaction {
    /** Оригинальные поля */
    hash: Hex;
    from: Address;
    to: Address | null;
    value: bigint;
    input: Hex;
    blockNumber: bigint;

    /** Все ERC-20 transfers внутри транзакции */
    tokenTransfers: TokenTransfer[];

    /** RWA контекст (null если нет взаимодействия с RWA) */
    rwaContext: RwaContext | null;

    /** Дополнительные метаданные */
    meta: {
        /** Timestamp enrichment-а */
        enrichedAt: number;
        /** Количество event logs проанализировано */
        logsAnalyzed: number;
        /** Совпадений с RWA registry найдено */
        rwaMatchesFound: number;
    };
}

// ─── ERC-20 Transfer Event ────────────────────────────────────────────────────

const ERC20_TRANSFER_EVENT = parseAbiItem(
    "event Transfer(address indexed from, address indexed to, uint256 value)"
);

// ─── Known DEX/Pool Addresses (для определения deposit/withdraw vs transfer) ─

/**
 * Известные адреса DEX/AMM пулов и роутеров на Mantle.
 * Если from/to ∈ DEX_ADDRESSES → это deposit/withdraw (не простой transfer).
 */
const DEX_AND_POOL_ADDRESSES: ReadonlySet<string> = new Set([
    // Merchant Moe
    "0xc36f97c49e9c5f3c1da81e4a6e5b0c4fdc2d3e5f", // Merchant Moe Router
    "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64", // Merchant Moe Factory
    // Agni Finance
    "0x319B69888b0d11cEC22caA5034e25FfFBDc88421", // Agni Router
    "0xe9827B4EBeB9AE41FC57efDdDd79EDddC2EA4d03", // Agni Factory
    // INIT Capital
    "0x972BcD3983862c4e6E3bf47a5C8C4EFb6C980029", // INIT Position Manager
    // FusionX
    "0x5989FB161568b9F133eDf5Cf6787f5597762797F", // FusionX Router
].map((a) => a.toLowerCase()));

/**
 * Адреса нулевые (mint/burn detection).
 */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ═══════════════════════════════════════════════════════════════════════════════
//                          TxEnrichmentService CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class TxEnrichmentService {
    private readonly publicClient: PublicClient<Transport, Chain>;

    constructor(rpcUrl?: string, fallbackUrls?: string[]) {
        const transports = [
            http(rpcUrl ?? "https://rpc.mantle.xyz"),
            ...(fallbackUrls ?? ["https://rpc.ankr.com/mantle"]).map((u) => http(u)),
        ];

        this.publicClient = createPublicClient({
            chain: mantle,
            transport: fallback(transports, { rank: false }),
        }) as PublicClient<Transport, Chain>;
    }

    // ─── Main Enrichment Pipeline ─────────────────────────────────────────────

    /**
     * Обогащает сырую транзакцию:
     * 1. Извлекает ERC-20 Transfer events из receipt logs
     * 2. Проверяет каждый token address и tx.to против rwaRegistry
     * 3. Классифицирует action_type
     * 4. Возвращает EnrichedTransaction с rwaContext
     *
     * @param tx — сырая транзакция
     * @returns EnrichedTransaction (rwaContext = null если нет RWA)
     */
    async enrich(tx: RawTransaction): Promise<EnrichedTransaction> {
        const enrichedAt = Math.floor(Date.now() / 1000);
        let logsAnalyzed = 0;
        let rwaMatchesFound = 0;
        let tokenTransfers: TokenTransfer[] = tx.tokenTransfers ?? [];
        let rwaContext: RwaContext | null = null;

        try {
            // ─── Step 1: Fetch transaction receipt logs ───────────────────
            if (tokenTransfers.length === 0) {
                const receipt = await this.publicClient.getTransactionReceipt({
                    hash: tx.hash,
                });

                logsAnalyzed = receipt.logs.length;

                // Decode ERC-20 Transfer events
                tokenTransfers = this.decodeTransferLogs(receipt.logs as Log[]);
            }

            // ─── Step 2: Check tx.to against RWA registry ────────────────
            if (tx.to) {
                const directMatch = lookupRwaAsset(tx.to);
                if (directMatch) {
                    rwaMatchesFound++;
                    rwaContext = this.buildRwaContext(
                        directMatch.asset,
                        this.classifyActionByTxTarget(tx, directMatch.asset),
                        directMatch.matchType === "related_contract" ? directMatch.role : undefined
                    );
                }
            }

            // ─── Step 3: Check token transfers against RWA registry ──────
            if (!rwaContext) {
                for (const transfer of tokenTransfers) {
                    const tokenMatch = lookupRwaAsset(transfer.tokenAddress);
                    if (tokenMatch) {
                        rwaMatchesFound++;
                        rwaContext = this.buildRwaContext(
                            tokenMatch.asset,
                            this.classifyActionByTransfer(transfer, tx.from),
                            tokenMatch.matchType === "related_contract" ? tokenMatch.role : undefined
                        );

                        // Enrich token transfer with symbol
                        transfer.symbol = tokenMatch.asset.symbol;
                        break; // Берём первый RWA-матч (приоритет)
                    }
                }
            }

            // ─── Step 4: Check if any log address is RWA-related ─────────
            // Некоторые протоколы эмитят events из proxy/pool контрактов
            if (!rwaContext && logsAnalyzed > 0) {
                const receipt = await this.publicClient.getTransactionReceipt({
                    hash: tx.hash,
                });

                for (const log of receipt.logs) {
                    const logAddress = (log.address as string).toLowerCase();
                    const relatedMatch = RWA_RELATED_CONTRACTS.get(logAddress);

                    if (relatedMatch) {
                        rwaMatchesFound++;
                        const actionType = this.inferActionFromRole(relatedMatch.role, tx.from);
                        rwaContext = this.buildRwaContext(
                            relatedMatch.parent,
                            actionType,
                            relatedMatch.role
                        );
                        break;
                    }
                }
            }
        } catch (err) {
            // Graceful degradation: enrichment failure → rwaContext = null
            console.warn(
                `[TxEnrichment] Failed to enrich tx ${tx.hash.slice(0, 16)}:`,
                err instanceof Error ? err.message : err
            );
        }

        return {
            hash: tx.hash,
            from: tx.from,
            to: tx.to,
            value: tx.value,
            input: tx.input,
            blockNumber: tx.blockNumber,
            tokenTransfers,
            rwaContext,
            meta: {
                enrichedAt,
                logsAnalyzed,
                rwaMatchesFound,
            },
        };
    }

    /**
     * Batch enrichment для массива транзакций.
     * Параллельно (с concurrency limit) обогащает каждую.
     */
    async enrichBatch(
        transactions: RawTransaction[],
        concurrency: number = 5
    ): Promise<EnrichedTransaction[]> {
        const results: EnrichedTransaction[] = [];

        // Process in chunks to respect RPC rate limits
        for (let i = 0; i < transactions.length; i += concurrency) {
            const chunk = transactions.slice(i, i + concurrency);
            const enriched = await Promise.all(
                chunk.map((tx) => this.enrich(tx))
            );
            results.push(...enriched);
        }

        return results;
    }

    /**
     * Быстрая проверка: содержит ли транзакция RWA-взаимодействие
     * (без полного enrichment — только по tx.to и known token addresses).
     */
    quickRwaCheck(tx: RawTransaction): boolean {
        // Check tx.to
        if (tx.to && (RWA_ADDRESSES.has(tx.to.toLowerCase()) ||
            RWA_RELATED_CONTRACTS.has(tx.to.toLowerCase()))) {
            return true;
        }

        // Check pre-fetched token transfers
        if (tx.tokenTransfers) {
            for (const transfer of tx.tokenTransfers) {
                if (RWA_ADDRESSES.has(transfer.tokenAddress.toLowerCase())) {
                    return true;
                }
            }
        }

        return false;
    }

    // ─── Private: Log Decoding ────────────────────────────────────────────────

    /**
     * Извлекает ERC-20 Transfer events из массива logs.
     */
    private decodeTransferLogs(logs: Log[]): TokenTransfer[] {
        const transfers: TokenTransfer[] = [];
        const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

        for (const log of logs) {
            // ERC-20 Transfer: topic[0] == Transfer(address,address,uint256)
            if (
                log.topics[0] === transferTopic &&
                log.topics.length >= 3 &&
                log.data
            ) {
                try {
                    const from = ("0x" + (log.topics[1] as string).slice(26)) as Address;
                    const to = ("0x" + (log.topics[2] as string).slice(26)) as Address;
                    const value = BigInt(log.data);

                    transfers.push({
                        tokenAddress: log.address as Address,
                        from,
                        to,
                        value,
                    });
                } catch {
                    // Malformed log — skip
                }
            }
        }

        return transfers;
    }

    // ─── Private: Action Classification ───────────────────────────────────────

    /**
     * Классифицирует action_type когда tx.to напрямую совпадает с RWA-контрактом.
     *
     * Логика:
     * - tx.to == staking_pool/token → deposit (пользователь отправляет средства в протокол)
     * - Если input содержит known withdrawal selector → withdraw
     * - Default: deposit (most common case)
     */
    private classifyActionByTxTarget(tx: RawTransaction, asset: RwaAssetEntry): RwaActionType {
        const input = tx.input.toLowerCase();

        // Known withdrawal/redeem function selectors
        const WITHDRAW_SELECTORS = [
            "0x2e1a7d4d", // withdraw(uint256)
            "0x3ccfd60b", // withdraw()
            "0xdb006a75", // redeem(uint256)
            "0xba087652", // redeem(uint256,address,address)
            "0x7d41c057", // requestWithdrawal
        ];

        for (const selector of WITHDRAW_SELECTORS) {
            if (input.startsWith(selector)) {
                return "withdraw";
            }
        }

        // Known deposit selectors (explicit confirmation)
        const DEPOSIT_SELECTORS = [
            "0xd0e30db0", // deposit()
            "0xb6b55f25", // deposit(uint256)
            "0x6e553f65", // deposit(uint256,address)
            "0xa694fc3a", // stake(uint256)
            "0x47e7ef24", // deposit(address,uint256)
        ];

        for (const selector of DEPOSIT_SELECTORS) {
            if (input.startsWith(selector)) {
                return "deposit";
            }
        }

        // If tx sends value (native) to staking pool → deposit
        if (tx.value > 0n) {
            return "deposit";
        }

        // Default: deposit (пользователь взаимодействует с контрактом RWA)
        return "deposit";
    }

    /**
     * Классифицирует action_type по ERC-20 Transfer event.
     *
     * Логика:
     * - from == 0x0 → mint (deposit — пользователь получает RWA токены)
     * - to == 0x0 → burn (withdraw — пользователь сжигает RWA)
     * - from == DEX/Pool → withdraw from pool (getting RWA back)
     * - to == DEX/Pool → deposit into pool (providing RWA liquidity)
     * - from == user → transfer out
     * - to == user → transfer in
     */
    private classifyActionByTransfer(transfer: TokenTransfer, txSender: Address): RwaActionType {
        const from = transfer.from.toLowerCase();
        const to = transfer.to.toLowerCase();
        const sender = txSender.toLowerCase();

        // Mint: 0x0 → user (deposit completed, user received RWA tokens)
        if (from === ZERO_ADDRESS) {
            return "deposit";
        }

        // Burn: user → 0x0 (withdraw initiated, user burning RWA tokens)
        if (to === ZERO_ADDRESS) {
            return "withdraw";
        }

        // User sends RWA to DEX/pool → deposit into pool
        if (from === sender && DEX_AND_POOL_ADDRESSES.has(to)) {
            return "deposit";
        }

        // User receives RWA from DEX/pool → withdraw from pool
        if (to === sender && DEX_AND_POOL_ADDRESSES.has(from)) {
            return "withdraw";
        }

        // Default: simple transfer between wallets
        return "transfer";
    }

    /**
     * Выводит action_type из роли related contract.
     */
    private inferActionFromRole(role: string, txSender: Address): RwaActionType {
        switch (role) {
            case "staking_pool":
            case "restaking_pool":
                return "deposit";
            case "withdrawal_queue":
                return "withdraw";
            case "rewards_distributor":
                return "withdraw"; // Claiming rewards
            default:
                return "transfer";
        }
    }

    // ─── Private: Context Builder ─────────────────────────────────────────────

    /**
     * Конструирует RwaContext из найденного совпадения.
     */
    private buildRwaContext(
        asset: RwaAssetEntry,
        actionType: RwaActionType,
        contractRole?: string
    ): RwaContext {
        return {
            isRwa: true,
            protocol: asset.protocolName,
            symbol: asset.symbol,
            actionType,
            assetType: asset.assetType,
            riskClassification: asset.riskClassification,
            estimatedApyBps: asset.estimatedApyBps,
            underlying: asset.underlying,
            ...(contractRole ? { contractRole } : {}),
        };
    }
}
