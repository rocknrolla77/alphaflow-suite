// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/components/LiveAgentConsole.tsx
// Real-time TEE Agent Insight Feed (WebSocket consumer)
// ═══════════════════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState } from "react";
import { useWebSocket, type AgentInsight } from "../providers/WebSocketProvider.tsx";

export function LiveAgentConsole() {
  const { isConnected, latestInsight } = useWebSocket();
  const [logs, setLogs] = useState<AgentInsight[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (latestInsight) {
      setLogs((prev) => [...prev.slice(-99), latestInsight]);
    }
  }, [latestInsight]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
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
          {isConnected ? "● CONNECTED" : "○ DISCONNECTED"}
        </span>
      </div>

      {/* Log Feed */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto space-y-1 text-xs leading-relaxed scrollbar-thin"
      >
        {logs.length === 0 ? (
          <p className="text-[#4b5563] italic">Awaiting TEE agent insights...</p>
        ) : (
          logs.map((log, i) => (
            <div key={`${log.id}-${i}`} className="flex gap-2">
              <span className="text-[#4b5563] shrink-0">
                {new Date(log.timestamp).toLocaleTimeString()}
              </span>
              <span
                className={
                  log.type === "ALERT"
                    ? "text-neonMagenta"
                    : log.type === "ARBITRAGE"
                    ? "text-terminalGreen"
                    : "text-neonCyan"
                }
              >
                [{log.type}]
              </span>
              <span className="text-[#E0E0E0]">
                {log.asset && `${log.action} ${log.asset}`}
                {log.confidence != null && ` (${(log.confidence * 100).toFixed(0)}%)`}
                {log.reasoning && ` — ${log.reasoning}`}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
