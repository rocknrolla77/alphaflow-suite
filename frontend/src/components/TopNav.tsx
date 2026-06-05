// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/components/TopNav.tsx
// Top Navigation Bar — Observer Mode + Optional Wallet Connection
//
// Phase 3: Wallet connection is optional (for on-chain verification).
// Dashboard works fully without it.
// ═══════════════════════════════════════════════════════════════════════════════

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useWebSocket } from "../providers/WebSocketProvider.tsx";

export function TopNav() {
  const { isConnected: wsConnected, insights } = useWebSocket();

  return (
    <header className="flex items-center justify-between">
      {/* Logo + Status */}
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-bold text-neonCyan tracking-tight">
          AlphaFlow<span className="text-neonMagenta ml-1 text-xs align-super">SWARM</span>
        </h1>

        {/* Observer badge */}
        <span className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] border border-neonCyan/20 text-[#6b7280]">
          <span className={`w-1.5 h-1.5 rounded-full ${wsConnected ? "bg-terminalGreen" : "bg-neonMagenta"}`} />
          OBSERVER MODE
        </span>

        {/* Insight counter */}
        <span className="hidden md:inline text-[10px] text-[#4b5563]">
          {insights.length} signals received
        </span>
      </div>

      {/* Wallet (optional — for on-chain verification) */}
      <div className="flex items-center gap-3">
        <span className="hidden lg:inline text-[10px] text-[#4b5563]">
          Connect wallet for on-chain verification
        </span>
        <ConnectButton
          showBalance={false}
          chainStatus="icon"
          accountStatus="avatar"
        />
      </div>
    </header>
  );
}
