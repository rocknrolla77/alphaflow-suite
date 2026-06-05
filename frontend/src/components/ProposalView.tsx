// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/components/ProposalView.tsx
// Phase 3: Observer Mode — Read-only view of latest arbitrage opportunity
//
// NO wallet signing. NO execution buttons. Pure observer dashboard.
// Shows the latest ForwardRequest metadata flowing through the swarm.
// ═══════════════════════════════════════════════════════════════════════════════

import { useWebSocket } from "../providers/WebSocketProvider.tsx";

// ─── Component ────────────────────────────────────────────────────────────────

export function ProposalView() {
  const { latestInsight, insights, isConnected } = useWebSocket();

  // Filter only ARBITRAGE-type insights
  const arbInsights = insights.filter((i) => i.type === "ARBITRAGE");
  const latest = arbInsights[arbInsights.length - 1] ?? latestInsight;

  if (!latest || latest.type === "HEARTBEAT") {
    return (
      <div className="text-center space-y-3 py-6">
        <div className="text-3xl animate-pulse">🔭</div>
        <p className="text-xs text-[#6b7280] uppercase tracking-wider">
          Observer Mode
        </p>
        <p className="text-[10px] text-[#4b5563]">
          {isConnected
            ? "Connected — Waiting for TEE agent arbitrage signals..."
            : "Connecting to BFF WebSocket..."}
        </p>
      </div>
    );
  }

  return (
    <div className="w-full space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-[#6b7280] uppercase tracking-wider">
          Latest Opportunity
        </span>
        <span
          className={`px-2 py-0.5 rounded text-xs font-bold ${
            latest.action === "BUY"
              ? "bg-terminalGreen/20 text-terminalGreen"
              : "bg-neonMagenta/20 text-neonMagenta"
          }`}
        >
          {latest.action ?? "SIGNAL"}
        </span>
      </div>

      {/* Opportunity Card */}
      <div className="border border-neonCyan/20 rounded p-3 bg-bgDark/30 space-y-2">
        {/* Asset */}
        {latest.asset && (
          <div className="flex justify-between text-xs">
            <span className="text-[#9ca3af]">Pair</span>
            <span className="font-mono text-neonCyan font-bold">{latest.asset}</span>
          </div>
        )}

        {/* Confidence */}
        {latest.confidence != null && (
          <div className="flex justify-between text-xs">
            <span className="text-[#9ca3af]">Confidence</span>
            <ConfidenceBar value={latest.confidence} />
          </div>
        )}

        {/* Reasoning */}
        {latest.reasoning && (
          <div className="text-[10px] text-[#6b7280] border-t border-neonCyan/10 pt-2 mt-2">
            <span className="text-[#4b5563]">REASONING: </span>
            {latest.reasoning.slice(0, 200)}
          </div>
        )}

        {/* Timestamp */}
        <div className="flex justify-between text-[10px] text-[#4b5563]">
          <span>Detected</span>
          <span className="font-mono">
            {new Date(latest.timestamp).toLocaleTimeString()}
          </span>
        </div>
      </div>

      {/* Autonomous Badge */}
      <div className="flex items-center gap-2 text-[10px] text-[#6b7280]">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-neonCyan opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-neonCyan" />
        </span>
        <span>
          Fully autonomous — Byreal swarm executes without human intervention
        </span>
      </div>

      {/* Stats bar */}
      <div className="flex gap-4 text-[10px] text-[#4b5563] border-t border-neonCyan/10 pt-2">
        <span>Signals: <span className="text-[#E0E0E0] font-mono">{arbInsights.length}</span></span>
        <span>Total: <span className="text-[#E0E0E0] font-mono">{insights.length}</span></span>
      </div>
    </div>
  );
}

// ─── Confidence Bar Sub-component ────────────────────────────────────────────

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color =
    pct >= 90
      ? "bg-terminalGreen"
      : pct >= 75
      ? "bg-neonCyan"
      : "bg-yellow-500";

  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-1.5 bg-[#1a1a2e] rounded overflow-hidden">
        <div className={`h-full ${color} rounded`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`font-mono font-bold ${pct >= 90 ? "text-terminalGreen" : "text-[#E0E0E0]"}`}>
        {pct}%
      </span>
    </div>
  );
}
