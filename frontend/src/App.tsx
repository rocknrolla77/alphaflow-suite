// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/App.tsx
// Entry Point — Telegram Mini App Parameter Parsing
//
// Telegram deep link format:
//   https://t.me/AlphaFlowBot?startapp=<proposalId>_<hmacSignatureBase64>
//
// WebApp.initDataUnsafe.start_param OR URL param tgWebAppStartParam
// ═══════════════════════════════════════════════════════════════════════════════

import { useState, useEffect } from "react";
import { InvestFlowApp } from "./components/InvestFlowApp.tsx";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ParsedParams {
  proposalId: string;
  hmacSignature: string;
}

type AppState =
  | { status: "loading" }
  | { status: "ready"; params: ParsedParams }
  | { status: "error"; message: string };

// ─── Parameter Parsing ────────────────────────────────────────────────────────

/**
 * Извлекает startapp параметр из Telegram WebApp или URL.
 *
 * Приоритет:
 * 1. window.Telegram.WebApp.initDataUnsafe.start_param (нативный TMA)
 * 2. URL param: ?tgWebAppStartParam=... (iframe / dev mode)
 * 3. URL hash: #tgWebAppStartParam=... (legacy)
 *
 * @returns raw startapp string или null
 */
function extractStartParam(): string | null {
  // 1. Native Telegram WebApp API
  const tgWebApp = window.Telegram?.WebApp;
  if (tgWebApp) {
    const startParam = tgWebApp.initDataUnsafe?.start_param as string | undefined;
    if (startParam) return startParam;
  }

  // 2. URL query param (dev / iframe)
  const urlParams = new URLSearchParams(window.location.search);
  const fromQuery = urlParams.get("tgWebAppStartParam");
  if (fromQuery) return fromQuery;

  // 3. URL hash params (legacy Telegram format)
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const fromHash = hashParams.get("tgWebAppStartParam");
  if (fromHash) return fromHash;

  return null;
}

/**
 * Парсит startapp строку в proposalId + hmacSignature.
 *
 * Формат: <proposalId>_<hmacSignatureHex>
 *
 * proposalId: UUID или hex string (32-64 chars)
 * hmacSignature: hex-encoded HMAC-SHA256 (64 chars = 32 bytes)
 *
 * Также поддерживает Base64url (Telegram может encoding):
 * В этом случае декодируем Base64 → hex
 *
 * @param raw — raw startapp string
 * @returns ParsedParams или throws с описанием ошибки
 */
function parseStartParam(raw: string): ParsedParams {
  // Validate non-empty
  if (!raw || raw.length < 3) {
    throw new Error("Start parameter is empty or too short");
  }

  // Find the separator (last underscore, since proposalId might contain hyphens)
  const lastUnderscore = raw.lastIndexOf("_");
  if (lastUnderscore === -1 || lastUnderscore === 0 || lastUnderscore === raw.length - 1) {
    throw new Error(
      "Invalid format. Expected: <proposalId>_<signature>. " +
      "Please reopen from a valid Telegram notification."
    );
  }

  const proposalId = raw.slice(0, lastUnderscore);
  let hmacSignature = raw.slice(lastUnderscore + 1);

  // Check if signature is Base64url encoded (Telegram sometimes encodes)
  if (/^[A-Za-z0-9\-_]+=*$/.test(hmacSignature) && hmacSignature.length !== 64) {
    try {
      // Decode Base64url → hex
      const base64 = hmacSignature.replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(base64);
      hmacSignature = Array.from(binary, (c) =>
        c.charCodeAt(0).toString(16).padStart(2, "0")
      ).join("");
    } catch {
      // Not base64, keep as-is
    }
  }

  // Validate proposalId format (UUID or hex)
  const validProposalId = /^[a-fA-F0-9\-]{8,128}$/.test(proposalId);
  if (!validProposalId) {
    throw new Error(
      `Invalid proposalId format: "${proposalId.slice(0, 20)}..." ` +
      "Expected UUID or hex string."
    );
  }

  // Validate HMAC signature (64 hex chars = SHA256)
  const validSignature = /^[a-fA-F0-9]{64}$/.test(hmacSignature);
  if (!validSignature) {
    throw new Error(
      `Invalid HMAC signature format (got ${hmacSignature.length} chars, expected 64 hex). ` +
      "Link may be corrupted."
    );
  }

  return { proposalId, hmacSignature };
}

// ─── App Component ────────────────────────────────────────────────────────────

export default function App() {
  const [state, setState] = useState<AppState>({ status: "loading" });

  useEffect(() => {
    // Notify Telegram that we're ready (expands WebApp to full height)
    const tgWebApp = window.Telegram?.WebApp;
    if (tgWebApp) {
      tgWebApp.ready();
      tgWebApp.expand();
    }

    // Extract and parse parameters
    try {
      const raw = extractStartParam();

      if (!raw) {
        setState({
          status: "error",
          message:
            "No start parameter found. " +
            "Please open this app from a Telegram notification (deep link).",
        });
        return;
      }

      const params = parseStartParam(raw);
      setState({ status: "ready", params });
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Failed to parse parameters",
      });
    }
  }, []);

  // ─── Render ───────────────────────────────────────────────────────────────
  switch (state.status) {
    case "loading":
      return (
        <div style={styles.fullscreen}>
          <div style={styles.spinner} />
          <p style={styles.loadingText}>Initializing...</p>
        </div>
      );

    case "error":
      return (
        <div style={styles.fullscreen}>
          <div style={styles.errorIcon}>⚠️</div>
          <h2 style={styles.errorTitle}>Cannot Load Proposal</h2>
          <p style={styles.errorMessage}>{state.message}</p>
          <p style={styles.hint}>
            Tap a proposal notification in Telegram to open this app.
          </p>
        </div>
      );

    case "ready":
      return (
        <InvestFlowApp
          proposalId={state.params.proposalId}
          hmacSignature={state.params.hmacSignature}
        />
      );
  }
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  fullscreen: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0a0e17",
    color: "#e0e0e0",
    fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
    padding: "24px",
    textAlign: "center",
  },
  spinner: {
    width: "32px",
    height: "32px",
    border: "3px solid #1f2937",
    borderTopColor: "#00d4aa",
    borderRadius: "50%",
    animation: "spin 1s linear infinite",
  },
  loadingText: {
    marginTop: "16px",
    color: "#6b7280",
    fontSize: "14px",
  },
  errorIcon: {
    fontSize: "48px",
    marginBottom: "16px",
  },
  errorTitle: {
    fontSize: "18px",
    fontWeight: 600,
    color: "#ff4d6a",
    margin: "0 0 12px 0",
  },
  errorMessage: {
    fontSize: "13px",
    color: "#9ca3af",
    maxWidth: "320px",
    lineHeight: "1.6",
  },
  hint: {
    marginTop: "24px",
    fontSize: "12px",
    color: "#4b5563",
  },
};
