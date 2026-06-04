// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/App.tsx
// Main App Shell — Provider tree terminates in DashboardLayout
//
// Provider order (in main.tsx + here):
//   WagmiProvider → QueryClientProvider → RainbowKitProvider
//     → App (auth gate) → WebSocketProvider → DashboardLayout
// ═══════════════════════════════════════════════════════════════════════════════

import { useAccount } from "wagmi";
import { WebSocketProvider } from "./providers/WebSocketProvider.tsx";
import { DashboardLayout } from "./components/DashboardLayout.tsx";
import { useAuthJWT } from "./hooks/useAuthJWT.ts";

// ─── App Component ───────────────────────────────────────────────────────────

export default function App() {
  const { isConnected } = useAccount();
  const { token, isAuthenticating, error } = useAuthJWT();

  // ─── Not Connected ──────────────────────────────────────────────────────────
  if (!isConnected) {
    return (
      <div className="min-h-screen bg-bgDark flex items-center justify-center font-mono">
        <div className="scanline" />
        <div className="text-center space-y-4 z-10">
          <h1 className="text-3xl font-bold text-neonCyan">AlphaFlow</h1>
          <p className="text-[#6b7280] text-sm max-w-md">
            Connect your wallet to access the Cyberpunk Terminal Dashboard.
          </p>
          <p className="text-[#4b5563] text-xs">
            Mantle Network · EOA User-Pays · Flash Arbitrage
          </p>
        </div>
      </div>
    );
  }

  // ─── Authenticating (SIWE) ──────────────────────────────────────────────────
  if (isAuthenticating) {
    return (
      <div className="min-h-screen bg-bgDark flex items-center justify-center font-mono">
        <div className="scanline" />
        <div className="text-center space-y-3 z-10">
          <div className="w-8 h-8 border-2 border-neonCyan/30 border-t-neonCyan rounded-full animate-spin mx-auto" />
          <p className="text-sm text-[#9ca3af]">
            Sign the SIWE message in your wallet...
          </p>
        </div>
      </div>
    );
  }

  // ─── Auth Error ─────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="min-h-screen bg-bgDark flex items-center justify-center font-mono">
        <div className="scanline" />
        <div className="text-center space-y-3 max-w-md z-10">
          <p className="text-neonMagenta font-bold">AUTH ERROR</p>
          <p className="text-sm text-[#9ca3af]">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 border border-neonCyan/30 rounded text-sm text-neonCyan hover:bg-neonCyan/10 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // ─── Authenticated → Full Dashboard ────────────────────────────────────────
  if (token) {
    return (
      <WebSocketProvider token={token}>
        <DashboardLayout />
      </WebSocketProvider>
    );
  }

  // ─── Fallback (edge case: waiting for JWT resolution) ───────────────────────
  return (
    <div className="min-h-screen bg-bgDark flex items-center justify-center font-mono">
      <p className="text-sm text-[#4b5563]">Initializing session...</p>
    </div>
  );
}
