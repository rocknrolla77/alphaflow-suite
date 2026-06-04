// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — agent-tee/src/services/proposalPublisher.ts
// Публикация LLM Insights в Redis Stream "agent_insights" (XADD)
//
// АРХИТЕКТУРА:
//   TEE → Redis Stream (agent_insights) → BFF WSS → Frontend
//
// МИГРАЦИЯ с Pub/Sub:
//   Pub/Sub (PUBLISH) → Redis Streams (XADD) для persistence + replay.
//   Consumers (BFF) читают через XREAD BLOCK, гарантируя at-least-once delivery.
//
// PAYLOAD (LLMInsight):
//   { convictionScore, reasoning, proposedAction, ...metadata }
//   Сериализуется в JSON string и записывается как single field "payload".
// ═══════════════════════════════════════════════════════════════════════════════

export interface PublisherConfig {
    redisUrl: string;
    /** Redis Stream key (default: "agent_insights") */
    streamKey: string;
    /** Default deadline offset (секунды от timestamp) */
    defaultDeadlineOffsetSec: number;
    /** Maximum stream length (MAXLEN ~) for memory management */
    maxStreamLength?: number;
}

/**
 * LLMInsight — core payload structure for the agent_insights stream.
 * Represents a TEE-computed recommendation with conviction scoring.
 */
export interface LLMInsight {
    /** Conviction score [0.0 - 1.0] — уверенность модели в рекомендации */
    convictionScore: number;
    /** Human-readable reasoning (proof-of-reasoning text) */
    reasoning: string;
    /** Proposed action descriptor */
    proposedAction: {
        asset: string;
        assetSymbol: string;
        action: "BUY" | "SELL";
        recommendedAmount: string; // bigint serialized as string
    };
    /** Monotonic nonce within TEE (replay protection) */
    nonce: number;
    /** Unix timestamp of proposal deadline */
    deadline: number;
    /** Proof-of-reasoning hash (keccak256) */
    reasoningHash: string;
    /** TEE signer address */
    teeSignerAddress: string;
    /** Price at generation time */
    priceAtGeneration: number;
    /** Max slippage in percentage */
    maxSlippagePct: number;
    /** Unix timestamp of insight generation */
    generatedAt: number;
    /** EIP-712 signature (hex) */
    signature: string;
    /** InsightHash committed on-chain (Proof-of-Alpha) */
    insightHash: string;
    /** Commit transaction hash */
    commitTxHash: string;
}

/**
 * ProposalPublisher — записывает LLMInsight в Redis Stream (XADD).
 *
 * Используется TEE-агентом для durable публикации рекомендаций.
 * BFF потребляет stream через XREAD BLOCK и вещает клиентам по WSS.
 *
 * Преимущества перед Pub/Sub:
 * - Persistence: сообщения сохраняются, можно replay
 * - Consumer groups: multiple consumers без потерь
 * - Backpressure: MAXLEN ~ ограничивает рост памяти
 * - Acknowledgement: consumer может подтвердить обработку
 */
export class ProposalPublisher {
    private config: PublisherConfig;
    private nonceCounter: number = 0;
    private redis: any; // ioredis instance

    constructor(config: PublisherConfig, redisClient: any) {
        this.config = config;
        this.redis = redisClient;
    }

    /**
     * Публикует insight в Redis Stream "agent_insights".
     *
     * @param signedProposal - Подписанный proposal из YieldArchitect
     * @param currentPrice - Текущая цена актива (для staleness detection на approve)
     * @param maxSlippagePct - Допустимое отклонение цены (%)
     * @returns Stream entry ID + metadata
     */
    async publish(
        signedProposal: {
            proposal: any;
            proofOfReasoning: string;
            teeSignerAddress: string;
        },
        currentPrice: number,
        maxSlippagePct: number = 2
    ): Promise<{ published: boolean; nonce: number; deadline: number; streamId: string }> {
        // Monotonic nonce (внутри TEE — не resettable извне)
        this.nonceCounter++;
        const nonce = this.nonceCounter;

        // Deadline = timestamp + offset
        const deadline =
            signedProposal.proposal.timestamp + this.config.defaultDeadlineOffsetSec;

        // ─── Construct LLMInsight payload ────────────────────────────────────
        const insight: LLMInsight = {
            convictionScore: signedProposal.proposal.convictionScore ?? 0.8,
            reasoning: signedProposal.proofOfReasoning,
            proposedAction: {
                asset: signedProposal.proposal.asset,
                assetSymbol: signedProposal.proposal.assetSymbol ?? "UNKNOWN",
                action: signedProposal.proposal.action,
                recommendedAmount: String(signedProposal.proposal.recommendedAmount),
            },
            nonce,
            deadline,
            reasoningHash: signedProposal.proposal.reasoningHash,
            teeSignerAddress: signedProposal.teeSignerAddress,
            priceAtGeneration: currentPrice,
            maxSlippagePct,
            generatedAt: Math.floor(Date.now() / 1000),
            signature: signedProposal.proposal.signature ?? "",
            insightHash: signedProposal.proposal.insightHash ?? "",
            commitTxHash: signedProposal.proposal.commitTxHash ?? "",
        };

        // ─── Serialize to JSON string ────────────────────────────────────────
        const payload = JSON.stringify(insight);

        // ─── XADD to stream with approximate MAXLEN trimming ─────────────────
        // XADD agent_insights MAXLEN ~ 1000 * payload <json>
        const maxLen = this.config.maxStreamLength ?? 1000;
        const streamId: string = await this.redis.xadd(
            this.config.streamKey,
            "MAXLEN",
            "~",
            maxLen,
            "*", // Auto-generate ID (timestamp-sequence)
            "payload",
            payload
        );

        console.log(
            `[Publisher] XADD → stream=${this.config.streamKey} | id=${streamId} | ` +
            `action=${insight.proposedAction.action} | ` +
            `asset=${insight.proposedAction.assetSymbol} | ` +
            `conviction=${insight.convictionScore} | nonce=${nonce}`
        );

        return { published: true, nonce, deadline, streamId };
    }

    /**
     * Текущий nonce (для мониторинга).
     */
    getCurrentNonce(): number {
        return this.nonceCounter;
    }

    /**
     * Получить длину stream (для мониторинга / healthcheck).
     */
    async getStreamLength(): Promise<number> {
        return await this.redis.xlen(this.config.streamKey);
    }
}
