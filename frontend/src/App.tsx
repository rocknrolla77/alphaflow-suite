// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/App.tsx
// Main App Shell — Observer Mode (no SIWE auth required)
//
// Phase 3 Pivot: Dashboard is now PUBLIC (observer mode).
// WebSocket is open for reading without JWT auth.
// Wallet connection is optional (for on-chain verification only).
// ═══════════════════════════════════════════════════════════════════════════════

import { WebSocketProvider } from "./providers/WebSocketProvider.tsx";
import { DashboardLayout } from "./components/DashboardLayout.tsx";

// ─── App Component ───────────────────────────────────────────────────────────

export default function App() {
  return (
    <WebSocketProvider>
      <DashboardLayout />
    </WebSocketProvider>
  );
}
