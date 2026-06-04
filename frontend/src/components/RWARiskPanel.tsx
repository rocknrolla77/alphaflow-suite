// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/components/RWARiskPanel.tsx
// Real World Asset Risk Assessment Panel
// ═══════════════════════════════════════════════════════════════════════════════

export function RWARiskPanel() {
  return (
    <div className="flex flex-col h-full">
      <h2 className="text-neonCyan text-sm font-bold uppercase tracking-wider mb-3">
        ⚠ RWA Risk Panel
      </h2>

      <div className="flex-1 space-y-3 text-xs">
        {/* Risk Indicators */}
        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-[#6b7280]">Liquidity Risk</span>
            <div className="flex items-center gap-2">
              <div className="w-16 h-1.5 bg-[#1f2937] rounded-full overflow-hidden">
                <div className="h-full w-1/3 bg-terminalGreen rounded-full" />
              </div>
              <span className="text-terminalGreen">LOW</span>
            </div>
          </div>

          <div className="flex justify-between items-center">
            <span className="text-[#6b7280]">Slippage Risk</span>
            <div className="flex items-center gap-2">
              <div className="w-16 h-1.5 bg-[#1f2937] rounded-full overflow-hidden">
                <div className="h-full w-2/3 bg-yellow-500 rounded-full" />
              </div>
              <span className="text-yellow-500">MED</span>
            </div>
          </div>

          <div className="flex justify-between items-center">
            <span className="text-[#6b7280]">MEV Exposure</span>
            <div className="flex items-center gap-2">
              <div className="w-16 h-1.5 bg-[#1f2937] rounded-full overflow-hidden">
                <div className="h-full w-1/4 bg-terminalGreen rounded-full" />
              </div>
              <span className="text-terminalGreen">LOW</span>
            </div>
          </div>

          <div className="flex justify-between items-center">
            <span className="text-[#6b7280]">Oracle Deviation</span>
            <div className="flex items-center gap-2">
              <div className="w-16 h-1.5 bg-[#1f2937] rounded-full overflow-hidden">
                <div className="h-full w-1/5 bg-terminalGreen rounded-full" />
              </div>
              <span className="text-terminalGreen">LOW</span>
            </div>
          </div>
        </div>

        <div className="border-t border-neonCyan/10 pt-3 mt-auto">
          <p className="text-[#4b5563] italic">
            Risk assessment updates with each TEE agent cycle.
          </p>
        </div>
      </div>
    </div>
  );
}
