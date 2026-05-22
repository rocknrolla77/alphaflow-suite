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
 * EIP-712 Domain для AlphaFlow TEE.
 * Используется при подписании Proposals.
 */
export interface EIP712Domain {
    readonly name: string;
    readonly version: string;
    readonly chainId: number;
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
