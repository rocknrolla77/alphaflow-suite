// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/utils/bffClient.ts
// BFF API Client — HMAC-authenticated requests to Backend-for-Frontend
//
// ИНВАРИАНТ БЕЗОПАСНОСТИ:
// - Фронтенд НЕ содержит секретов (HMAC_SECRET недоступен)
// - Подпись (hmacSignature) приходит из Telegram deep link (генерирует бот)
// - Клиент только ПЕРЕДАЁТ подпись, но НЕ МОЖЕТ генерировать новые
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Configuration ────────────────────────────────────────────────────────────

const BFF_BASE_URL = import.meta.env.VITE_BFF_URL ?? "https://bff.alphaflow.suite";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProposalData {
  id: string;
  asset: string;
  assetSymbol: string;
  action: "BUY" | "SELL";
  recommendedAmount: string; // BigInt as string
  nonce: number;
  deadline: number;
  reasoningHash: string;
  signature: string;
  signerAddress: string;
  generatedAt: number;
}

export interface EIP712Payload {
  domain: {
    name: string;
    version: string;
    chainId: number;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface ProposalResponse {
  proposal: ProposalData;
  eip712Payload: EIP712Payload;
  lockExpiresAt: number;
}

export interface ConsumeResponse {
  consumed: boolean;
  proposalId: string;
  reasoningHash: string;
  consumedAt: number;
}

export interface SimulateResponse {
  success: boolean;
  result?: string;
  error?: string;
  simulatedAt?: number;
}

export type BffErrorCode =
  | "HMAC_MISSING"
  | "HMAC_INVALID"
  | "PROPOSAL_UNAVAILABLE"
  | "PRICE_STALE"
  | "CONSUME_FAILED"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "INTERNAL_ERROR"
  | "NETWORK_ERROR";

export interface BffError {
  error: string;
  code: BffErrorCode;
  details?: Record<string, unknown>;
}

export class BffApiError extends Error {
  constructor(
    message: string,
    public readonly code: BffErrorCode,
    public readonly httpStatus: number,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "BffApiError";
  }
}

// ─── HTTP Client ──────────────────────────────────────────────────────────────

/**
 * Общий fetch-wrapper с обработкой ошибок и таймаутом.
 */
async function request<T>(
  path: string,
  options: {
    method: "GET" | "POST";
    hmacSignature: string;
    body?: unknown;
    timeoutMs?: number;
  }
): Promise<T> {
  const { method, hmacSignature, body, timeoutMs = 15000 } = options;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      "x-hmac-signature": hmacSignature,
      "Content-Type": "application/json",
    };

    const response = await fetch(`${BFF_BASE_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const data: unknown = await response.json();

    if (!response.ok) {
      const err = data as BffError;
      throw new BffApiError(
        err.error ?? `HTTP ${response.status}`,
        err.code ?? "INTERNAL_ERROR",
        response.status,
        err.details
      );
    }

    return data as T;
  } catch (err) {
    if (err instanceof BffApiError) throw err;

    if (err instanceof DOMException && err.name === "AbortError") {
      throw new BffApiError(
        "Request timed out",
        "NETWORK_ERROR",
        0
      );
    }

    throw new BffApiError(
      err instanceof Error ? err.message : "Network error",
      "NETWORK_ERROR",
      0
    );
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Получает Proposal от BFF.
 *
 * BFF выполняет:
 * 1. HMAC verification (timing-safe)
 * 2. Redis fetch + optimistic lock (60s TTL)
 * 3. On-chain staleness check
 * 4. Возвращает EIP-712 payload для подписи
 *
 * @param proposalId — ID proposal из deep link
 * @param hmacSignature — hex подпись из deep link (генерирует бот)
 * @returns ProposalResponse с данными для UI + signing
 * @throws BffApiError с конкретным code
 */
export async function fetchProposal(
  proposalId: string,
  hmacSignature: string
): Promise<ProposalResponse> {
  return request<ProposalResponse>(
    `/api/proposal/${encodeURIComponent(proposalId)}`,
    { method: "GET", hmacSignature }
  );
}

/**
 * Сжигает Proposal (nullifier) после успешной отправки транзакции.
 *
 * ВЫЗЫВАТЬ СРАЗУ после получения userOpHash от bundler.
 * Idempotent: повторный вызов безопасен (возвращает 200).
 *
 * @param proposalId — ID proposal
 * @param hmacSignature — та же подпись что и для fetch
 * @returns ConsumeResponse
 */
export async function consumeProposal(
  proposalId: string,
  hmacSignature: string
): Promise<ConsumeResponse> {
  return request<ConsumeResponse>(
    `/api/proposal/${encodeURIComponent(proposalId)}/consume`,
    { method: "POST", hmacSignature }
  );
}

/**
 * Симулирует транзакцию через BFF (eth_call dry-run).
 * Используется перед реальной отправкой для проверки revert.
 *
 * @param proposalId — ID proposal (для HMAC маршрутизации)
 * @param hmacSignature — подпись
 * @param to — target contract
 * @param data — calldata hex
 * @returns SimulateResponse
 */
export async function simulateTransaction(
  proposalId: string,
  hmacSignature: string,
  to: string,
  data: string
): Promise<SimulateResponse> {
  return request<SimulateResponse>(
    `/api/proposal/${encodeURIComponent(proposalId)}/simulate`,
    { method: "POST", hmacSignature, body: { to, data } }
  );
}

/**
 * Форматирует человекочитаемую ошибку для UI.
 */
export function formatBffError(err: unknown): string {
  if (err instanceof BffApiError) {
    switch (err.code) {
      case "HMAC_INVALID":
      case "HMAC_MISSING":
        return "Authentication failed. Please reopen from Telegram.";
      case "PRICE_STALE":
        return "Price has moved significantly. Strategy outdated — please wait for a new proposal.";
      case "PROPOSAL_UNAVAILABLE":
        return err.httpStatus === 423
          ? "Another session is processing this proposal. Try again in 60s."
          : err.httpStatus === 410
          ? "Proposal expired. Wait for a new one."
          : "Proposal unavailable.";
      case "NETWORK_ERROR":
        return "Network error. Check your connection.";
      default:
        return err.message;
    }
  }
  return "An unexpected error occurred.";
}
