// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/components/InvestFlowApp.tsx
// Main UI Component — Proposal Display + ZeroDev Passkey Execution
//
// FLOW:
// 1. Получить ProposalData + EIP-712 от BFF
// 2. Показать параметры сделки
// 3. User подтверждает → ZeroDev Passkey подпись → UserOp → Bundler
// 4. Consume nullifier на BFF
//
// ИНВАРИАНТЫ:
// - Anti-double-click: кнопка Execute блокируется после первого нажатия
// - Фронтенд НЕ хранит секретов
// - Gasless: Paymaster оплачивает gas (Session Key policy)
// ═══════════════════════════════════════════════════════════════════════════════

import { useState, useCallback, useRef } from "react";
import { useWebAuthn, classifyWebAuthnError } from "../hooks/useWebAuthn.ts";
import {
  fetchProposal,
  consumeProposal,
  formatBffError,
  type ProposalData,
  type EIP712Payload,
  BffApiError,
} from "../utils/bffClient.ts";
import { encodeFunctionData, type Hex } from "viem";

// ─── Types ────────────────────────────────────────────────────────────────────

type FlowStatus =
  | "idle"
  | "verifying"    // Fetching from BFF + HMAC check
  | "ready"        // Proposal loaded, awaiting user confirmation
  | "signing"      // Passkey biometric prompt active
  | "executing"    // UserOp sent to bundler, awaiting receipt
  | "success"      // On-chain confirmed
  | "error";       // Something failed

interface LogEntry {
  timestamp: number;
  message: string;
  type: "info" | "success" | "error" | "warn";
}

interface Props {
  proposalId: string;
  hmacSignature: string;
}

// ─── ActiveSentinel ABI Fragment ──────────────────────────────────────────────

const SENTINEL_ABI = [
  {
    name: "executeFlashArbitrage",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenA", type: "address" },
          { name: "tokenB", type: "address" },
          { name: "flashAmount", type: "uint256" },
          { name: "amountOutMinRoute1", type: "uint256" },
          { name: "amountOutMinRoute2", type: "uint256" },
          { name: "minProfitTokenA", type: "uint256" },
          { name: "dexRouter1", type: "address" },
          { name: "dexRouter2", type: "address" },
          { name: "dex1Data", type: "bytes" },
          { name: "dex2Data", type: "bytes" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "profit", type: "uint256" }],
  },
] as const;

// ─── Component ────────────────────────────────────────────────────────────────

export function InvestFlowApp({ proposalId, hmacSignature }: Props) {
  // ─── State ──────────────────────────────────────────────────────────────
  const [status, setStatus] = useState<FlowStatus>("idle");
  const [proposal, setProposal] = useState<ProposalData | null>(null);
  const [eip712, setEip712] = useState<EIP712Payload | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [lockExpires, setLockExpires] = useState<number>(0);

  // Anti-double-click: ref ensures we never fire twice even with re-renders
  const executingRef = useRef(false);

  // WebAuthn detection
  const webauthn = useWebAuthn(window.location.href);

  // ─── Logging ────────────────────────────────────────────────────────────
  const addLog = useCallback((message: string, type: LogEntry["type"] = "info") => {
    setLogs((prev) => [
      ...prev,
      { timestamp: Date.now(), message, type },
    ]);
  }, []);

  // ─── Step 1: Verify & Load Proposal ─────────────────────────────────────
  const loadProposal = useCallback(async () => {
    setStatus("verifying");
    setErrorMsg(null);
    addLog("Verifying HMAC signature...", "info");

    try {
      const response = await fetchProposal(proposalId, hmacSignature);

      setProposal(response.proposal);
      setEip712(response.eip712Payload);
      setLockExpires(response.lockExpiresAt);

      addLog("✓ HMAC verified. Proposal loaded.", "success");
      addLog(`  Asset: ${response.proposal.assetSymbol} (${response.proposal.asset.slice(0, 10)}...)`, "info");
      addLog(`  Action: ${response.proposal.action}`, "info");
      addLog(`  Volume: ${formatAmount(response.proposal.recommendedAmount)} tokens`, "info");
      addLog(`  Deadline: ${new Date(response.proposal.deadline * 1000).toLocaleTimeString()}`, "info");
      addLog("✓ On-chain staleness check passed.", "success");
      addLog("Ready for execution. Awaiting signature.", "info");

      setStatus("ready");
    } catch (err) {
      const msg = formatBffError(err);
      setErrorMsg(msg);
      addLog(`✗ ${msg}`, "error");
      setStatus("error");

      if (err instanceof BffApiError && err.code === "PRICE_STALE") {
        addLog("  Price moved >2% since strategy generation.", "warn");
        addLog("  Wait for new proposal from TEE agent.", "warn");
      }
    }
  }, [proposalId, hmacSignature, addLog]);

  // ─── Step 2: Execute (ZeroDev Passkey → UserOp → Bundler) ──────────────
  const executeProposal = useCallback(async () => {
    // ─── Anti-double-click guard ──────────────────────────────────────────
    if (executingRef.current) {
      addLog("⚠ Already executing. Please wait.", "warn");
      return;
    }
    executingRef.current = true;

    if (!proposal || !eip712) {
      addLog("✗ No proposal loaded.", "error");
      executingRef.current = false;
      return;
    }

    setStatus("signing");
    addLog("Requesting biometric signature (Passkey)...", "info");

    try {
      // ─── ZeroDev Passkey Signing ────────────────────────────────────────
      // Dynamic import to avoid loading ZeroDev SDK upfront (code-split)
      const { createKernelAccountClient, createKernelAccount, constants } = await import("@zerodev/sdk");
      const { toPasskeyValidator, toWebAuthnKey, WebAuthnMode, PasskeyValidatorContractVersion } = await import("@zerodev/passkey-validator");
      const { http: viemHttp, createPublicClient } = await import("viem");
      const { mantle } = await import("viem/chains");

      const BUNDLER_URL = import.meta.env.VITE_BUNDLER_URL;
      const PAYMASTER_URL = import.meta.env.VITE_PAYMASTER_URL;
      const SENTINEL_ADDRESS = import.meta.env.VITE_SENTINEL_ADDRESS as Hex;
      const PROJECT_ID = import.meta.env.VITE_ZERODEV_PROJECT_ID;

      // 1. Create passkey validator (triggers biometric prompt)
      addLog("  Initializing Passkey validator...", "info");

      const publicClient = createPublicClient({
        chain: mantle,
        transport: viemHttp(BUNDLER_URL),
      });

      const webAuthnKey = await toWebAuthnKey({
        passkeyName: "AlphaFlow-Passkey",
        passkeyServerUrl: `https://passkeys.zerodev.app/api/v4/${PROJECT_ID}`,
        mode: WebAuthnMode.Login,
      });

      const passkeyValidator = await toPasskeyValidator(publicClient, {
        webAuthnKey,
        entryPoint: { address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032", version: "0.7" },
        kernelVersion: constants.KERNEL_V3_1,
        validatorContractVersion: PasskeyValidatorContractVersion.V0_0_3_PATCHED,
      });

      // 2. Create Kernel account (v3 — supports Session Keys)
      const kernelAccount = await createKernelAccount(publicClient, {
        plugins: {
          sudo: passkeyValidator,
        },
        entryPoint: { address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032", version: "0.7" },
        kernelVersion: constants.KERNEL_V3_1,
      });

      addLog("  ✓ Passkey validated. Kernel account ready.", "success");
      addLog(`  Account: ${kernelAccount.address}`, "info");

      // 3. Create Kernel client with bundler + paymaster
      const kernelClient = await createKernelAccountClient({
        account: kernelAccount,
        chain: mantle,
        bundlerTransport: viemHttp(BUNDLER_URL),
        paymaster: {
          getPaymasterData: async (userOperation: Record<string, unknown>) => {
            const response = await fetch(PAYMASTER_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ userOperation }),
            });
            return response.json();
          },
        },
      });

      setStatus("executing");
      addLog("Biometric confirmed. Submitting UserOp to bundler...", "info");

      // 4. Encode calldata for ActiveSentinel.executeFlashArbitrage
      const calldata = encodeFunctionData({
        abi: SENTINEL_ABI,
        functionName: "executeFlashArbitrage",
        args: [
          {
            tokenA: proposal.asset as Hex,
            tokenB: "0x0000000000000000000000000000000000000000" as Hex, // Determined by strategy
            flashAmount: BigInt(proposal.recommendedAmount),
            amountOutMinRoute1: 0n,
            amountOutMinRoute2: 0n,
            minProfitTokenA: BigInt(proposal.recommendedAmount) / 100n, // 1% min profit
            dexRouter1: "0x0000000000000000000000000000000000000000" as Hex,
            dexRouter2: "0x0000000000000000000000000000000000000000" as Hex,
            dex1Data: "0x" as Hex,
            dex2Data: "0x" as Hex,
            deadline: BigInt(proposal.deadline),
          },
        ],
      });

      // 5. Send UserOperation
      const userOpHash = await kernelClient.sendUserOperation({
        callData: await kernelAccount.encodeCalls([{
          to: SENTINEL_ADDRESS,
          value: 0n,
          data: calldata,
        }]),
      });

      addLog(`  UserOp hash: ${userOpHash.slice(0, 18)}...`, "info");
      addLog("  Waiting for on-chain confirmation...", "info");

      // 6. Wait for receipt
      const receipt = await kernelClient.waitForUserOperationReceipt({
        hash: userOpHash,
        timeout: 60_000,
      });

      setTxHash(receipt.receipt.transactionHash);
      addLog(`  ✓ Confirmed in block ${receipt.receipt.blockNumber}`, "success");
      addLog(`  Tx: ${receipt.receipt.transactionHash.slice(0, 18)}...`, "success");

      // 7. Consume nullifier on BFF (fire-and-forget with retry)
      addLog("  Burning nullifier...", "info");
      try {
        await consumeProposal(proposalId, hmacSignature);
        addLog("  ✓ Nullifier consumed. Proposal cannot be replayed.", "success");
      } catch {
        addLog("  ⚠ Nullifier burn failed (will be caught by OnChainWatcher)", "warn");
      }

      setStatus("success");
      addLog("═══ EXECUTION COMPLETE ═══", "success");

    } catch (err) {
      // ─── Classify WebAuthn errors ─────────────────────────────────────
      const classified = classifyWebAuthnError(err);

      if (classified.shouldOpenExternal) {
        setErrorMsg(classified.message);
        addLog(`✗ ${classified.message}`, "error");
        setStatus("error");
      } else if (classified.recoverable) {
        addLog(`⚠ ${classified.message}`, "warn");
        setStatus("ready"); // Allow retry
        executingRef.current = false;
        return;
      } else {
        const msg = err instanceof Error ? err.message : "Execution failed";
        setErrorMsg(msg);
        addLog(`✗ ${msg}`, "error");
        setStatus("error");
      }

      executingRef.current = false;
    }
  }, [proposal, eip712, proposalId, hmacSignature, addLog]);

  // ─── Render ─────────────────────────────────────────────────────────────
  return (
    <div style={styles.container}>
      {/* ─── Header ────────────────────────────────────────────────────────── */}
      <header style={styles.header}>
        <div style={styles.logo}>⚡ AlphaFlow</div>
        <div style={styles.statusBadge}>
          <span style={{ ...styles.statusDot, backgroundColor: statusColor(status) }} />
          {statusLabel(status)}
        </div>
      </header>

      {/* ─── WebAuthn Fallback Banner ──────────────────────────────────────── */}
      {webauthn.needsFallback && (
        <div style={styles.fallbackBanner}>
          <p style={styles.fallbackText}>
            ⚠️ {webauthn.errorMessage}
          </p>
          {webauthn.externalBrowserUrl && (
            <button
              style={styles.fallbackButton}
              onClick={() => {
                if (window.Telegram?.WebApp?.openLink) {
                  window.Telegram.WebApp.openLink(webauthn.externalBrowserUrl!);
                } else {
                  window.open(webauthn.externalBrowserUrl!, "_blank");
                }
              }}
            >
              🌐 Open in External Browser
            </button>
          )}
        </div>
      )}

      {/* ─── Proposal Card ─────────────────────────────────────────────────── */}
      {proposal && (
        <div style={styles.card}>
          <h2 style={styles.cardTitle}>Strategy Proposal</h2>
          <div style={styles.grid}>
            <InfoRow label="Asset" value={`${proposal.assetSymbol} (${proposal.asset.slice(0, 8)}...)`} />
            <InfoRow label="Action" value={proposal.action} highlight={proposal.action === "BUY" ? "#00d4aa" : "#ff4d6a"} />
            <InfoRow label="Volume (S_user)" value={`${formatAmount(proposal.recommendedAmount)} tokens`} />
            <InfoRow label="Nonce" value={`#${proposal.nonce}`} />
            <InfoRow label="Deadline" value={new Date(proposal.deadline * 1000).toLocaleTimeString()} />
            <InfoRow label="Signer (TEE)" value={`${proposal.signerAddress.slice(0, 10)}...${proposal.signerAddress.slice(-6)}`} />
            <InfoRow label="Lock Expires" value={lockExpires > 0 ? `${lockExpires - Math.floor(Date.now() / 1000)}s` : "—"} />
          </div>

          {eip712 && (
            <div style={styles.eip712Badge}>
              EIP-712 ✓ Domain: {eip712.domain.name} v{eip712.domain.version} (Chain {eip712.domain.chainId})
            </div>
          )}
        </div>
      )}

      {/* ─── Action Buttons ────────────────────────────────────────────────── */}
      <div style={styles.actions}>
        {status === "idle" && (
          <button style={styles.primaryButton} onClick={loadProposal}>
            🔐 Verify & Load Proposal
          </button>
        )}

        {status === "ready" && !webauthn.needsFallback && (
          <button
            style={styles.executeButton}
            onClick={executeProposal}
            disabled={executingRef.current}
          >
            ⚡ Execute (Passkey Sign)
          </button>
        )}

        {status === "success" && txHash && (
          <a
            href={`https://explorer.mantle.xyz/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            style={styles.linkButton}
          >
            View on Mantle Explorer →
          </a>
        )}

        {status === "error" && (
          <button
            style={styles.retryButton}
            onClick={() => {
              setStatus("idle");
              setErrorMsg(null);
              executingRef.current = false;
            }}
          >
            ↺ Retry
          </button>
        )}
      </div>

      {/* ─── Error Display ─────────────────────────────────────────────────── */}
      {errorMsg && (
        <div style={styles.errorBox}>
          {errorMsg}
        </div>
      )}

      {/* ─── Terminal Log ──────────────────────────────────────────────────── */}
      <div style={styles.terminal}>
        <div style={styles.terminalHeader}>
          <span style={styles.terminalDot} /> <span style={styles.terminalDot} /> <span style={styles.terminalDot} />
          <span style={styles.terminalTitle}>execution.log</span>
        </div>
        <div style={styles.terminalBody}>
          {logs.length === 0 && (
            <div style={styles.logLine}>
              <span style={styles.logMuted}>waiting for action...</span>
            </div>
          )}
          {logs.map((log, i) => (
            <div key={i} style={styles.logLine}>
              <span style={styles.logTime}>
                {new Date(log.timestamp).toLocaleTimeString("en-US", { hour12: false })}
              </span>
              <span style={{ color: logColor(log.type) }}>
                {log.message}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Helper Components ────────────────────────────────────────────────────────

function InfoRow({ label, value, highlight }: { label: string; value: string; highlight?: string }) {
  return (
    <div style={styles.infoRow}>
      <span style={styles.infoLabel}>{label}</span>
      <span style={{ ...styles.infoValue, color: highlight ?? "#e0e0e0" }}>{value}</span>
    </div>
  );
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatAmount(amountStr: string): string {
  try {
    const amount = BigInt(amountStr);
    const eth = Number(amount) / 1e18;
    return eth.toLocaleString("en-US", { maximumFractionDigits: 4 });
  } catch {
    return amountStr;
  }
}

function statusColor(s: FlowStatus): string {
  const map: Record<FlowStatus, string> = {
    idle: "#666",
    verifying: "#ffaa00",
    ready: "#00d4aa",
    signing: "#aa88ff",
    executing: "#ffaa00",
    success: "#00ff88",
    error: "#ff4d6a",
  };
  return map[s];
}

function statusLabel(s: FlowStatus): string {
  const map: Record<FlowStatus, string> = {
    idle: "Idle",
    verifying: "Verifying...",
    ready: "Ready",
    signing: "Awaiting Signature",
    executing: "Executing...",
    success: "Success",
    error: "Error",
  };
  return map[s];
}

function logColor(type: LogEntry["type"]): string {
  const map: Record<LogEntry["type"], string> = {
    info: "#b0b0b0",
    success: "#00ff88",
    error: "#ff4d6a",
    warn: "#ffaa00",
  };
  return map[type];
}

// ─── Styles (Institutional Dark Theme) ────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: "100vh",
    backgroundColor: "#0a0e17",
    color: "#e0e0e0",
    fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
    padding: "16px",
    maxWidth: "480px",
    margin: "0 auto",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "24px",
    paddingBottom: "12px",
    borderBottom: "1px solid #1a2035",
  },
  logo: {
    fontSize: "20px",
    fontWeight: 700,
    color: "#00d4aa",
  },
  statusBadge: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "12px",
    padding: "4px 10px",
    borderRadius: "12px",
    backgroundColor: "#111827",
    border: "1px solid #1f2937",
  },
  statusDot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    display: "inline-block",
  },
  fallbackBanner: {
    backgroundColor: "#1c1407",
    border: "1px solid #d4a000",
    borderRadius: "8px",
    padding: "12px",
    marginBottom: "16px",
  },
  fallbackText: {
    color: "#ffcc00",
    fontSize: "13px",
    margin: "0 0 8px 0",
  },
  fallbackButton: {
    backgroundColor: "#d4a000",
    color: "#000",
    border: "none",
    borderRadius: "6px",
    padding: "8px 16px",
    fontWeight: 600,
    fontSize: "13px",
    cursor: "pointer",
  },
  card: {
    backgroundColor: "#111827",
    border: "1px solid #1f2937",
    borderRadius: "12px",
    padding: "20px",
    marginBottom: "16px",
  },
  cardTitle: {
    fontSize: "14px",
    fontWeight: 600,
    color: "#9ca3af",
    textTransform: "uppercase" as const,
    letterSpacing: "1px",
    marginTop: 0,
    marginBottom: "16px",
  },
  grid: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "10px",
  },
  infoRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  infoLabel: {
    color: "#6b7280",
    fontSize: "12px",
  },
  infoValue: {
    fontSize: "13px",
    fontWeight: 500,
  },
  eip712Badge: {
    marginTop: "16px",
    padding: "8px",
    backgroundColor: "#0f1a2e",
    borderRadius: "6px",
    fontSize: "11px",
    color: "#60a5fa",
    textAlign: "center" as const,
  },
  actions: {
    marginBottom: "16px",
  },
  primaryButton: {
    width: "100%",
    padding: "14px",
    backgroundColor: "#1f2937",
    color: "#e0e0e0",
    border: "1px solid #374151",
    borderRadius: "10px",
    fontSize: "14px",
    fontWeight: 600,
    cursor: "pointer",
  },
  executeButton: {
    width: "100%",
    padding: "14px",
    backgroundColor: "#00d4aa",
    color: "#0a0e17",
    border: "none",
    borderRadius: "10px",
    fontSize: "15px",
    fontWeight: 700,
    cursor: "pointer",
  },
  linkButton: {
    display: "block",
    textAlign: "center" as const,
    padding: "12px",
    color: "#60a5fa",
    fontSize: "13px",
    textDecoration: "none",
    border: "1px solid #1f2937",
    borderRadius: "8px",
  },
  retryButton: {
    width: "100%",
    padding: "12px",
    backgroundColor: "#1c1019",
    color: "#ff4d6a",
    border: "1px solid #4a1f2e",
    borderRadius: "10px",
    fontSize: "14px",
    fontWeight: 600,
    cursor: "pointer",
  },
  errorBox: {
    backgroundColor: "#1c1019",
    border: "1px solid #4a1f2e",
    borderRadius: "8px",
    padding: "12px",
    marginBottom: "16px",
    color: "#ff4d6a",
    fontSize: "13px",
  },
  terminal: {
    backgroundColor: "#0d1117",
    border: "1px solid #21262d",
    borderRadius: "10px",
    overflow: "hidden",
  },
  terminalHeader: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "8px 12px",
    backgroundColor: "#161b22",
    borderBottom: "1px solid #21262d",
  },
  terminalDot: {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    backgroundColor: "#484f58",
    display: "inline-block",
  },
  terminalTitle: {
    marginLeft: "8px",
    fontSize: "11px",
    color: "#484f58",
  },
  terminalBody: {
    padding: "12px",
    maxHeight: "240px",
    overflowY: "auto" as const,
    fontSize: "12px",
    lineHeight: "1.8",
  },
  logLine: {
    display: "flex",
    gap: "8px",
    whiteSpace: "pre-wrap" as const,
  },
  logTime: {
    color: "#484f58",
    flexShrink: 0,
  },
  logMuted: {
    color: "#484f58",
    fontStyle: "italic",
  },
};
