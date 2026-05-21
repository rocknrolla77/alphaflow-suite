// Файл: agent-tee/src/services/rateLimiter.ts
// Rate Limiter для UserOperations — защита Gas Vault от drain через revert-спам

import type { RateLimitConfig } from "../types";

interface OpRecord {
    timestamp: number;
    reverted: boolean;
}

/**
 * PaymasterRateLimiter — ограничивает частоту отправки UserOperations.
 *
 * Защищает от сценария:
 * 1. TEE-агент ломается и генерирует сотни невалидных UserOps
 * 2. Каждый UserOp откатывается, но gas уже списан с Kernel
 * 3. Gas Vault (10 MNT) истощается за минуты
 *
 * Политики:
 * - maxOpsPerMinute: жёсткий лимит (default: 5)
 * - maxOpsPerHour: мягкий лимит для burst protection (default: 30)
 * - revertCooldown: после revert — пауза перед следующей попыткой
 * - consecutiveRevertLimit: N revert подряд → полная блокировка
 */
export class PaymasterRateLimiter {
    private config: RateLimitConfig;
    private opHistory: OpRecord[] = [];
    private consecutiveReverts: number = 0;
    private isBlocked: boolean = false;
    private blockedUntil: number = 0;

    // После 3 consecutive reverts — блокировка на 15 минут
    private readonly CONSECUTIVE_REVERT_LIMIT = 3;
    private readonly BLOCK_DURATION_MS = 15 * 60 * 1000; // 15 min

    constructor(config: RateLimitConfig) {
        this.config = config;
    }

    /**
     * Проверяет можно ли отправить следующий UserOp.
     * Вызывается ПЕРЕД отправкой.
     *
     * @returns { allowed: boolean, reason?: string, retryAfterMs?: number }
     */
    canSend(): { allowed: boolean; reason?: string; retryAfterMs?: number } {
        const now = Date.now();

        // ─── Check: полная блокировка после consecutive reverts ──────
        if (this.isBlocked) {
            if (now < this.blockedUntil) {
                return {
                    allowed: false,
                    reason: `Blocked after ${this.CONSECUTIVE_REVERT_LIMIT} consecutive reverts`,
                    retryAfterMs: this.blockedUntil - now,
                };
            }
            // Блокировка истекла
            this.isBlocked = false;
            this.consecutiveReverts = 0;
        }

        // ─── Check: revert cooldown ─────────────────────────────────
        const lastOp = this.opHistory[this.opHistory.length - 1];
        if (lastOp?.reverted) {
            const cooldownEnd = lastOp.timestamp + this.config.revertCooldownSec * 1000;
            if (now < cooldownEnd) {
                return {
                    allowed: false,
                    reason: `Revert cooldown active (${this.config.revertCooldownSec}s)`,
                    retryAfterMs: cooldownEnd - now,
                };
            }
        }

        // ─── Check: per-minute rate ─────────────────────────────────
        const oneMinuteAgo = now - 60_000;
        const opsLastMinute = this.opHistory.filter((op) => op.timestamp > oneMinuteAgo).length;
        if (opsLastMinute >= this.config.maxOpsPerMinute) {
            const oldestInWindow = this.opHistory.find((op) => op.timestamp > oneMinuteAgo);
            const retryAfter = oldestInWindow
                ? oldestInWindow.timestamp + 60_000 - now
                : 60_000;
            return {
                allowed: false,
                reason: `Rate limit: ${this.config.maxOpsPerMinute} ops/min exceeded`,
                retryAfterMs: retryAfter,
            };
        }

        // ─── Check: per-hour rate ───────────────────────────────────
        const oneHourAgo = now - 3_600_000;
        const opsLastHour = this.opHistory.filter((op) => op.timestamp > oneHourAgo).length;
        if (opsLastHour >= this.config.maxOpsPerHour) {
            return {
                allowed: false,
                reason: `Rate limit: ${this.config.maxOpsPerHour} ops/hour exceeded`,
                retryAfterMs: 300_000, // Retry in 5 min
            };
        }

        return { allowed: true };
    }

    /**
     * Записывает результат отправки UserOp.
     * Вызывается ПОСЛЕ получения receipt.
     */
    recordOp(success: boolean): void {
        const now = Date.now();

        this.opHistory.push({ timestamp: now, reverted: !success });

        // Обновляем consecutive revert counter
        if (!success) {
            this.consecutiveReverts++;
            if (this.consecutiveReverts >= this.CONSECUTIVE_REVERT_LIMIT) {
                this.isBlocked = true;
                this.blockedUntil = now + this.BLOCK_DURATION_MS;
            }
        } else {
            // Успешная транзакция сбрасывает счётчик
            this.consecutiveReverts = 0;
        }

        // Очистка старых записей (оставляем только последний час)
        const oneHourAgo = now - 3_600_000;
        this.opHistory = this.opHistory.filter((op) => op.timestamp > oneHourAgo);
    }

    /**
     * Принудительная разблокировка (для оператора через HITL).
     */
    forceUnblock(): void {
        this.isBlocked = false;
        this.consecutiveReverts = 0;
        this.blockedUntil = 0;
    }

    /**
     * Текущее состояние для мониторинга.
     */
    getStatus(): {
        isBlocked: boolean;
        consecutiveReverts: number;
        opsLastMinute: number;
        opsLastHour: number;
        blockedUntilIso: string | null;
    } {
        const now = Date.now();
        return {
            isBlocked: this.isBlocked,
            consecutiveReverts: this.consecutiveReverts,
            opsLastMinute: this.opHistory.filter((op) => op.timestamp > now - 60_000).length,
            opsLastHour: this.opHistory.filter((op) => op.timestamp > now - 3_600_000).length,
            blockedUntilIso: this.isBlocked ? new Date(this.blockedUntil).toISOString() : null,
        };
    }
}
