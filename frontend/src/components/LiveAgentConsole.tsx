// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/components/LiveAgentConsole.tsx
// Real-time TEE Agent + Swarm Worker Feed (WebSocket consumer)
//
// Phase 3: Shows which worker won the race, tx hash, and gas refund.
// ═══════════════════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState } from "react";
import { useWebSocket, type AgentInsight } from "../providers/WebSocketProvider.tsx";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LogEntry {
  id: string;
  timestamp: number;
  type: AgentInsight["type"];
  message: string;
  meta?: {
    asset?: string;
    action?: string;
    confidence?: number;
    winner?: string;
    winnerAddress?: string;
    txHash?: string;
    gasRefund?: string;
    insightHash?: string;
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function LiveAgentConsole() {
  const { isConnected, latestInsight } = useWebSocket();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!latestInsight) return;

    const entries: LogEntry[] = [];

    // Main insight entry
    const mainMsg = buildMainMessage(latestInsight);
    entries.push({
      id: `${latestInsight.id}-main`,
      timestamp: latestInsight.timestamp,
      type: latestInsight.type,
      message: mainMsg,
      meta: {
        asset: latestInsight.asset,
        action: latestInsight.action,
        confidence: latestInsight.confidence,
        insightHash: latestInsight.insightHash,
      },
    });

    // Worker race result (if available)
    if (latestInsight.workerRace) {
      const race = latestInsight.workerRace;
      if (race.status === "won" && race.winner) {
        entries.push({
          id: `${latestInsight.id}-race`,
          timestamp: latestInsight.timestamp + 1,
          type: "SIGNAL",
          message: `RACE WON by ${race.winner} → ${race.txHash?.slice(0, 16)}...`,
          meta: {
            winner: race.winner,
            winnerAddress: race.winnerAddress,
            txHash: race.txHash,
            gasRefund: race.gasRefund,
          },
        });
      } else if (race.status === "pending") {
        entries.push({
          id: `${latestInsight.id}-race-pending`,
          timestamp: latestInsight.timestamp + 1,
          type: "HEARTBEAT",
          message: `RACE STARTED → ${race.participants.length} workers competing...`,
          meta: {},
        });
      }
    }

    setLogs((prev) => [...prev.slice(-97), ...entries]);
  }, [latestInsight]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [logs]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-neonCyan text-sm font-bold uppercase tracking-wider">
          ▶ Live Agent Console
        </h2>
        <span
          className={`text-xs px-2 py-0.5 rounded ${
            isConnected
              ? "bg-terminalGreen/20 text-terminalGreen"
              : "bg-neonMagenta/20 text-neonMagenta"
          }`}
        >
          {isConnected ? "● STREAMING" : "○ DISCONNECTED"}
        </span>
      </div>

      {/* Log Feed */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto space-y-0.5 text-xs leading-relaxed scrollbar-thin"
      >
        {logs.length === 0 ? (
          <div className="text-center py-8 space-y-2">
            <p className="text-[#4b5563] italic">
              Awaiting TEE agent insights...
            </p>
            <p className="text-[10px] text-[#374151]">
              Swarm workers are listening on Redis Stream
            </p>
          </div>
        ) : (
          logs.map((log) => <LogRow key={log.id} entry={log} />)
        )}
      </div>
    </div>
  );
}

// ─── Log Row Sub-component ────────────────────────────────────────────────────

function LogRow({ entry }: { entry: LogEntry }) {
  const typeColors: Record<string, string> = {
    ARBITRAGE: "text-terminalGreen",
    SIGNAL: "text-neonCyan",
    ALERT: "text-neonMagenta",
    HEARTBEAT: "text-[#6b7280]",
  };

  const hasRaceMeta = entry.meta?.winner || entry.meta?.txHash;

  return (
    <div className="flex gap-2 py-0.5 hover:bg-neonCyan/5 rounded px-1 group">
      {/* Timestamp */}
      <span className="text-[#4b5563] shrink-0 w-[72px]">
        {new Date(entry.timestamp).toLocaleTimeString()}
      </span>

      {/* Type badge */}
      <span className={`shrink-0 w-[90px] ${typeColors[entry.type] ?? "text-[#6b7280]"}`}>
        [{entry.type}]
      </span>

      {/* Message */}
      <span className="text-[#E0E0E0] flex-1">
        {entry.message}
      </span>

      {/* Winner badge */}
      {hasRaceMeta && (
        <span className="shrink-0 text-terminalGreen font-bold animate-pulse" title={entry.meta?.winnerAddress ?? ""}>
          ★ {entry.meta?.winnerAddress ? entry.meta.winnerAddress.slice(0, 8) + "…" : "WON"}
        </span>
      )}

      {/* Tx link (on hover) */}
      {entry.meta?.txHash && (
        <a
          href={`https://mantlescan.xyz/tx/${entry.meta.txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-neonCyan/50 hover:text-neonCyan opacity-0 group-hover:opacity-100 transition-opacity"
          title="View on MantleScan"
        >
          ↗
        </a>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildMainMessage(insight: AgentInsight): string {
  const parts: string[] = [];

  if (insight.asset && insight.action) {
    parts.push(`${insight.action} ${insight.asset}`);
  }

  if (insight.confidence != null) {
    parts.push(`(${(insight.confidence * 100).toFixed(0)}%)`);
  }

  if (insight.reasoning) {
    parts.push(`— ${insight.reasoning}`);
  }

  if (parts.length === 0) {
    return insight.type === "HEARTBEAT" ? "♥ heartbeat" : "signal received";
  }

  return parts.join(" ");
}
