// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/main.tsx
// Entry Point — React + wagmi + RainbowKit + TanStack Query
//
// Phase 3: wagmi/RainbowKit kept for OPTIONAL on-chain verification.
// Dashboard renders without wallet connection (Observer Mode).
// ═══════════════════════════════════════════════════════════════════════════════

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";

import { wagmiConfig } from "./config/wagmi.ts";
import App from "./App.tsx";

import "@rainbow-me/rainbowkit/styles.css";
import "./index.css";

// ─── TanStack Query Client ───────────────────────────────────────────────────

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: 2,
    },
  },
});

// ─── Render ──────────────────────────────────────────────────────────────────

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor: "#00f3ff",
            accentColorForeground: "#0D0D0D",
            borderRadius: "medium",
            overlayBlur: "small",
          })}
        >
          <App />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>
);
