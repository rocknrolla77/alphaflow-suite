// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/components/DashboardLayout.tsx
// Cyberpunk Terminal Dashboard — Observer Mode
//
// Phase 3: Public observer dashboard. No wallet required.
// Grid: Agent Console (8) + SwarmMetrics (4) + Proof-of-Alpha banner
// ═══════════════════════════════════════════════════════════════════════════════

import { TopNav } from "./TopNav.tsx";
import { LiveAgentConsole } from "./LiveAgentConsole.tsx";
import { ProofOfAlpha } from "./ProofOfAlpha.tsx";
import { SwarmMetrics } from "./SwarmMetrics.tsx";
import { ProposalView } from "./ProposalView.tsx";
import { ERC8004Explorer } from "./ERC8004Explorer.tsx";
import { ReputationHeatmap } from "./ReputationHeatmap.tsx";
import { RWARiskPanel } from "./RWARiskPanel.tsx";

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
      <div className="min-h-screen bg-bgDark p-4 lg:p-6 grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-6 font-mono text-[#E0E0E0]">
        {/* TopNav — full width */}
        <div className="col-span-full">
          <GridCell>
            <TopNav />
          </GridCell>
        </div>

        {/* LiveAgentConsole — 8 cols (main content) */}
        <div className="col-span-12 lg:col-span-8">
          <GridCell className="min-h-[500px] flex flex-col">
            <LiveAgentConsole />
            {/* Proof of Alpha badge — anchored at bottom of console */}
            <div className="mt-3 pt-3 border-t border-neonCyan/10">
              <ProofOfAlpha />
            </div>
          </GridCell>
        </div>

        {/* SwarmMetrics (Byreal Economy) — 4 cols */}
        <div className="col-span-12 lg:col-span-4 space-y-4 lg:space-y-6">
          <GridCell>
            <ProposalView />
          </GridCell>
          <GridCell className="min-h-[340px]">
            <SwarmMetrics />
          </GridCell>
        </div>

        {/* ERC8004Explorer — 4 cols */}
        <div className="col-span-12 lg:col-span-4">
          <GridCell>
            <ERC8004Explorer />
          </GridCell>
        </div>

        {/* ReputationHeatmap — 4 cols */}
        <div className="col-span-12 lg:col-span-4">
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
      </div>
    </>
  );
}
