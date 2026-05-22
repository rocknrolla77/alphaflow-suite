// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — agent-tee/src/strategies/llmEngine.ts
// Phase 5: Cognitive Engine — LLM-powered strategic analysis with RWA awareness
//
// МАРШРУТИЗАЦИЯ (Failover):
//   Primary:  TrueFoundry AI Gateway (managed, rate-limited, observability)
//   Fallback: Groq LPU (ultra-low latency, direct API)
//
// ИНВАРИАНТЫ:
//   - temperature: 0.1 (детерминизм, предотвращение галлюцинаций)
//   - Вывод: строго JSON-схема (LlmAnalysisOutput) — совместим с Proof-of-Alpha hash
//   - RWA Directive: если rwaContext присутствует → обязательная стратегическая интерпретация
//   - max_tokens: ограничен (экономия + предсказуемость)
//   - Retry: 2 попытки на primary → 2 попытки на fallback → throw
//   - Timeout: 30s primary, 15s fallback (Groq быстрее)
//   - No streaming: batch response для хэширования
// ═══════════════════════════════════════════════════════════════════════════════

import { z } from "zod";
import type { RwaContext } from "../services/txEnrichment.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Вход для LLM Engine: обогащённые данные о транзакции + контекст.
 */
export interface LlmAnalysisInput {
    /** Адрес кошелька-источника (Smart Money whale) */
    walletAddress: string;
    /** Тег кошелька (Fund, VC, Smart Trader) */
    walletTag: string;
    /** Репутационный скор [0-1] */
    reputationScore: number;
    /** Актив (token address) */
    assetAddress: string;
    /** Символ актива */
    assetSymbol: string;
    /** Действие: BUY/SELL */
    action: "BUY" | "SELL";
    /** Объём в USD */
    volumeUsd: number;
    /** Процент от портфеля кита */
    portfolioPercentage: number;
    /** RWA контекст (если транзакция взаимодействует с RWA) — может быть null */
    rwaContext: RwaContext | null;
    /** Дополнительные сигналы: другие киты в том же блоке, кластер-активность */
    clusterSignals?: {
        /** Количество связанных кошельков, совершивших аналогичное действие */
        relatedWalletsCount: number;
        /** Суммарный объём кластера в USD */
        clusterVolumeUsd: number;
    };
}

/**
 * JSON-схема вывода LLM — строго типизирована для Proof-of-Alpha хэширования.
 *
 * ИНВАРИАНТ: каждое поле участвует в keccak256 reasoningHash.
 * Изменение схемы = новая версия reasoningHash (breaking change).
 */
export interface LlmAnalysisOutput {
    /** Стратегическая интерпретация (1-3 предложения) */
    interpretation: string;
    /** Уровень уверенности [0.0 - 1.0] */
    confidence: number;
    /** Рекомендуемое действие: FOLLOW / COUNTER / HOLD */
    recommendation: "FOLLOW" | "COUNTER" | "HOLD";
    /** Причина рекомендации (concise) */
    rationale: string;
    /** Временной горизонт: SHORT (< 1h) / MEDIUM (1-24h) / LONG (> 24h) */
    timeHorizon: "SHORT" | "MEDIUM" | "LONG";
    /** Оценка риска [1-10], 1=minimal, 10=extreme */
    riskScore: number;
    /** RWA-стратегия (заполняется ТОЛЬКО если rwaContext != null) */
    rwaStrategy: RwaStrategyOutput | null;
    /** Версия схемы (для backward compat) */
    schemaVersion: "1.0.0";
}

/**
 * Стратегическая интерпретация RWA-операции.
 */
export interface RwaStrategyOutput {
    /** Тип стратегии, определённый по директиве */
    strategyType: "risk-off" | "risk-on" | "yield-rotation" | "neutral";
    /** Описание стратегии */
    description: string;
    /** Протокол RWA */
    protocol: string;
    /** Implied APY target */
    impliedApyBps: number;
}

// ─── Zod Validation Schema ────────────────────────────────────────────────────

const LlmOutputSchema = z.object({
    interpretation: z.string().min(10).max(500),
    confidence: z.number().min(0).max(1),
    recommendation: z.enum(["FOLLOW", "COUNTER", "HOLD"]),
    rationale: z.string().min(5).max(300),
    timeHorizon: z.enum(["SHORT", "MEDIUM", "LONG"]),
    riskScore: z.number().int().min(1).max(10),
    rwaStrategy: z.object({
        strategyType: z.enum(["risk-off", "risk-on", "yield-rotation", "neutral"]),
        description: z.string().min(5).max(300),
        protocol: z.string(),
        impliedApyBps: z.number().int().min(0).max(50000),
    }).nullable(),
    schemaVersion: z.literal("1.0.0"),
});

// ─── Configuration ────────────────────────────────────────────────────────────

export interface LlmEngineConfig {
    /** TrueFoundry AI Gateway endpoint */
    primaryUrl: string;
    /** TrueFoundry API key */
    primaryApiKey: string;
    /** Model ID on TrueFoundry (e.g., "claude-3-haiku" or "gpt-4o-mini") */
    primaryModel: string;
    /** Groq LPU endpoint (fallback) */
    fallbackUrl: string;
    /** Groq API key */
    fallbackApiKey: string;
    /** Model on Groq (e.g., "llama-3.1-70b-versatile") */
    fallbackModel: string;
    /** Temperature — LOCKED at 0.1 */
    temperature: 0.1;
    /** Max tokens for response */
    maxTokens: number;
    /** Timeout for primary (ms) */
    primaryTimeoutMs: number;
    /** Timeout for fallback (ms) */
    fallbackTimeoutMs: number;
    /** Max retries per provider */
    maxRetriesPerProvider: number;
}

const DEFAULT_CONFIG: LlmEngineConfig = {
    primaryUrl: process.env["TRUEFOUNDRY_GATEWAY_URL"] ?? "https://gateway.truefoundry.com/v1",
    primaryApiKey: process.env["TRUEFOUNDRY_API_KEY"] ?? "",
    primaryModel: process.env["TRUEFOUNDRY_MODEL"] ?? "claude-3-haiku-20240307",
    fallbackUrl: process.env["GROQ_API_URL"] ?? "https://api.groq.com/openai/v1",
    fallbackApiKey: process.env["GROQ_API_KEY"] ?? "",
    fallbackModel: process.env["GROQ_MODEL"] ?? "llama-3.1-70b-versatile",
    temperature: 0.1,
    maxTokens: 800,
    primaryTimeoutMs: 30_000,
    fallbackTimeoutMs: 15_000,
    maxRetriesPerProvider: 2,
};

// ═══════════════════════════════════════════════════════════════════════════════
//                          SYSTEM PROMPT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * System prompt для LLM — содержит жёсткие директивы по формату и RWA-интерпретации.
 *
 * ВАЖНО: Prompt frozen — изменения = новая версия reasoningHash schema.
 */
const SYSTEM_PROMPT = `You are a quantitative DeFi analyst inside a Trusted Execution Environment (TEE) on Mantle Network.
Your role: analyze Smart Money whale transactions and produce actionable strategic intelligence.

═══ STRICT OUTPUT FORMAT ═══
You MUST respond with a single JSON object matching this exact schema. No markdown, no explanations outside JSON.

{
  "interpretation": "<1-3 sentences: what the whale is doing and why>",
  "confidence": <0.0-1.0>,
  "recommendation": "FOLLOW" | "COUNTER" | "HOLD",
  "rationale": "<concise reason for recommendation>",
  "timeHorizon": "SHORT" | "MEDIUM" | "LONG",
  "riskScore": <1-10>,
  "rwaStrategy": <null OR { "strategyType": "...", "description": "...", "protocol": "...", "impliedApyBps": N }>,
  "schemaVersion": "1.0.0"
}

═══ RWA DIRECTIVE (MANDATORY when rwaContext is present) ═══
When the input contains a non-null "rwaContext" block, you MUST:
1. Always populate the "rwaStrategy" field (never null when rwaContext exists).
2. Apply these classification rules:

   • DEX/high-risk pools → USDY or mETH = STRATEGY TYPE: "risk-off"
     Description must include: "hedging strategy — capital rotation from volatile positions into yield-bearing RWA"

   • DEX/high-risk pools → cmETH = STRATEGY TYPE: "yield-rotation"
     Description must include: "yield rotation — moving from trading positions to restaking for compounded yield"

   • USDY or mETH → DEX/high-risk pools = STRATEGY TYPE: "risk-on"
     Description must include: "risk-on strategy — deploying stable/yield-bearing capital into volatile positions for alpha generation"

   • cmETH → mETH = STRATEGY TYPE: "risk-off"
     Description must include: "de-risking from restaking exposure back to base liquid staking"

   • mETH → cmETH = STRATEGY TYPE: "yield-rotation"
     Description must include: "yield amplification — upgrading from base staking to restaking for additional rewards"

   • RWA → RWA (same tier) = STRATEGY TYPE: "neutral"
     Description: "lateral rebalancing within same risk tier"

3. Set impliedApyBps from the RWA asset's estimated APY in rwaContext.
4. The rwaStrategy.protocol MUST match rwaContext.protocol.

═══ ANALYSIS GUIDELINES ═══
- Confidence: base on reputation score, volume, cluster confirmation.
- riskScore: 1-3 (low risk, clear signal), 4-6 (moderate, some uncertainty), 7-10 (high risk, conflicting signals).
- timeHorizon: SHORT if volume spike / arbitrage pattern, MEDIUM if accumulation, LONG if fundamental position change (RWA).
- recommendation FOLLOW: high confidence + aligned with trend. COUNTER: whale likely front-running (fading). HOLD: insufficient signal.
- Never hallucinate protocols or addresses not in the input.
- If rwaContext is null, set rwaStrategy to null.`;

// ═══════════════════════════════════════════════════════════════════════════════
//                          LlmEngine CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class LlmEngine {
    private readonly config: LlmEngineConfig;
    private metrics = {
        primaryCalls: 0,
        primaryFailures: 0,
        fallbackCalls: 0,
        fallbackFailures: 0,
        totalLatencyMs: 0,
        validationFailures: 0,
    };

    constructor(config?: Partial<LlmEngineConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config, temperature: 0.1 }; // temperature LOCKED
    }

    // ─── Main Analysis Method ─────────────────────────────────────────────────

    /**
     * Анализирует обогащённые данные транзакции через LLM.
     *
     * Failover chain:
     *   TrueFoundry (retry×2) → Groq LPU (retry×2) → throw
     *
     * @param input — обогащённые данные (после txEnrichment)
     * @returns Валидированный JSON-output, готовый для reasoningHash
     * @throws Error если оба провайдера недоступны или output невалиден
     */
    async analyze(input: LlmAnalysisInput): Promise<LlmAnalysisOutput> {
        const startTime = Date.now();
        const userPrompt = this.buildUserPrompt(input);

        let lastError: Error | null = null;

        // ─── Try Primary: TrueFoundry AI Gateway ──────────────────────────
        if (this.config.primaryApiKey) {
            for (let attempt = 0; attempt < this.config.maxRetriesPerProvider; attempt++) {
                try {
                    this.metrics.primaryCalls++;
                    const result = await this.callLlmApi(
                        this.config.primaryUrl,
                        this.config.primaryApiKey,
                        this.config.primaryModel,
                        userPrompt,
                        this.config.primaryTimeoutMs
                    );

                    const validated = this.validateAndParse(result);
                    this.metrics.totalLatencyMs += (Date.now() - startTime);

                    console.log(
                        `[LlmEngine] ✓ Primary (TrueFoundry) | ` +
                        `attempt=${attempt + 1} | ` +
                        `latency=${Date.now() - startTime}ms | ` +
                        `confidence=${validated.confidence} | ` +
                        `rec=${validated.recommendation}`
                    );

                    return validated;
                } catch (err) {
                    lastError = err instanceof Error ? err : new Error(String(err));
                    this.metrics.primaryFailures++;
                    console.warn(
                        `[LlmEngine] Primary attempt ${attempt + 1} failed:`,
                        lastError.message
                    );

                    // Exponential backoff between retries
                    if (attempt < this.config.maxRetriesPerProvider - 1) {
                        await this.sleep(Math.pow(2, attempt) * 500);
                    }
                }
            }
        }

        // ─── Try Fallback: Groq LPU ──────────────────────────────────────
        if (this.config.fallbackApiKey) {
            console.log("[LlmEngine] Falling back to Groq LPU...");

            for (let attempt = 0; attempt < this.config.maxRetriesPerProvider; attempt++) {
                try {
                    this.metrics.fallbackCalls++;
                    const result = await this.callLlmApi(
                        this.config.fallbackUrl,
                        this.config.fallbackApiKey,
                        this.config.fallbackModel,
                        userPrompt,
                        this.config.fallbackTimeoutMs
                    );

                    const validated = this.validateAndParse(result);
                    this.metrics.totalLatencyMs += (Date.now() - startTime);

                    console.log(
                        `[LlmEngine] ✓ Fallback (Groq) | ` +
                        `attempt=${attempt + 1} | ` +
                        `latency=${Date.now() - startTime}ms | ` +
                        `confidence=${validated.confidence} | ` +
                        `rec=${validated.recommendation}`
                    );

                    return validated;
                } catch (err) {
                    lastError = err instanceof Error ? err : new Error(String(err));
                    this.metrics.fallbackFailures++;
                    console.warn(
                        `[LlmEngine] Fallback attempt ${attempt + 1} failed:`,
                        lastError.message
                    );

                    if (attempt < this.config.maxRetriesPerProvider - 1) {
                        await this.sleep(Math.pow(2, attempt) * 300);
                    }
                }
            }
        }

        // ─── Both providers exhausted ─────────────────────────────────────
        throw new Error(
            `[LlmEngine] All providers exhausted. Last error: ${lastError?.message ?? "unknown"}\n` +
            `  Primary: ${this.metrics.primaryCalls} calls, ${this.metrics.primaryFailures} failures\n` +
            `  Fallback: ${this.metrics.fallbackCalls} calls, ${this.metrics.fallbackFailures} failures`
        );
    }

    // ─── Metrics ──────────────────────────────────────────────────────────────

    /**
     * Возвращает метрики LLM Engine для мониторинга.
     */
    getMetrics(): typeof this.metrics {
        return { ...this.metrics };
    }

    /**
     * Сбрасывает метрики (для начала нового epoch).
     */
    resetMetrics(): void {
        this.metrics = {
            primaryCalls: 0,
            primaryFailures: 0,
            fallbackCalls: 0,
            fallbackFailures: 0,
            totalLatencyMs: 0,
            validationFailures: 0,
        };
    }

    // ─── Private: API Call ─────────────────────────────────────────────────────

    /**
     * Вызывает OpenAI-compatible API (TrueFoundry и Groq оба поддерживают).
     */
    private async callLlmApi(
        baseUrl: string,
        apiKey: string,
        model: string,
        userPrompt: string,
        timeoutMs: number
    ): Promise<string> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(`${baseUrl}/chat/completions`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: "system", content: SYSTEM_PROMPT },
                        { role: "user", content: userPrompt },
                    ],
                    temperature: this.config.temperature,
                    max_tokens: this.config.maxTokens,
                    // Enforce JSON mode where supported
                    response_format: { type: "json_object" },
                }),
                signal: controller.signal,
            });

            if (!response.ok) {
                const errorBody = await response.text().catch(() => "");
                throw new Error(
                    `API error ${response.status}: ${response.statusText}. Body: ${errorBody.slice(0, 200)}`
                );
            }

            const data = await response.json() as {
                choices: Array<{ message: { content: string } }>;
            };

            const content = data.choices?.[0]?.message?.content;
            if (!content) {
                throw new Error("Empty response from LLM API");
            }

            return content;
        } finally {
            clearTimeout(timeout);
        }
    }

    // ─── Private: Prompt Construction ─────────────────────────────────────────

    /**
     * Строит user prompt из структурированного input.
     * Формат: JSON blob — LLM парсит и отвечает JSON-ом.
     */
    private buildUserPrompt(input: LlmAnalysisInput): string {
        const prompt: Record<string, any> = {
            transaction: {
                walletAddress: input.walletAddress,
                walletTag: input.walletTag,
                reputationScore: input.reputationScore,
                asset: {
                    address: input.assetAddress,
                    symbol: input.assetSymbol,
                },
                action: input.action,
                volumeUsd: input.volumeUsd,
                portfolioPercentage: input.portfolioPercentage,
            },
        };

        // Добавляем RWA контекст если присутствует
        if (input.rwaContext) {
            prompt["rwaContext"] = {
                isRwa: true,
                protocol: input.rwaContext.protocol,
                symbol: input.rwaContext.symbol,
                actionType: input.rwaContext.actionType,
                assetType: input.rwaContext.assetType,
                riskClassification: input.rwaContext.riskClassification,
                estimatedApyBps: input.rwaContext.estimatedApyBps,
                underlying: input.rwaContext.underlying,
            };
        } else {
            prompt["rwaContext"] = null;
        }

        // Добавляем cluster signals если есть
        if (input.clusterSignals) {
            prompt["clusterSignals"] = input.clusterSignals;
        }

        return JSON.stringify(prompt, null, 2);
    }

    // ─── Private: Validation & Parsing ────────────────────────────────────────

    /**
     * Парсит и валидирует JSON-ответ LLM через Zod.
     *
     * Дополнительная проверка:
     * - Если input содержал rwaContext → rwaStrategy MUST NOT be null
     * - schemaVersion must be "1.0.0"
     *
     * @throws Error если ответ невалиден
     */
    private validateAndParse(rawContent: string): LlmAnalysisOutput {
        // Strip markdown code fences if LLM wraps in ```json ... ```
        let cleaned = rawContent.trim();
        if (cleaned.startsWith("```")) {
            cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(cleaned);
        } catch (parseErr) {
            this.metrics.validationFailures++;
            throw new Error(
                `[LlmEngine] JSON parse failed: ${(parseErr as Error).message}\n` +
                `  Raw content (first 200 chars): ${rawContent.slice(0, 200)}`
            );
        }

        // Zod validation
        const result = LlmOutputSchema.safeParse(parsed);
        if (!result.success) {
            this.metrics.validationFailures++;
            const issues = result.error.issues.map(
                (i) => `  ${i.path.join(".")}: ${i.message}`
            ).join("\n");
            throw new Error(
                `[LlmEngine] Schema validation failed:\n${issues}`
            );
        }

        return result.data as LlmAnalysisOutput;
    }

    // ─── Private: Utils ───────────────────────────────────────────────────────

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//                          EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export { SYSTEM_PROMPT };
