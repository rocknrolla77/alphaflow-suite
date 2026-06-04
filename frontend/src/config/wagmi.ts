// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/config/wagmi.ts
// wagmi + RainbowKit Configuration — Mantle Network (EOA, User-Pays)
//
// АРХИТЕКТУРА:
//   - Standard EOA signing (NO Account Abstraction)
//   - User pays gas directly (User-Pays flow)
//   - Mantle mainnet (chainId: 5000)
//   - RainbowKit connectors: MetaMask, WalletConnect, Coinbase
// ═══════════════════════════════════════════════════════════════════════════════

import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "wagmi";
import { mantle } from "wagmi/chains";

// ─── Environment ─────────────────────────────────────────────────────────────

const WALLETCONNECT_PROJECT_ID =
  import.meta.env.VITE_WC_PROJECT_ID ?? "00000000000000000000000000000000";

const MANTLE_RPC_URL =
  import.meta.env.VITE_MANTLE_RPC_URL ?? "https://rpc.mantle.xyz";

// ─── wagmi Config ────────────────────────────────────────────────────────────

export const wagmiConfig = getDefaultConfig({
  appName: "AlphaFlow",
  projectId: WALLETCONNECT_PROJECT_ID,
  chains: [mantle],
  transports: {
    [mantle.id]: http(MANTLE_RPC_URL),
  },
});
