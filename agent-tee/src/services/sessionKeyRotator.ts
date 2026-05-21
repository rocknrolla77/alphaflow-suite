// Файл: agent-tee/src/services/sessionKeyRotator.ts
// Демон упреждающей ротации Session Key
// Решает "слепую зону": если арбитражное окно появится за 2 секунды до
// истечения validUntil, транзакция будет отклонена.

export interface RotatorConfig {
    /** За сколько секунд до истечения запрашивать ротацию (default: 3600 = 1 час) */
    preRotationBufferSec: number;
    /** Интервал проверки (ms) */
    checkIntervalMs: number;
    /** Callback для запроса нового ключа от владельца (Passkey/MetaMask) */
    onRotationNeeded: (currentValidUntil: number) => Promise<{
        sessionPrivateKey: `0x${string}`;
        validUntil: number;
    }>;
    /** Callback при ошибке ротации */
    onRotationFailed?: (error: Error) => void;
    /** Callback при успешной ротации (для logging) */
    onRotationSuccess?: (newValidUntil: number) => void;
}

/**
 * SessionKeyRotator — упреждающая ротация сессионных ключей.
 *
 * Алгоритм:
 * 1. Каждые checkIntervalMs проверяет: T_now > validUntil - preRotationBufferSec?
 * 2. Если да — вызывает onRotationNeeded (запрос подписи от владельца)
 * 3. Обновляет внутреннее состояние с новым ключом
 * 4. Старый ключ продолжает работать до validUntil (grace period)
 *
 * Fail-safe:
 * - Если ротация не удалась (владелец недоступен) — логирует ошибку
 * - Агент продолжает работать со старым ключом до истечения
 * - При T_now > validUntil - 60s: ОСТАНОВКА всех операций (dead zone protection)
 */
export class SessionKeyRotator {
    private config: RotatorConfig;
    private currentValidUntil: number;
    private currentSessionKey: `0x${string}`;
    private intervalHandle: NodeJS.Timeout | null = null;
    private isRotating: boolean = false;
    private rotationAttempts: number = 0;
    private readonly MAX_ROTATION_ATTEMPTS = 3;

    constructor(
        config: RotatorConfig,
        initialSessionKey: `0x${string}`,
        initialValidUntil: number
    ) {
        this.config = config;
        this.currentSessionKey = initialSessionKey;
        this.currentValidUntil = initialValidUntil;
    }

    /**
     * Запускает демон ротации.
     */
    start(): void {
        if (this.intervalHandle) return;

        this.intervalHandle = setInterval(
            () => this.checkAndRotate(),
            this.config.checkIntervalMs
        );
    }

    /**
     * Останавливает демон.
     */
    stop(): void {
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }
    }

    /**
     * Проверяет нужна ли ротация и выполняет её.
     */
    private async checkAndRotate(): Promise<void> {
        if (this.isRotating) return;

        const now = Math.floor(Date.now() / 1000);
        const timeUntilExpiry = this.currentValidUntil - now;

        // ─── Dead Zone: < 60s until expiry → STOP operations ─────────
        if (timeUntilExpiry <= 60) {
            // Последняя попытка ротации
            if (this.rotationAttempts < this.MAX_ROTATION_ATTEMPTS) {
                await this.performRotation();
            }
            return;
        }

        // ─── Pre-rotation: < buffer until expiry → initiate rotation ─
        if (timeUntilExpiry <= this.config.preRotationBufferSec) {
            await this.performRotation();
        }
    }

    private async performRotation(): Promise<void> {
        this.isRotating = true;
        this.rotationAttempts++;

        try {
            const result = await this.config.onRotationNeeded(this.currentValidUntil);

            this.currentSessionKey = result.sessionPrivateKey;
            this.currentValidUntil = result.validUntil;
            this.rotationAttempts = 0;

            this.config.onRotationSuccess?.(result.validUntil);
        } catch (err: any) {
            this.config.onRotationFailed?.(err);
        } finally {
            this.isRotating = false;
        }
    }

    /**
     * Проверяет можно ли сейчас отправлять транзакции.
     * Используется executor'ом перед каждым UserOp.
     */
    canOperate(): { allowed: boolean; reason?: string; remainingSec: number } {
        const now = Math.floor(Date.now() / 1000);
        const remaining = this.currentValidUntil - now;

        if (remaining <= 0) {
            return { allowed: false, reason: "Session key expired", remainingSec: 0 };
        }

        // Dead zone: не отправляем если < 60s (может не успеть подтвердиться)
        if (remaining <= 60) {
            return {
                allowed: false,
                reason: `Dead zone: only ${remaining}s until expiry`,
                remainingSec: remaining,
            };
        }

        return { allowed: true, remainingSec: remaining };
    }

    /**
     * Текущий активный ключ.
     */
    getCurrentKey(): `0x${string}` {
        return this.currentSessionKey;
    }

    /**
     * Текущее состояние для мониторинга.
     */
    getStatus(): {
        validUntilIso: string;
        remainingSec: number;
        isInPreRotation: boolean;
        isInDeadZone: boolean;
        rotationAttempts: number;
    } {
        const now = Math.floor(Date.now() / 1000);
        const remaining = this.currentValidUntil - now;

        return {
            validUntilIso: new Date(this.currentValidUntil * 1000).toISOString(),
            remainingSec: Math.max(remaining, 0),
            isInPreRotation: remaining <= this.config.preRotationBufferSec && remaining > 60,
            isInDeadZone: remaining <= 60,
            rotationAttempts: this.rotationAttempts,
        };
    }
}
