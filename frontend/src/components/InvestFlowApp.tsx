// Файл: frontend/src/components/InvestFlowApp.tsx
// Telegram Mini App — Yield Architect Execution Interface
// WebAuthn/Passkey signing with fallback to external browser

import React, { useEffect, useState, useCallback, useRef } from "react";
import { BFFClient, ProposalData, parseStartAppParam } from "../utils/bffClient";
import { detectWebAuthnSupport, WebAuthnCapability, buildExternalBrowserUrl } from "../hooks/useWebAuthnSupport";

// ═══════════════════════════════════════════════════════════════════════
//                          TYPES
// ═══════════════════════════════════════════════════════════════════════

type AppStatus =
    | "initializing"
    | "checking_webauthn"
    | "loading_proposal"
    | "simulating"
    | "ready"
    | "signing"
    | "executing"
    | "executed"
    | "failed"
    | "expired"
    | "webauthn_unavailable";

interface LogEntry {
    time: string;
    message: string;
    level: "info" | "warn" | "error" | "success";
}

// ═══════════════════════════════════════════════════════════════════════
//                      MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════

export default function InvestFlowApp() {
    const [status, setStatus] = useState<AppStatus>("initializing");
    const [proposal, setProposal] = useState<ProposalData | null>(null);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [webauthn, setWebauthn] = useState<WebAuthnCapability | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [countdown, setCountdown] = useState<number>(0);

    // Anti-double-click: блокировка после первого submit
    const executionLockRef = useRef(false);

    // Парсим startapp из URL
    const params = parseStartAppParam(
        new URLSearchParams(window.location.search).get("startapp")
    );

    const bffClient = params ? new BFFClient(params.hmacSignature) : null;

    // ─── Initialization Flow ─────────────────────────────────────────

    useEffect(() => {
        if (!params || !bffClient) {
            setError("Invalid or missing parameters");
            setStatus("failed");
            return;
        }
        initializeFlow();
    }, []);

    // ─── Countdown Timer ─────────────────────────────────────────────

    useEffect(() => {
        if (!proposal) return;
        const interval = setInterval(() => {
            const remaining = proposal.deadline - Math.floor(Date.now() / 1000);
            if (remaining <= 0) {
                setStatus("expired");
                setCountdown(0);
                clearInterval(interval);
            } else {
                setCountdown(remaining);
            }
        }, 1000);
        return () => clearInterval(interval);
    }, [proposal]);

    // ─── Flow: Check WebAuthn → Load Proposal → Simulate ────────────

    async function initializeFlow() {
        try {
            // Step 1: WebAuthn detection
            setStatus("checking_webauthn");
            addLog("Detecting WebAuthn capability...", "info");
            const capability = await detectWebAuthnSupport();
            setWebauthn(capability);

            if (!capability.isSupported || !capability.hasPlatformAuth) {
                addLog(`WebAuthn: ${capability.reason}`, "warn");
                setStatus("webauthn_unavailable");
                return;
            }
            addLog("WebAuthn: Platform authenticator available ✓", "success");

            // Step 2: Fetch proposal from BFF (HMAC verified server-side)
            setStatus("loading_proposal");
            addLog("Fetching proposal from BFF (HMAC verification)...", "info");
            const data = await bffClient!.getProposal(params!.proposalId);
            setProposal(data);
            addLog(`Proposal loaded: ${data.action} ${data.assetSymbol}`, "success");

            if (data.stalenessWarning) {
                addLog(`⚠️ Staleness: ${data.stalenessWarning}`, "warn");
            }

            // Step 3: Off-chain simulation
            setStatus("simulating");
            addLog("Running on-chain simulation (eth_call)...", "info");
            const sim = await bffClient!.simulate(params!.proposalId);

            if (sim.willRevert) {
                addLog(`❌ Simulation reverted: ${sim.reason}`, "error");
                setError(`Transaction will revert: ${sim.reason}`);
                setStatus("failed");
                return;
            }
            addLog("Simulation passed ✓ — transaction will succeed", "success");
            setStatus("ready");
        } catch (err: any) {
            addLog(`Error: ${err.message}`, "error");
            setError(err.message);
            setStatus("failed");
        }
    }

    // ─── Execute: Passkey Sign → UserOp ──────────────────────────────

    const handleExecute = useCallback(async () => {
        // Anti-double-click
        if (executionLockRef.current) return;
        executionLockRef.current = true;

        if (!proposal || !bffClient || !params) return;

        try {
            setStatus("signing");
            addLog("[WebAuthn] Requesting Passkey signature (FaceID/TouchID)...", "info");

            // ZeroDev Passkey signing
            // В реальности: import { signerToPasskeyValidator } from "@zerodev/passkey-validator"
            // Здесь абстрагировано — ZeroDev SDK обрабатывает WebAuthn ceremony
            const { userOpHash } = await signAndSendUserOp(proposal);

            setStatus("executing");
            addLog(`[Kernel] UserOp submitted: ${userOpHash.substring(0, 18)}...`, "success");

            // Consume nullifier
            await bffClient.consume(params.proposalId);
            addLog("[BFF] Nullifier consumed — proposal cannot be replayed", "info");

            setStatus("executed");
            addLog("✅ Transaction executed successfully", "success");
        } catch (err: any) {
            setStatus("failed");
            executionLockRef.current = false; // Allow retry on actual errors

            if (err.name === "NotAllowedError") {
                addLog("[WebAuthn] User cancelled biometric verification", "warn");
                setError("Biometric verification cancelled. Try again.");
            } else {
                addLog(`[Error] ${err.message}`, "error");
                setError(err.message);
            }
        }
    }, [proposal, bffClient, params]);

    // ─── Helpers ─────────────────────────────────────────────────────

    function addLog(message: string, level: LogEntry["level"]) {
        setLogs((prev) => [
            ...prev,
            { time: new Date().toLocaleTimeString(), message, level },
        ]);
    }

    // ─── Render ──────────────────────────────────────────────────────

    // WebAuthn unavailable — show fallback
    if (status === "webauthn_unavailable" && webauthn && params) {
        return (
            <div className="alphaflow-tma dark-theme">
                <div className="fallback-screen">
                    <h2>⚠️ WebAuthn Unavailable</h2>
                    <p>{webauthn.reason}</p>
                    <p>Your Telegram WebView doesn't support biometric signing.</p>
                    <a
                        href={buildExternalBrowserUrl(params.proposalId, params.hmacSignature)}
                        target="_blank"
                        rel="noopener"
                        className="btn-primary"
                    >
                        Open in External Browser →
                    </a>
                    <p className="hint">
                        Safari/Chrome supports FaceID/TouchID for transaction signing.
                    </p>
                </div>
            </div>
        );
    }

    // Error state
    if (status === "failed" || error) {
        return (
            <div className="alphaflow-tma dark-theme">
                <div className="error-screen">
                    <h2>❌ Error</h2>
                    <p>{error}</p>
                    <button onClick={() => window.location.reload()} className="btn-secondary">
                        Retry
                    </button>
                </div>
                <LogsSection logs={logs} />
            </div>
        );
    }

    // Loading states
    if (!proposal) {
        return (
            <div className="alphaflow-tma dark-theme">
                <div className="loading-screen">
                    <div className="spinner" />
                    <p>{getStatusMessage(status)}</p>
                </div>
                <LogsSection logs={logs} />
            </div>
        );
    }

    // Main UI
    return (
        <div className="alphaflow-tma dark-theme">
            <header className="tma-header">
                <h1>Yield Architect</h1>
                <span className={`badge ${status === "executed" ? "badge-success" : "badge-active"}`}>
                    {status === "executed" ? "EXECUTED" : "LIVE"}
                </span>
            </header>

            {/* Countdown */}
            {status !== "executed" && countdown > 0 && (
                <div className={`countdown ${countdown < 60 ? "countdown-urgent" : ""}`}>
                    ⏱ Expires in: {Math.floor(countdown / 60)}m {countdown % 60}s
                </div>
            )}

            {/* Proposal Card */}
            <section className="proposal-card">
                <div className="action-badge">
                    {proposal.action === "BUY" ? "🟢" : "🔴"} {proposal.action}
                </div>
                <h2>{proposal.assetSymbol}</h2>

                <div className="metrics-grid">
                    <div className="metric">
                        <span className="label">Volume (S_user)</span>
                        <span className="value">
                            ${proposal.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                        </span>
                    </div>
                    <div className="metric">
                        <span className="label">Weight (W)</span>
                        <span className="value">{(proposal.weight * 100).toFixed(3)}%</span>
                    </div>
                    <div className="metric">
                        <span className="label">Confidence</span>
                        <span className="value">{(proposal.confidence * 100).toFixed(1)}%</span>
                    </div>
                    <div className="metric">
                        <span className="label">Max Slippage</span>
                        <span className="value">{proposal.maxSlippage}%</span>
                    </div>
                </div>

                {/* Staleness Warning */}
                {proposal.stalenessWarning && (
                    <div className="warning-banner">
                        ⚠️ {proposal.stalenessWarning}
                    </div>
                )}

                {/* TEE Verification */}
                <div className="tee-proof">
                    <span className="label">TEE Signer</span>
                    <code>{proposal.teeSignerAddress.substring(0, 20)}...</code>
                </div>
            </section>

            {/* Execute Button */}
            {status !== "executed" && (
                <button
                    className="execute-btn"
                    onClick={handleExecute}
                    disabled={status !== "ready" || executionLockRef.current}
                >
                    {status === "signing"
                        ? "🔐 Awaiting Biometric..."
                        : status === "executing"
                        ? "⏳ Submitting UserOp..."
                        : "Execute Transaction"}
                </button>
            )}

            {status === "executed" && (
                <div className="success-banner">
                    ✅ Transaction executed successfully. You can close this window.
                </div>
            )}

            {/* Logs */}
            <LogsSection logs={logs} />
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════
//                    SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════

function LogsSection({ logs }: { logs: LogEntry[] }) {
    return (
        <section className="terminal-logs">
            <h3>System Logs</h3>
            <div className="log-window">
                {logs.map((log, i) => (
                    <div key={i} className={`log-entry log-${log.level}`}>
                        <span className="log-time">{log.time}</span>
                        <span className="log-msg">{log.message}</span>
                    </div>
                ))}
            </div>
        </section>
    );
}

function getStatusMessage(status: AppStatus): string {
    switch (status) {
        case "initializing": return "Initializing...";
        case "checking_webauthn": return "Checking WebAuthn support...";
        case "loading_proposal": return "Loading proposal (verifying HMAC)...";
        case "simulating": return "Simulating transaction on-chain...";
        default: return "Please wait...";
    }
}

// ═══════════════════════════════════════════════════════════════════════
//                PLACEHOLDER: ZeroDev Passkey Signing
// ═══════════════════════════════════════════════════════════════════════

/**
 * Placeholder для ZeroDev Passkey подписи.
 * В продакшене: полноценная интеграция signerToPasskeyValidator.
 */
async function signAndSendUserOp(proposal: ProposalData): Promise<{ userOpHash: string }> {
    // TODO: Replace with actual ZeroDev Passkey flow
    //
    // const passkeyValidator = await signerToPasskeyValidator(publicClient, {
    //     passkeyName: "AlphaFlow Suite",
    //     passkeyServerUrl: env.VITE_PASSKEY_SERVER_URL,
    // });
    //
    // const kernelClient = createKernelAccountClient({
    //     account: passkeyValidator,
    //     chain: mantle,
    //     bundlerTransport: http(env.VITE_BUNDLER_URL),
    // });
    //
    // const hash = await kernelClient.sendUserOperation({
    //     userOperation: {
    //         callData: proposal.executionPayload,
    //     },
    // });
    //
    // return { userOpHash: hash };

    // Simulated for development
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return {
        userOpHash: "0x" + Array.from({ length: 64 }, () =>
            Math.floor(Math.random() * 16).toString(16)
        ).join(""),
    };
}
