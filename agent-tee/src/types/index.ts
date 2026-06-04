// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — agent-tee/src/types/index.ts
// Типизация доменных сущностей TEE-агента
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Сигнал от Nansen MCP — информация о действии Smart Money кошелька.
 * Приходит через NansenClient, используется YieldArchitect для расчёта стратегии.
 */
export interface SmartMoneySignal {
    /** Адрес Smart Money кошелька (checksummed) */
    readonly walletAddress: string;

    /** Тег кошелька: "Fund", "VC", "90D Smart Trader" */
    readonly walletTag: string;

    /** Репутационный скор кошелька [0.0 - 1.0] */
    readonly reputationScore: number;

    /** Адрес актива (ERC-20 token address) */
    readonly asset: string;

    /** Тикер актива (WMNT, USDC, FBTC) */
    readonly assetSymbol: string;

    /** Действие: покупка или продажа */
    readonly action: "BUY" | "SELL";

    /** Объём сделки Smart Money в wei (tokenDecimals) */
    readonly tradeVolume: bigint;

    /** Общий капитал кошелька Smart Money в wei (USD-нормализованный) */
    readonly totalPortfolioValue: bigint;

    /** Unix timestamp обнаружения сигнала */
    readonly detectedAt: number;

    /** Хэш транзакции-источника */
    readonly sourceTxHash: string;
}

/**
 * Риск-профиль пользователя — конфигурация, определяющая агрессивность стратегии.
 * Загружается из Redis при инициализации цикла.
 */
export interface UserRiskProfile {
    /** Адрес Smart Account (ZeroDev Kernel) пользователя */
    readonly accountAddress: string;

    /** Доступный баланс пользователя для торговли (в wei, основной токен) */
    readonly availableBalance: bigint;

    /** Коэффициент риска K_risk ∈ [0.1, 1.0]
     *  0.1 = conservative (10% от рассчитанного объёма)
     *  1.0 = aggressive (100% от рассчитанного объёма)
     */
    readonly riskCoefficient: number;

    /** Максимально допустимый slippage в basis points (100 = 1%) */
    readonly maxSlippageBps: number;

    /** Минимальный профит для автоматического исполнения (в wei) */
    readonly minProfitThreshold: bigint;
}

/**
 * Proposal — структура рекомендации, формируемая YieldArchitect.
 * Подписывается EIP-712 внутри TEE анклава.
 *
 * ИНВАРИАНТ: reasoningHash доказывает, что рекомендация вычислена на основе
 * конкретных входных данных (signal + profile), а не произвольно.
 */
export interface Proposal {
    /** Адрес целевого актива (ERC-20) */
    readonly asset: string;

    /** Действие: "BUY" или "SELL" */
    readonly action: string;

    /** Рекомендуемый объём операции (в wei) */
    readonly recommendedAmount: bigint;

    /** Монотонный nonce (счётчик внутри TEE, replay protection) */
    readonly nonce: number;

    /** Unix timestamp истечения (после deadline proposal невалиден) */
    readonly deadline: number;

    /** keccak256 хэш входных данных: signal + profile + computation params.
     *  Позволяет верифицировать: решение принято на основе этих конкретных данных.
     */
    readonly reasoningHash: string;

    /**
     * keccak256 хэш инсайта (Proof-of-Alpha).
     * Закоммичен on-chain в AlphaAuditor ДО публикации proposal.
     * encode(['address', 'string', 'uint256', 'uint256'], [asset, action, amount, timestamp])
     */
    readonly insightHash: string;

    /**
     * Transaction hash коммита insightHash в AlphaAuditor on-chain.
     * Подтверждает, что insight зафиксирован до публикации рекомендации.
     * Pipeline invariant: proposal НЕ публикуется без этого поля.
     */
    readonly commitTxHash: string;
}

/**
 * Подписанный Proposal — расширяет Proposal подписью EIP-712.
 * Это финальная структура, публикуемая в Redis для Telegram HITL бота.
 */
export interface SignedProposal extends Proposal {
    /** EIP-712 подпись (hex, 65 bytes: r + s + v) */
    readonly signature: string;

    /** Публичный адрес TEE-signer (для верификации подписи) */
    readonly signerAddress: string;

    /** Unix timestamp генерации */
    readonly generatedAt: number;
}

/**
 * EIP-712 Domain для AlphaFlow TEE (Proposal подпись — legacy Proof-of-Reasoning).
 * Используется при подписании Proposals.
 */
export interface EIP712Domain {
    readonly name: string;
    readonly version: string;
    readonly chainId: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SWARM MODE: MicroFundingDispatcher EIP-712 Types
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ForwardRequest — структура, подписываемая TEE-агентом для MicroFundingDispatcher.
 * Relayer (Byreal Swarm Worker) отправляет её on-chain и получает MNT рефанд.
 *
 * Соответствует on-chain struct:
 *   struct ForwardRequest {
 *       address target;
 *       bytes data;
 *       uint256 value;
 *       uint256 nonce;
 *       uint256 deadline;
 *   }
 */
export interface ForwardRequest {
    /** Адрес целевого контракта (ActiveSentinel) */
    readonly target: `0x${string}`;
    /** Encoded calldata (executeFlashArbitrage) */
    readonly data: `0x${string}`;
    /** msg.value для вызова (обычно 0n для flash arb) */
    readonly value: bigint;
    /** Monotonic nonce TEE-агента (replay protection в Dispatcher) */
    readonly nonce: bigint;
    /** Unix timestamp deadline (секунды) */
    readonly deadline: bigint;
}

/**
 * EIP-712 конфигурация для MicroFundingDispatcher.
 * Должна совпадать с on-chain конструктором:
 *   EIP712("MicroFundingDispatcher", "1")
 */
export const DISPATCHER_EIP712_DOMAIN = {
    name: "MicroFundingDispatcher" as const,
    version: "1" as const,
    chainId: 5000,
} as const;

/**
 * EIP-712 TypeHash для ForwardRequest.
 * keccak256("ForwardRequest(address target,bytes data,uint256 value,uint256 nonce,uint256 deadline)")
 */
export const FORWARD_REQUEST_TYPES = {
    ForwardRequest: [
        { name: "target", type: "address" },
        { name: "data", type: "bytes" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
    ],
} as const;

/**
 * Signed ForwardRequest — payload, публикуемый в Redis Stream
 * для подхвата Byreal Swarm Workers.
 */
export interface SignedForwardRequest {
    /** Сам ForwardRequest */
    readonly request: ForwardRequest;
    /** EIP-712 подпись (hex, 65 bytes) */
    readonly signature: `0x${string}`;
    /** Публичный адрес TEE-signer */
    readonly signerAddress: `0x${string}`;
    /** Unix timestamp генерации */
    readonly generatedAt: number;
    /** InsightHash (для корреляции с Proof-of-Alpha) */
    readonly insightHash: string;
    /** Commit TX hash (proof что insight закоммичен before relay) */
    readonly commitTxHash: string;
}

/**
 * Конфигурация TEE-агента (из переменных окружения).
 */
export interface AgentConfig {
    /** Redis URL для Pub/Sub и состояния */
    readonly redisUrl: string;

    /** ID цепи (5000 = Mantle mainnet) */
    readonly chainId: number;

    /** TTL proposal в секундах (default: 300 = 5 мин) */
    readonly proposalTtlSeconds: number;

    /** HTTP порт для healthcheck / attestation endpoint */
    readonly healthPort: number;

    /** Включён ли режим Remote Attestation (false в dev) */
    readonly attestationEnabled: boolean;

    /** Адрес контракта AlphaAuditor (Proof-of-Alpha Registry) */
    readonly alphaAuditorAddress: string;

    /** Адрес контракта MicroFundingDispatcher (Swarm Mode relay) */
    readonly dispatcherAddress: string;

    /** Адрес контракта ActiveSentinel (target для ForwardRequest) */
    readonly activeSentinelAddress: string;

    /** Agent ID (tokenId в SentinelIdentity) */
    readonly agentId: bigint;
}

/**
 * Конфигурация Rate Limiter.
 */
export interface RateLimitConfig {
    readonly maxOpsPerMinute: number;
    readonly maxOpsPerHour: number;
    readonly revertCooldownSec: number;
}

/**
 * Результат Proof-of-Alpha commit on-chain.
 */
export interface ProofOfAlphaCommitResult {
    /** Transaction hash on-chain */
    readonly txHash: `0x${string}`;

    /** insight hash, закоммиченный в AlphaAuditor */
    readonly insightHash: string;

    /** Agent ID использованный при коммите */
    readonly agentId: bigint;

    /** Успешность отправки */
    readonly success: boolean;
}
