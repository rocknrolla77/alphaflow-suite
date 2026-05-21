// Файл: frontend/src/hooks/useWebAuthnSupport.ts
// Детекция поддержки WebAuthn в среде TMA WebView

export interface WebAuthnCapability {
    /** WebAuthn доступен */
    isSupported: boolean;
    /** Platform authenticator (FaceID/TouchID) доступен */
    hasPlatformAuth: boolean;
    /** Причина недоступности */
    reason?: string;
    /** Рекомендуемый fallback */
    fallback: "none" | "external_browser" | "session_key_only";
}

/**
 * Проверяет реальную доступность WebAuthn в текущей среде.
 *
 * Проблема: Telegram WebView на iOS/Android может:
 * 1. Не иметь window.PublicKeyCredential
 * 2. Иметь его, но блокировать create()/get() (NotAllowedError)
 * 3. Работать, но без platform authenticator (только USB keys)
 *
 * Стратегия: проверяем прогрессивно и предлагаем fallback.
 */
export async function detectWebAuthnSupport(): Promise<WebAuthnCapability> {
    // Step 1: API exists?
    if (typeof window === "undefined" || !window.PublicKeyCredential) {
        return {
            isSupported: false,
            hasPlatformAuth: false,
            reason: "WebAuthn API not available in this WebView",
            fallback: "external_browser",
        };
    }

    // Step 2: Platform authenticator available? (FaceID/TouchID/Windows Hello)
    try {
        const hasPlatform =
            await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();

        if (!hasPlatform) {
            return {
                isSupported: true,
                hasPlatformAuth: false,
                reason: "No platform authenticator (FaceID/TouchID) — only roaming keys",
                fallback: "external_browser",
            };
        }
    } catch (err) {
        return {
            isSupported: false,
            hasPlatformAuth: false,
            reason: `Platform auth check failed: ${(err as Error).message}`,
            fallback: "external_browser",
        };
    }

    // Step 3: Conditional mediation? (optional, for UX)
    let hasConditionalMediation = false;
    try {
        if ("isConditionalMediationAvailable" in PublicKeyCredential) {
            hasConditionalMediation =
                await (PublicKeyCredential as any).isConditionalMediationAvailable();
        }
    } catch {
        // Non-critical
    }

    return {
        isSupported: true,
        hasPlatformAuth: true,
        fallback: "none",
    };
}

/**
 * Генерирует deep-link для открытия в внешнем браузере (fallback).
 * Используется когда WebView Telegram не поддерживает WebAuthn.
 */
export function buildExternalBrowserUrl(proposalId: string, hmac: string): string {
    const tmaUrl = import.meta.env.VITE_TMA_URL || window.location.origin;
    const payload = btoa(JSON.stringify({ pid: proposalId, sig: hmac }));
    return `${tmaUrl}/approve?p=${encodeURIComponent(payload)}`;
}
