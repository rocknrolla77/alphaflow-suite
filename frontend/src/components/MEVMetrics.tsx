// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/components/MEVMetrics.tsx
// MEV Protection Metrics — Gas comparison + Private Mempool status
// ═══════════════════════════════════════════════════════════════════════════════

export function MEVMetrics() {
  return (
    <div className="flex flex-col h-full">
      <h2 className="text-neonCyan text-sm font-bold uppercase tracking-wider mb-4">
        ⚡ MEV Metrics
      </h2>

      {/* Comparative Bar Chart */}
      <div className="space-y-4 flex-1">
        {/* Row 1: Standard Reentrancy Guard */}
        <div className="space-y-1">
          <div className="flex justify-between text-xs">
            <span className="text-[#9ca3af]">Standard Reentrancy Guard (Storage)</span>
            <span className="text-[#E0E0E0] font-bold">5,000 gas</span>
          </div>
          <div className="h-3 w-full bg-[#1f2937] rounded-sm overflow-hidden">
            <div
              className="h-full rounded-sm bg-white"
              style={{ width: "100%" }}
            />
          </div>
        </div>

        {/* Row 2: AlphaFlow Transient Storage */}
        <div className="space-y-1">
          <div className="flex justify-between text-xs">
            <span className="text-[#9ca3af]">AlphaFlow Transient Storage (EIP-1153)</span>
            <span className="text-terminalGreen font-bold">100 gas</span>
          </div>
          <div className="h-3 w-full bg-[#1f2937] rounded-sm overflow-hidden">
            <div
              className="h-full rounded-sm bg-terminalGreen"
              style={{ width: "2%" }}
            />
          </div>
        </div>

        {/* Savings callout */}
        <div className="text-xs text-[#6b7280] border-t border-neonCyan/10 pt-3">
          <span className="text-terminalGreen font-bold">98%</span> gas reduction
          via TSTORE/TLOAD opcodes
        </div>
      </div>

      {/* Private Mempool Status */}
      <div className="mt-4 pt-3 border-t border-neonCyan/10 flex items-center gap-2">
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-neonCyan opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-neonCyan" />
        </span>
        <span className="text-xs text-[#E0E0E0]">
          Private Mempool Routing: <span className="text-neonCyan font-bold">ACTIVE</span>
        </span>
      </div>
    </div>
  );
}
