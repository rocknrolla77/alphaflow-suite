// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/components/ProofOfAlpha.tsx
// Trustless Verification: local keccak256 hash vs on-chain AlphaAuditor log
//
// FLOW:
//   1. Receive GPT-4 reasoning string from WebSocket stream
//   2. Hash locally: keccak256(toHex(reasoning))
//   3. Query AlphaAuditor.sol logs for latest ReasoningCommitted event
//   4. Compare localHash === onChainHash
//   5. Render "Hardware Verified" (match) or "Unverified" (mismatch)
//
// SECURITY:
//   - No backend trust required — user verifies independently
//   - On-chain hash was committed by TEE agent inside SGX enclave
//   - Frontend only reads public logs (no write access needed)
// ═══════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback } from "react";
import { usePublicClient } from "wagmi";
import { keccak256, toHex, parseAbiItem, type Hex } from "viem";
import { useWebSocket } from "../providers/WebSocketProvider.tsx";

// ─── Contract Config ──────────────────────────────────────────────────────────

const ALPHA_AUDITOR_ADDRESS =
  (import.meta.env.VITE_ALPHA_AUDITOR_ADDRESS as Hex) ??
  "0x0000000000000000000000000000000000000000";

// ABI for the ReasoningCommitted event
// event ReasoningCommitted(bytes32 indexed reasoningHash, uint256 timestamp)
const REASONING_COMMITTED_EVENT = parseAbiItem(
  "event ReasoningCommitted(bytes32 indexed reasoningHash, uint256 timestamp)"
);

// ─── Types ────────────────────────────────────────────────────────────────────

type VerificationStatus = "idle" | "verifying" | "verified" | "unverified" | "error";

// ─── Component ────────────────────────────────────────────────────────────────

export function ProofOfAlpha() {
  const publicClient = usePublicClient();
  const { latestInsight } = useWebSocket();

  const [status, setStatus] = useState<VerificationStatus>("idle");
  const [localHash, setLocalHash] = useState<Hex | null>(null);
  const [onChainHash, setOnChainHash] = useState<Hex | null>(null);
  const [reasoning, setReasoning] = useState<string>("");

  // ─── Verify Reasoning ───────────────────────────────────────────────────────

  const verify = useCallback(
    async (reasoningText: string) => {
      if (!publicClient || !reasoningText) return;
      if (ALPHA_AUDITOR_ADDRESS === "0x0000000000000000000000000000000000000000") {
        setStatus("error");
        return;
      }

      setStatus("verifying");
      setReasoning(reasoningText);

      try {
        // 1. Local hash: keccak256(toHex(reasoning))
        const computed = keccak256(toHex(reasoningText));
        setLocalHash(computed);

        // 2. Fetch latest ReasoningCommitted log from AlphaAuditor
        const logs = await publicClient.getLogs({
          address: ALPHA_AUDITOR_ADDRESS,
          event: REASONING_COMMITTED_EVENT,
          fromBlock: "latest",
        });

        if (logs.length === 0) {
          // No logs found — try last 100 blocks
          const blockNumber = await publicClient.getBlockNumber();
          const fromBlock = blockNumber > 100n ? blockNumber - 100n : 0n;

          const historicalLogs = await publicClient.getLogs({
            address: ALPHA_AUDITOR_ADDRESS,
            event: REASONING_COMMITTED_EVENT,
            fromBlock,
            toBlock: "latest",
          });

          if (historicalLogs.length === 0) {
            setOnChainHash(null);
            setStatus("unverified");
            return;
          }

          // Take the most recent log
          const latest = historicalLogs[historicalLogs.length - 1];
          const chainHash = latest.args.reasoningHash as Hex;
          setOnChainHash(chainHash);

          // 3. Compare
          setStatus(computed === chainHash ? "verified" : "unverified");
        } else {
          const latest = logs[logs.length - 1];
          const chainHash = latest.args.reasoningHash as Hex;
          setOnChainHash(chainHash);

          setStatus(computed === chainHash ? "verified" : "unverified");
        }
      } catch (err) {
        console.error("[ProofOfAlpha] Verification failed:", err);
        setStatus("error");
      }
    },
    [publicClient]
  );

  // ─── React to new insights ─────────────────────────────────────────────────

  useEffect(() => {
    if (latestInsight?.reasoning) {
      verify(latestInsight.reasoning);
    }
  }, [latestInsight, verify]);

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-3">
      {/* Status Badge */}
      <div className="flex items-center gap-3">
        <StatusBadge status={status} />
        <span className="text-xs text-[#6b7280] uppercase tracking-wider">
          Proof of Alpha
        </span>
      </div>

      {/* Hash Comparison */}
      {(localHash || onChainHash) && (
        <div className="space-y-1 text-[10px] font-mono">
          <div className="flex gap-2">
            <span className="text-[#6b7280] w-16 shrink-0">LOCAL:</span>
            <span className="text-[#E0E0E0] truncate">
              {localHash ?? "—"}
            </span>
          </div>
          <div className="flex gap-2">
            <span className="text-[#6b7280] w-16 shrink-0">ON-CHAIN:</span>
            <span className="text-[#E0E0E0] truncate">
              {onChainHash ?? "—"}
            </span>
          </div>
        </div>
      )}

      {/* Reasoning Preview */}
      {reasoning && (
        <p className="text-[10px] text-[#4b5563] truncate max-w-full">
          &gt; {reasoning.slice(0, 120)}{reasoning.length > 120 ? "..." : ""}
        </p>
      )}
    </div>
  );
}

// ─── Status Badge Sub-component ───────────────────────────────────────────────

function StatusBadge({ status }: { status: VerificationStatus }) {
  switch (status) {
    case "verified":
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-bold bg-terminalGreen/10 text-terminalGreen animate-pulse">
          <span className="w-2 h-2 rounded-full bg-terminalGreen" />
          HARDWARE VERIFIED
        </span>
      );

    case "unverified":
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-bold bg-neonMagenta/10 text-neonMagenta">
          <span className="w-2 h-2 rounded-full bg-neonMagenta" />
          UNVERIFIED
        </span>
      );

    case "verifying":
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-bold bg-neonCyan/10 text-neonCyan">
          <span className="w-2 h-2 rounded-full bg-neonCyan animate-ping" />
          VERIFYING...
        </span>
      );

    case "error":
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-bold bg-yellow-500/10 text-yellow-500">
          <span className="w-2 h-2 rounded-full bg-yellow-500" />
          AUDITOR N/A
        </span>
      );

    default:
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs text-[#4b5563]">
          <span className="w-2 h-2 rounded-full bg-[#4b5563]" />
          AWAITING DATA
        </span>
      );
  }
}
