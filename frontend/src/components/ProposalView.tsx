// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/components/ProposalView.tsx
// Proposal Display + EOA Signing (User-Pays flow)
//
// FLOW:
// 1. Fetch active proposal from BFF
// 2. Display trade parameters
// 3. User signs EIP-712 typed data with EOA wallet
// 4. Submit signed tx → on-chain execution (user pays gas)
// ═══════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback } from "react";
import { useAccount, useSignTypedData } from "wagmi";
import {
  fetchProposal,
  consumeProposal,
  formatBffError,
  type ProposalData,
  BffApiError,
} from "../utils/bffClient.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

type FlowStatus =
  | "loading"
  | "ready"
  | "signing"
  | "executing"
  | "success"
  | "error";

// ─── Component ────────────────────────────────────────────────────────────────

export function ProposalView() {
  const { address } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();

  const [status, setStatus] = useState<FlowStatus>("loading");
  const [proposal, setProposal] = useState<ProposalData | null>(null);
  const [error, setError] = useState<string>("");
  const [txHash, setTxHash] = useState<string>("");

  // ─── Load Proposal ──────────────────────────────────────────────────────────

  useEffect(() => {
    const proposalId = new URLSearchParams(window.location.search).get("proposalId");
    if (!proposalId) {
      setStatus("ready");
      return;
    }

    const sig = new URLSearchParams(window.location.search).get("sig") ?? "";
    fetchProposal(proposalId, sig)
      .then((data) => {
        setProposal(data);
        setStatus("ready");
      })
      .catch((err) => {
        setError(err instanceof BffApiError ? formatBffError(err) : String(err));
        setStatus("error");
      });
  }, []);

  // ─── Execute Proposal ───────────────────────────────────────────────────────

  const handleExecute = useCallback(async () => {
    if (!proposal || !address) return;

    try {
      setStatus("signing");

      // EIP-712 typed data signing (standard EOA)
      const signature = await signTypedDataAsync({
        domain: {
          name: "AlphaFlow",
          version: "1",
          chainId: 5000,
          verifyingContract: proposal.signerAddress as `0x${string}`,
        },
        types: {
          Execute: [
            { name: "proposalId", type: "bytes32" },
            { name: "asset", type: "address" },
            { name: "action", type: "uint8" },
            { name: "amount", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "Execute",
        message: {
          proposalId: proposal.id as `0x${string}`,
          asset: proposal.asset as `0x${string}`,
          action: proposal.action === "BUY" ? 0 : 1,
          amount: BigInt(proposal.recommendedAmount),
          nonce: BigInt(proposal.nonce),
          deadline: BigInt(proposal.deadline),
        },
      });

      setStatus("executing");

      // Submit to BFF for on-chain execution
      const result = await consumeProposal(proposal.id, signature, address);
      setTxHash(result.txHash ?? "");
      setStatus("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, [proposal, address, signTypedDataAsync]);

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (status === "loading") {
    return (
      <div className="text-center space-y-2">
        <div className="w-8 h-8 border-2 border-alpha-border border-t-alpha-accent rounded-full animate-spin mx-auto" />
        <p className="text-alpha-muted text-sm">Loading proposal...</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="text-center space-y-3 max-w-md">
        <p className="text-alpha-danger font-bold">Error</p>
        <p className="text-alpha-muted text-sm">{error}</p>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 bg-alpha-surface border border-alpha-border rounded text-sm hover:border-alpha-accent transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (status === "success") {
    return (
      <div className="text-center space-y-3 max-w-md">
        <p className="text-3xl">✅</p>
        <p className="text-alpha-accent font-bold">Execution Confirmed</p>
        {txHash && (
          <a
            href={`https://mantlescan.xyz/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-alpha-muted underline hover:text-alpha-accent"
          >
            View on MantleScan →
          </a>
        )}
      </div>
    );
  }

  if (!proposal) {
    return (
      <div className="text-center space-y-3 max-w-md">
        <p className="text-alpha-muted text-sm">
          No active proposal. Waiting for TEE agent insights...
        </p>
      </div>
    );
  }

  // ─── Proposal Card ──────────────────────────────────────────────────────────

  return (
    <div className="w-full max-w-md bg-alpha-surface border border-alpha-border rounded-lg p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-alpha-muted uppercase tracking-wider">
          Proposal
        </span>
        <span
          className={`px-2 py-0.5 rounded text-xs font-bold ${
            proposal.action === "BUY"
              ? "bg-green-900/30 text-green-400"
              : "bg-red-900/30 text-red-400"
          }`}
        >
          {proposal.action}
        </span>
      </div>

      {/* Details */}
      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-alpha-muted">Asset</span>
          <span className="font-mono">{proposal.assetSymbol}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-alpha-muted">Amount</span>
          <span className="font-mono">{proposal.recommendedAmount}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-alpha-muted">Deadline</span>
          <span className="font-mono text-xs">
            {new Date(proposal.deadline * 1000).toLocaleTimeString()}
          </span>
        </div>
      </div>

      {/* Execute Button */}
      <button
        onClick={handleExecute}
        disabled={status === "signing" || status === "executing"}
        className="w-full py-3 bg-alpha-accent text-alpha-bg font-bold rounded
                   hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed
                   transition-all text-sm"
      >
        {status === "signing"
          ? "Sign with Wallet..."
          : status === "executing"
          ? "Executing..."
          : "Execute Trade"}
      </button>

      <p className="text-xs text-alpha-muted text-center">
        You pay gas · Mantle Network · EOA signing
      </p>
    </div>
  );
}
