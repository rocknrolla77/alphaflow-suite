// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/hooks/useWebAuthn.ts
// WebAuthn / Passkey Detection Hook
//
// ПРОБЛЕМА:
// Telegram WebView (особенно iOS < 16.4, Android WebView < 116)
// блокирует PublicKeyCredential API. navigator.credentials.create()
// выбрасывает NotAllowedError или DOMException.
//
// РЕШЕНИЕ:
// 1. Проверяем поддержку PublicKeyCredential
// 2. Проверяем isUserVerifyingPlatformAuthenticatorAvailable()
// 3. При ошибке — показываем кнопку "Open in External Browser"
// ═══════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

export type WebAuthnStatus =
  | "checking"      // Проверяем поддержку
  | "supported"     // Всё ОК, можно использовать Passkeys
  | "unsupported"   // Устройство не поддерживает (старый браузер)
  | "blocked"       // WebView блокирует (Telegram ограничение)
  | "error";        // Другая ошибка

export interface WebAuthnState {
  /** Текущий статус проверки */
  status: WebAuthnStatus;

  /** Можно ли использовать Passkeys (status === "supported") */
  isAvailable: boolean;

  /** Нужно ли показывать fallback (status === "blocked" | "unsupported") */
  needsFallback: boolean;

  /** Человекочитаемое сообщение об ошибке */
  errorMessage: string | null;

  /** Ссылка для открытия в внешнем браузере (Safari/Chrome) */
  externalBrowserUrl: string | null;

  /** Повторная проверка (после возврата из external browser) */
  recheck: () => void;
}

// ─── Detection Logic ──────────────────────────────────────────────────────────

/**
 * Определяет, запущено ли приложение внутри Telegram WebView.
 */
function isTelegramWebView(): boolean {
  const ua = navigator.userAgent.toLowerCase();
  // Telegram Android WebView
  if (ua.includes("tgweb") || ua.includes("telegram")) return true;
  // iOS in-app browser detection
  if (ua.includes("iphone") && !ua.includes("safari")) return true;
  // Generic WebView markers
  if (ua.includes("wv") || ua.includes("webview")) return true;
  // Telegram Desktop uses its own chromium
  if (window.Telegram?.WebApp) return true;
  return false;
}

/**
 * Проверяет доступность WebAuthn API.
 *
 * Три уровня проверки:
 * 1. window.PublicKeyCredential exists?
 * 2. isUserVerifyingPlatformAuthenticatorAvailable()?
 * 3. isConditionalMediationAvailable()? (optional, для autofill)
 */
async function checkWebAuthnSupport(): Promise<{
  supported: boolean;
  platformAuthenticator: boolean;
  reason?: string;
}> {
  // Level 1: API existence
  if (!window.PublicKeyCredential) {
    return {
      supported: false,
      platformAuthenticator: false,
      reason: "PublicKeyCredential API not available in this browser",
    };
  }

  // Level 2: Platform authenticator (built-in biometrics)
  try {
    const available =
      await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!available) {
      return {
        supported: true, // API exists but no platform authenticator
        platformAuthenticator: false,
        reason: "No platform authenticator (biometrics not available)",
      };
    }
  } catch (err) {
    // Some WebViews throw on this call
    return {
      supported: false,
      platformAuthenticator: false,
      reason: `Platform check failed: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }

  return { supported: true, platformAuthenticator: true };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * React Hook для определения поддержки WebAuthn/Passkeys.
 *
 * @param currentUrl — текущий URL приложения (для генерации external browser link)
 * @returns WebAuthnState
 *
 * @example
 * ```tsx
 * const { isAvailable, needsFallback, externalBrowserUrl } = useWebAuthn(window.location.href);
 *
 * if (needsFallback) {
 *   return <a href={externalBrowserUrl}>Open in External Browser</a>;
 * }
 * ```
 */
export function useWebAuthn(currentUrl: string): WebAuthnState {
  const [status, setStatus] = useState<WebAuthnStatus>("checking");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const performCheck = useCallback(async () => {
    setStatus("checking");
    setErrorMessage(null);

    try {
      const result = await checkWebAuthnSupport();

      if (result.supported && result.platformAuthenticator) {
        setStatus("supported");
        return;
      }

      // Determine if it's a WebView block vs. genuine lack of support
      if (isTelegramWebView()) {
        setStatus("blocked");
        setErrorMessage(
          "Telegram WebView does not support biometric authentication. " +
          "Please open in your device's browser to use Passkeys."
        );
      } else {
        setStatus("unsupported");
        setErrorMessage(
          result.reason ?? "WebAuthn not supported on this device."
        );
      }
    } catch (err) {
      setStatus("error");
      setErrorMessage(
        err instanceof Error ? err.message : "WebAuthn detection failed"
      );
    }
  }, []);

  useEffect(() => {
    performCheck();
  }, [performCheck]);

  // Generate external browser URL
  // On iOS: window.open() from Telegram opens Safari
  // On Android: Intent URL or simple https:// opens default browser
  const externalBrowserUrl =
    status === "blocked" || status === "unsupported" ? currentUrl : null;

  return {
    status,
    isAvailable: status === "supported",
    needsFallback: status === "blocked" || status === "unsupported",
    errorMessage,
    externalBrowserUrl,
    recheck: performCheck,
  };
}

// ─── Error Classification ─────────────────────────────────────────────────────

/**
 * Классифицирует ошибку WebAuthn, произошедшую при подписании.
 *
 * Используется в InvestFlowApp после вызова passkey signing:
 * - NotAllowedError → user cancelled OR WebView blocked
 * - AbortError → timeout
 * - SecurityError → origin mismatch
 * - InvalidStateError → credential already registered
 *
 * @param error — пойманная ошибка при credentials.create() / credentials.get()
 * @returns { recoverable: boolean, message: string, shouldOpenExternal: boolean }
 */
export function classifyWebAuthnError(error: unknown): {
  recoverable: boolean;
  message: string;
  shouldOpenExternal: boolean;
} {
  if (!(error instanceof DOMException)) {
    return {
      recoverable: false,
      message: error instanceof Error ? error.message : "Unknown error",
      shouldOpenExternal: false,
    };
  }

  switch (error.name) {
    case "NotAllowedError":
      // Could be user cancel OR WebView restriction
      if (isTelegramWebView()) {
        return {
          recoverable: false,
          message:
            "Biometric authentication blocked by Telegram. Open in external browser.",
          shouldOpenExternal: true,
        };
      }
      return {
        recoverable: true,
        message: "Authentication cancelled. Tap 'Execute' to try again.",
        shouldOpenExternal: false,
      };

    case "AbortError":
      return {
        recoverable: true,
        message: "Authentication timed out. Please try again.",
        shouldOpenExternal: false,
      };

    case "SecurityError":
      return {
        recoverable: false,
        message: "Security error: origin mismatch. Ensure you opened from Telegram.",
        shouldOpenExternal: false,
      };

    case "InvalidStateError":
      return {
        recoverable: false,
        message: "Passkey already registered on this device.",
        shouldOpenExternal: false,
      };

    default:
      return {
        recoverable: false,
        message: `WebAuthn error: ${error.message}`,
        shouldOpenExternal: false,
      };
  }
}

// ─── Telegram WebApp Type Augmentation ────────────────────────────────────────

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData: string;
        initDataUnsafe: Record<string, unknown>;
        ready: () => void;
        expand: () => void;
        close: () => void;
        openLink: (url: string) => void;
        platform: string;
        version: string;
      };
    };
  }
}
