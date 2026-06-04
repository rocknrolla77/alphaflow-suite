// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/components/TopNav.tsx
// Top Navigation Bar — RainbowKit ConnectButton
// ═══════════════════════════════════════════════════════════════════════════════

import { ConnectButton } from "@rainbow-me/rainbowkit";

export function TopNav() {
  return (
    <header className="flex items-center justify-between px-6 py-4 border-b border-alpha-border bg-alpha-surface/50 backdrop-blur-sm sticky top-0 z-50">
      <h1 className="text-lg font-bold text-alpha-accent tracking-tight">
        AlphaFlow
      </h1>
      <ConnectButton
        showBalance={true}
        chainStatus="icon"
        accountStatus="address"
      />
    </header>
  );
}
