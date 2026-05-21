// Файл: frontend/src/utils/bffClient.ts
// BFF API Client — все запросы к backend (HMAC не хранится на клиенте!)

const BFF_URL = import.meta.env.VITE_BFF_URL || "http://localhost:3001";

export interface ProposalData {
    proposalId: string;
    asset: string;
    assetSymbol: string;
    action: "BUY" | "SELL";
    amount: number;
    weight: number;
    confidence: number;
    maxSlippage: number;
    deadline: number;
    teeSignerAddress: string;
    proofOfReasoning: string;
    reasoningHash: string;
    targetContract: string;
    executionPayload: `0x${string}`;
    stalenessWarning: string | null;
    currentPrice: number;
    priceAtGeneration: number;
    remainingSec: number;
}

export interface SimulationResult {
    success: boolean;
    willRevert: boolean;
    reason?: string;
}

/**
 * BFF Client.
 *
 * ВАЖНО: HMAC передаётся из Telegram startapp parameter (base64url encoded).
 * Клиент НЕ хранит HMAC secret — он приходит как одноразовый токен.
 */
export class BFFClient {
    private baseUrl: string;
    private hmacSignature: string;

    constructor(hmacSignature: string) {
        this.baseUrl = BFF_URL;
        this.hmacSignature = hmacSignature;
    }

    /**
     * Получить детали proposal (BFF верифицирует HMAC + staleness).
     */
    async getProposal(proposalId: string): Promise<ProposalData> {
        const res = await fetch(`${this.baseUrl}/api/proposal/${proposalId}`, {
            headers: {
                "X-HMAC-Signature": this.hmacSignature,
                "X-Proposal-ID": proposalId,
            },
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || `BFF error: ${res.status}`);
        }

        return res.json();
    }

    /**
     * Off-chain симуляция (BFF вызывает eth_call).
     */
    async simulate(proposalId: string): Promise<SimulationResult> {
        const res = await fetch(`${this.baseUrl}/api/proposal/${proposalId}/simulate`, {
            method: "POST",
            headers: {
                "X-HMAC-Signature": this.hmacSignature,
                "X-Proposal-ID": proposalId,
            },
        });

        if (!res.ok) {
            return { success: false, willRevert: true, reason: "Simulation request failed" };
        }

        return res.json();
    }

    /**
     * Сжигание nullifier после успешной отправки UserOp.
     */
    async consume(proposalId: string): Promise<void> {
        await fetch(`${this.baseUrl}/api/proposal/${proposalId}/consume`, {
            method: "POST",
            headers: {
                "X-HMAC-Signature": this.hmacSignature,
                "X-Proposal-ID": proposalId,
            },
        });
    }
}

/**
 * Парсит startapp parameter из Telegram.
 * Format: base64url({ pid: "uuid", sig: "hmac_hex" })
 */
export function parseStartAppParam(startapp: string | null): {
    proposalId: string;
    hmacSignature: string;
} | null {
    if (!startapp) return null;

    try {
        // base64url decode
        const json = atob(startapp.replace(/-/g, "+").replace(/_/g, "/"));
        const parsed = JSON.parse(json);

        if (!parsed.pid || !parsed.sig) return null;

        // Sanitize: only allow hex and UUID characters
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const hexRegex = /^[0-9a-f]{64}$/i;

        if (!uuidRegex.test(parsed.pid) || !hexRegex.test(parsed.sig)) {
            return null; // XSS / injection attempt
        }

        return { proposalId: parsed.pid, hmacSignature: parsed.sig };
    } catch {
        return null;
    }
}
