// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/components/ReputationHeatmap.tsx
// Agent Reputation Heatmap (WebSocket consumer)
// ═══════════════════════════════════════════════════════════════════════════════

import { useWebSocket } from "../providers/WebSocketProvider.tsx";

export function ReputationHeatmap() {
  const { isConnected, latestInsight } = useWebSocket();

  // Placeholder grid cells representing reputation scores
  const cells = Array.from({ length: 24 }, (_, i) => {
    const intensity = Math.random();
    return (
      <div
        key={i}
        className="aspect-square rounded-sm transition-colors duration-500"
        style={{
          backgroundColor: `rgba(0, 255, 65, ${intensity * 0.6})`,
        }}
        title={`Epoch ${i}: ${(intensity * 100).toFixed(0)}%`}
      />
    );
  });

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-neonCyan text-sm font-bold uppercase tracking-wider">
          ◈ Reputation Heatmap
        </h2>
        <span className="text-xs text-[#6b7280]">
          {isConnected ? "Live" : "Offline"}
        </span>
      </div>

      {/* Heatmap Grid */}
      <div className="grid grid-cols-8 gap-1 mb-3">
        {cells}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-[#6b7280] mt-auto">
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded-sm bg-terminalGreen/20" />
          <span>Low</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded-sm bg-terminalGreen/60" />
          <span>High</span>
        </div>
        {latestInsight && (
          <span className="ml-auto text-neonCyan">
            Last: {latestInsight.type}
          </span>
        )}
      </div>
    </div>
  );
}
