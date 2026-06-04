// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — agent-tee/src/services/circuitBreaker.ts
// TEE Circuit Breaker — Off-chain safety module
//
// НАЗНАЧЕНИЕ:
//   Программный предохранитель, предотвращающий публикацию убыточных/опасных
//   proposals в Redis Stream (agent_insights). Работает ПЕРЕД ProposalPublisher.
//
// ПОРОГОВЫЕ ЗНАЧЕНИЯ (hardcoded — изменение требует пересборки TEE image):
//   - MAX_SLIPPAGE: 3.0% — защита от недостаточной ликвидности
//   - MAX_GAS_MULTIPLIER: 1.5x — защита от gas spike (отрицательная доходность)
//   - MAX_ORACLE_DEVIATION: 2.0% — защита от oracle manipulation (flash loan attacks)
//
// АРХИТЕКТУРА:
//   CircuitBreaker STATEFUL — отслеживает историю baseFee для расчёта медианы.
//   Вызывается из ProposalPipeline.processSignal() ПЕРЕД publish().
//   При срабатывании — бросает CRITICAL_HALT ошибку, abort pipeline.
//
// ИНВАРИАНТЫ:
//   - Если validateMarketConditions throws → proposal НИКОГДА не публикуется
//   - Пороговые значения НЕ конфигурируются через env (TEE security boundary)
//   - Все проверки идемпотентны (можно retry без side effects)
// ═══════════════════════════════════════════════════════════════════════════════

import { createPublicClient, http, formatGwei, type Chain } from "viem";
import { mantle } from "viem/chains";

// ═══════════════════════════════════════════════════════════════════════════════
//                     HARDCODED THRESHOLDS (TEE SEALED)
// ═══════════════════════════════════════════════════════════════════════════════

/** Max allowed slippage: 3.0% (300 bps) */
const MAX_SLIPPAGE = 0.03;

/** Gas multiplier vs baseline median: 1.5x */
const MAX_GAS_MULTIPLIER = 1.5;

/** Max oracle price deviation: 2.0% (200 bps) */
const MAX_ORACLE_DEVIATION = 0.02;

/** Rolling window for baseFee median (blocks) */
const GAS_HISTORY_WINDOW = 20;

/** Minimum gas history samples before enforcement */
const MIN_GAS_SAMPLES = 5;

// ═══════════════════════════════════════════════════════════════════════════════
//                             TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Параметры рыночных условий для валидации.
 * Передаются из pipeline перед публикацией proposal.
 */
export interface MarketConditions {
    /** Estimated slippage from DEX quote (decimal: 0.01 = 1%) */
    estimatedSlippage: number;

    /** Current gas price (wei) — если null, будет запрошен из RPC */
    currentGasPriceWei?: bigint;

    /** Reference (oracle/fair) price of the asset (USD) */
    oraclePrice?: number;

    /** DEX spot price of the asset (USD) */
    spotPrice?: number;
}

/**
 * Результат проверки CircuitBreaker.
 */
export interface CircuitBreakerResult {
    /** Проверка пройдена */
    passed: boolean;

    /** Детали каждой проверки */
    checks: {
        slippage: { passed: boolean; value: number; threshold: number };
        gasSpike: { passed: boolean; multiplier: number; threshold: number; baselineGwei: string };
        oracleDeviation: { passed: boolean; deviation: number; threshold: number };
    };

    /** Timestamp проверки */
    checkedAt: number;
}

/**
 * Custom error для аварийной остановки pipeline.
 * Перехватывается в llmEngine/processSignal для graceful abort.
 */
export class CriticalHaltError extends Error {
    public readonly reason: string;
    public readonly details: CircuitBreakerResult;

    constructor(reason: string, details: CircuitBreakerResult) {
        super(`CRITICAL_HALT: ${reason}`);
        this.name = "CriticalHaltError";
        this.reason = reason;
        this.details = details;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//                         CIRCUIT BREAKER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class CircuitBreaker {
    private readonly rpcUrl: string;
    private gasHistory: bigint[] = [];
    private lastGasFetch: number = 0;

    /** Кумулятивные метрики */
    private metrics = {
        totalChecks: 0,
        haltsTriggered: 0,
        slippageHalts: 0,
        gasSpikeHalts: 0,
        oracleDeviationHalts: 0,
        lastHaltReason: "",
        lastHaltAt: 0,
    };

    constructor(rpcUrl?: string) {
        this.rpcUrl = rpcUrl ?? process.env["MANTLE_RPC_URL"] ?? "https://rpc.mantle.xyz";
    }

    // ─── Main Validation Method ─────────────────────────────────────────────────

    /**
     * Валидирует рыночные условия перед публикацией proposal.
     *
     * @param conditions — текущие рыночные параметры
     * @throws CriticalHaltError если любой параметр за пределами порога
     * @returns CircuitBreakerResult с деталями всех проверок
     */
    async validateMarketConditions(conditions: MarketConditions): Promise<CircuitBreakerResult> {
        this.metrics.totalChecks++;

        // ─── CHECK 1: Slippage ──────────────────────────────────────────────
        const slippageCheck = this.checkSlippage(conditions.estimatedSlippage);

        // ─── CHECK 2: Gas Spike ─────────────────────────────────────────────
        const gasCheck = await this.checkGasSpike(conditions.currentGasPriceWei);

        // ─── CHECK 3: Oracle Deviation ──────────────────────────────────────
        const oracleCheck = this.checkOracleDeviation(
            conditions.oraclePrice,
            conditions.spotPrice
        );

        // ─── Assemble Result ────────────────────────────────────────────────
        const result: CircuitBreakerResult = {
            passed: slippageCheck.passed && gasCheck.passed && oracleCheck.passed,
            checks: {
                slippage: slippageCheck,
                gasSpike: gasCheck,
                oracleDeviation: oracleCheck,
            },
            checkedAt: Date.now(),
        };

        // ─── If ANY check failed → CRITICAL_HALT ───────────────────────────
        if (!result.passed) {
            const reasons: string[] = [];

            if (!slippageCheck.passed) {
                reasons.push(
                    `Slippage ${(slippageCheck.value * 100).toFixed(2)}% exceeds MAX ${(MAX_SLIPPAGE * 100).toFixed(1)}%`
                );
                this.metrics.slippageHalts++;
            }

            if (!gasCheck.passed) {
                reasons.push(
                    `Gas spike ${gasCheck.multiplier.toFixed(2)}x exceeds MAX ${MAX_GAS_MULTIPLIER}x (baseline: ${gasCheck.baselineGwei} gwei)`
                );
                this.metrics.gasSpikeHalts++;
            }

            if (!oracleCheck.passed) {
                reasons.push(
                    `Oracle deviation ${(oracleCheck.deviation * 100).toFixed(2)}% exceeds MAX ${(MAX_ORACLE_DEVIATION * 100).toFixed(1)}%`
                );
                this.metrics.oracleDeviationHalts++;
            }

            const haltReason = reasons.join(" | ");
            this.metrics.haltsTriggered++;
            this.metrics.lastHaltReason = haltReason;
            this.metrics.lastHaltAt = Date.now();

            console.error(
                `\n[CircuitBreaker] ⚠️  CRITICAL_HALT TRIGGERED ⚠️\n` +
                `  Reason: ${haltReason}\n` +
                `  Action: Proposal publication BLOCKED\n` +
                `  Total halts: ${this.metrics.haltsTriggered}/${this.metrics.totalChecks} checks\n`
            );

            throw new CriticalHaltError(haltReason, result);
        }

        // ─── All passed — log and return ────────────────────────────────────
        console.log(
            `[CircuitBreaker] ✓ Market conditions OK | ` +
            `slip=${(slippageCheck.value * 100).toFixed(2)}% | ` +
            `gas=${gasCheck.multiplier.toFixed(2)}x | ` +
            `oracle_dev=${(oracleCheck.deviation * 100).toFixed(2)}%`
        );

        return result;
    }

    // ─── Individual Checks ──────────────────────────────────────────────────────

    /**
     * CHECK 1: Slippage validation.
     * Защита от потери капитала при недостаточной глубине пулов Merchant Moe / Agni Finance.
     */
    private checkSlippage(estimatedSlippage: number): {
        passed: boolean;
        value: number;
        threshold: number;
    } {
        return {
            passed: estimatedSlippage <= MAX_SLIPPAGE,
            value: estimatedSlippage,
            threshold: MAX_SLIPPAGE,
        };
    }

    /**
     * CHECK 2: Gas Price Spike detection.
     * Блокировка арбитража в моменты перегрузки сети Mantle (исключение отрицательной доходности).
     *
     * Использует rolling median из последних N блоков как baseline.
     * Если текущий gas > 1.5x median → HALT.
     */
    private async checkGasSpike(currentGasPriceWei?: bigint): Promise<{
        passed: boolean;
        multiplier: number;
        threshold: number;
        baselineGwei: string;
    }> {
        let currentGas: bigint;

        if (currentGasPriceWei !== undefined) {
            currentGas = currentGasPriceWei;
        } else {
            currentGas = await this.fetchCurrentGasPrice();
        }

        // Record in history
        this.gasHistory.push(currentGas);
        if (this.gasHistory.length > GAS_HISTORY_WINDOW) {
            this.gasHistory.shift();
        }

        // If insufficient history — pass (bootstrapping period)
        if (this.gasHistory.length < MIN_GAS_SAMPLES) {
            return {
                passed: true,
                multiplier: 1.0,
                threshold: MAX_GAS_MULTIPLIER,
                baselineGwei: "N/A (bootstrapping)",
            };
        }

        // Calculate median baseFee
        const sorted = [...this.gasHistory].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const midIdx = Math.floor(sorted.length / 2);
        const medianGas = sorted.length % 2 === 0
            ? (sorted[midIdx - 1]! + sorted[midIdx]!) / 2n
            : sorted[midIdx]!;

        // Calculate multiplier
        const multiplier = medianGas > 0n
            ? Number(currentGas * 1000n / medianGas) / 1000
            : 1.0;

        const baselineGwei = formatGwei(medianGas);

        return {
            passed: multiplier <= MAX_GAS_MULTIPLIER,
            multiplier,
            threshold: MAX_GAS_MULTIPLIER,
            baselineGwei,
        };
    }

    /**
     * CHECK 3: Oracle Price Deviation.
     * Защита от манипуляций с оракулами (Flash Loan Attacks на целевые пулы).
     *
     * Сравнивает reference price (oracle/API) vs DEX spot price.
     * Если разница > 2% → HALT (возможная манипуляция).
     */
    private checkOracleDeviation(
        oraclePrice?: number,
        spotPrice?: number
    ): { passed: boolean; deviation: number; threshold: number } {
        // If prices not provided — skip (pass by default)
        if (oraclePrice === undefined || spotPrice === undefined || oraclePrice === 0) {
            return {
                passed: true,
                deviation: 0,
                threshold: MAX_ORACLE_DEVIATION,
            };
        }

        const deviation = Math.abs(spotPrice - oraclePrice) / oraclePrice;

        return {
            passed: deviation <= MAX_ORACLE_DEVIATION,
            deviation,
            threshold: MAX_ORACLE_DEVIATION,
        };
    }

    // ─── RPC Helper ─────────────────────────────────────────────────────────────

    /**
     * Запрашивает текущий baseFeePerGas из latest block.
     * Кэширует на 2 секунды для batch проверок.
     */
    private async fetchCurrentGasPrice(): Promise<bigint> {
        const now = Date.now();
        const CACHE_MS = 2000;

        // Return cached if fresh enough
        if (
            this.lastGasFetch > 0 &&
            now - this.lastGasFetch < CACHE_MS &&
            this.gasHistory.length > 0
        ) {
            return this.gasHistory[this.gasHistory.length - 1]!;
        }

        try {
            const client = createPublicClient({
                chain: mantle as Chain,
                transport: http(this.rpcUrl),
            });

            const block = await client.getBlock({ blockTag: "latest" });
            const baseFee = block.baseFeePerGas ?? 0n;

            this.lastGasFetch = now;
            return baseFee;
        } catch (err) {
            console.warn(
                `[CircuitBreaker] Failed to fetch gas price: ${err instanceof Error ? err.message : err}. ` +
                `Using last known value.`
            );

            // Fallback to last known value or 0 (which will pass)
            return this.gasHistory.length > 0
                ? this.gasHistory[this.gasHistory.length - 1]!
                : 0n;
        }
    }

    // ─── Metrics & Monitoring ───────────────────────────────────────────────────

    /**
     * Возвращает метрики CircuitBreaker для healthcheck / dashboard.
     */
    getMetrics() {
        return {
            ...this.metrics,
            gasHistoryLength: this.gasHistory.length,
            thresholds: {
                maxSlippage: MAX_SLIPPAGE,
                maxGasMultiplier: MAX_GAS_MULTIPLIER,
                maxOracleDeviation: MAX_ORACLE_DEVIATION,
            },
        };
    }

    /**
     * Возвращает true если CircuitBreaker в состоянии HALT
     * (последний halt был < 60 секунд назад).
     */
    isInCooldown(): boolean {
        const COOLDOWN_MS = 60_000; // 1 minute cooldown after halt
        return this.metrics.lastHaltAt > 0 &&
            Date.now() - this.metrics.lastHaltAt < COOLDOWN_MS;
    }

    /**
     * Сброс gas history (при перезапуске epoch).
     */
    resetGasHistory(): void {
        this.gasHistory = [];
        this.lastGasFetch = 0;
    }
}
