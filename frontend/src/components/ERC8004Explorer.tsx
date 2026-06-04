// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/components/ERC8004Explorer.tsx
// ERC-8004 Token Explorer Panel (placeholder — will integrate on-chain reads)
// ═══════════════════════════════════════════════════════════════════════════════

export function ERC8004Explorer() {
  return (
    <div className="flex flex-col h-full">
      <h2 className="text-neonCyan text-sm font-bold uppercase tracking-wider mb-3">
        ◆ ERC-8004 Explorer
      </h2>

      <div className="flex-1 space-y-3 text-xs">
        <div className="flex justify-between border-b border-neonCyan/10 pb-2">
          <span className="text-[#6b7280]">Standard</span>
          <span className="text-terminalGreen">ERC-8004</span>
        </div>
        <div className="flex justify-between border-b border-neonCyan/10 pb-2">
          <span className="text-[#6b7280]">Network</span>
          <span>Mantle (5000)</span>
        </div>
        <div className="flex justify-between border-b border-neonCyan/10 pb-2">
          <span className="text-[#6b7280]">Tokens Tracked</span>
          <span className="text-neonCyan">—</span>
        </div>
        <div className="flex justify-between border-b border-neonCyan/10 pb-2">
          <span className="text-[#6b7280]">Last Sync</span>
          <span className="text-[#4b5563] italic">awaiting...</span>
        </div>

        <p className="text-[#4b5563] italic mt-4">
          On-chain token metadata will render here upon integration.
        </p>
      </div>
    </div>
  );
}
