// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/components/DashboardLayout.tsx
// Cyberpunk Terminal Dashboard — CSS Grid Layout with CRT Scanline Overlay
// ═══════════════════════════════════════════════════════════════════════════════

import { TopNav } from "./TopNav.tsx";
import { LiveAgentConsole } from "./LiveAgentConsole.tsx";
import { ProofOfAlpha } from "./ProofOfAlpha.tsx";
import { ERC8004Explorer } from "./ERC8004Explorer.tsx";
import { ReputationHeatmap } from "./ReputationHeatmap.tsx";
import { RWARiskPanel } from "./RWARiskPanel.tsx";
import { MEVMetrics } from "./MEVMetrics.tsx";

// ─── Grid Cell Wrapper ────────────────────────────────────────────────────────

function GridCell({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`border border-neonCyan/20 bg-bgDark/50 backdrop-blur-sm p-4 rounded ${className}`}
    >
      {children}
    </div>
  );
}

// ─── Dashboard Layout ─────────────────────────────────────────────────────────

export function DashboardLayout() {
  return (
    <>
      {/* CRT Scanline Overlay */}
      <div className="scanline" />

      {/* Main Grid */}
      <div className="min-h-screen bg-bgDark p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 font-mono text-[#E0E0E0]">
        {/* TopNav — full width */}
        <div className="col-span-full">
          <GridCell>
            <TopNav />
          </GridCell>
        </div>

        {/* LiveAgentConsole — 8 cols */}
        <div className="col-span-12 lg:col-span-8">
          <GridCell className="min-h-[500px] flex flex-col">
            <LiveAgentConsole />
            {/* Proof of Alpha badge — anchored at bottom of console */}
            <div className="mt-3 pt-3 border-t border-neonCyan/10">
              <ProofOfAlpha />
            </div>
          </GridCell>
        </div>

        {/* ERC8004Explorer — 4 cols */}
        <div className="col-span-12 lg:col-span-4">
          <GridCell>
            <ERC8004Explorer />
          </GridCell>
        </div>

        {/* ReputationHeatmap — 8 cols */}
        <div className="col-span-12 lg:col-span-8">
          <GridCell>
            <ReputationHeatmap />
          </GridCell>
        </div>

        {/* RWARiskPanel — 4 cols */}
        <div className="col-span-12 lg:col-span-4">
          <GridCell>
            <RWARiskPanel />
          </GridCell>
        </div>

        {/* MEVMetrics — 4 cols */}
        <div className="col-span-12 lg:col-span-4">
          <GridCell>
            <MEVMetrics />
          </GridCell>
        </div>
      </div>
    </>
  );
}
