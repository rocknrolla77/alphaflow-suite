// Файл: agent-tee/src/services/proposalPublisher.ts
// Публикация подписанных Proposals в Redis для Telegram HITL бот

export interface PublisherConfig {
    redisUrl: string;
    channel: string;
    /** Default deadline offset (секунды от timestamp) */
    defaultDeadlineOffsetSec: number;
}

/**
 * ProposalPublisher — отправляет SignedProposal из TEE в Redis Pub/Sub.
 *
 * TEE → Redis (tee_proposals) → Telegram Bot → User → TMA → Execute
 *
 * Добавляет:
 * - nonce: монотонно растущий счётчик внутри TEE
 * - deadline: timestamp + deadlineOffsetSec
 * - priceAtGeneration: текущая цена для staleness detection
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
     * Публикует proposal в Redis channel.
     * @param signedProposal - Подписанный proposal из YieldArchitect
     * @param currentPrice - Текущая цена актива (для staleness detection на approve)
     * @param maxSlippagePct - Допустимое отклонение цены (%)
     */
    async publish(
        signedProposal: {
            proposal: any;
            proofOfReasoning: string;
            teeSignerAddress: string;
        },
        currentPrice: number,
        maxSlippagePct: number = 2
    ): Promise<{ published: boolean; nonce: number; deadline: number }> {
        // Monotonic nonce (внутри TEE — не resettable извне)
        this.nonceCounter++;
        const nonce = this.nonceCounter;

        // Deadline = timestamp + offset
        const deadline =
            signedProposal.proposal.timestamp + this.config.defaultDeadlineOffsetSec;

        const message = {
            ...signedProposal.proposal,
            nonce,
            deadline,
            proofOfReasoning: signedProposal.proofOfReasoning,
            teeSignerAddress: signedProposal.teeSignerAddress,
            priceAtGeneration: currentPrice,
            maxSlippagePct,
        };

        await this.redis.publish(this.config.channel, JSON.stringify(message));

        return { published: true, nonce, deadline };
    }

    /**
     * Текущий nonce (для мониторинга).
     */
    getCurrentNonce(): number {
        return this.nonceCounter;
    }
}
