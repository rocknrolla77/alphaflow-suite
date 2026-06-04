# AlphaFlow Suite — Complete Project Documentation

> **Flash Arbitrage Intelligence System on Mantle Network**
> Winner of DoraHacks Mantle Hackathon · Phase 2: AI Awakening

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Architecture Overview](#architecture-overview)
3. [System Components](#system-components)
   - [Smart Contracts (Foundry/Solidity)](#1-smart-contracts-foundrysoldity-0824)
   - [TEE Agent (Phala DStack CVM)](#2-tee-agent-phala-dstack-cvm)
   - [Backend-for-Frontend (Hono)](#3-backend-for-frontend-bff--hono)
   - [Frontend PWA (Vite + React)](#4-frontend-pwa-vite--react)
4. [Data Flow & Pipeline](#data-flow--pipeline)
5. [Security Model](#security-model)
6. [Deployment Architecture](#deployment-architecture)
7. [On-Chain Contracts (Mantle Mainnet)](#on-chain-contracts-mantle-mainnet)
8. [E2E Qualification Test Results](#e2e-qualification-test-results)
9. [Configuration & Environment](#configuration--environment)
10. [Directory Structure](#directory-structure)
11. [Build & Run](#build--run)
12. [Testing Strategy](#testing-strategy)
13. [Protocol Integrations](#protocol-integrations)
14. [ERC-8004 Agent Identity Standard](#erc-8004-agent-identity-standard)
15. [Circuit Breaker Safety System](#circuit-breaker-safety-system)
16. [Proof-of-Alpha Mechanism](#proof-of-alpha-mechanism)

---

## Executive Summary

AlphaFlow Suite is an AI-powered flash arbitrage system deployed on **Mantle Network (L2, Chain ID: 5000)**. It combines:

- **TEE-secured AI agent** (Phala Network CVM) that monitors smart money wallets via Nansen MCP, discovers correlated wallet clusters, and generates flash arbitrage proposals using GPT-4 reasoning
- **Atomic flash arbitrage contracts** borrowing from INIT Capital, swapping across Merchant Moe and Agni Finance DEXes
- **Cryptographic Proof-of-Alpha** — every insight is hashed (keccak256) and committed on-chain before execution, creating an immutable audit trail
- **Real-time cyberpunk dashboard** with SIWE authentication, WebSocket streaming, and on-chain verification

The system operates in **User-Pays mode** (EOA signs transactions, pays gas in MNT) with full Human-in-the-Loop approval via the PWA terminal interface.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           MANTLE NETWORK (L2)                                 │
│                                                                              │
│  ┌─────────────────┐  ┌──────────────────┐  ┌─────────────────────────────┐ │
│  │ SentinelIdentity │  │  AlphaAuditor    │  │     ActiveSentinel          │ │
│  │ (ERC-8004 NFT)  │  │ (Proof-of-Alpha) │  │ (Flash Arb Engine)          │ │
│  │ Agent Registry   │  │ Event-only Hash  │  │ INIT → MerchantMoe → Agni  │ │
│  └────────┬────────┘  └────────┬─────────┘  └──────────────┬──────────────┘ │
│           │                     │                            │                │
│           │    ┌────────────────┴────────────────┐           │                │
│           └────┤     ReputationRegistry          ├───────────┘                │
│                │  (Batch Oracle, int128 scores)   │                           │
│                └─────────────────────────────────┘                           │
└──────────────────────────────────────────────────────────────────────────────┘
         ▲                    ▲                           ▲
         │ registerAgent      │ commitInsight             │ executeFlashArbitrage
         │                    │                           │
┌────────┴────────────────────┴───────────────────────────┴────────────────────┐
│                         TEE AGENT (Phala DStack CVM)                          │
│                                                                              │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │ NansenClient │  │ClusterEngine  │  │YieldArchitect│  │CircuitBreaker  │ │
│  │ (MCP API)    │→ │(Wallet Groups)│→ │(EIP-712 Sign)│→ │(Safety Halt)   │ │
│  └──────────────┘  └───────────────┘  └──────────────┘  └────────────────┘ │
│         │                                      │                             │
│         │           ┌──────────────────────────┘                             │
│         │           ▼                                                        │
│         │  ┌──────────────────┐                                              │
│         │  │SentinelExecutor  │ ← commitInsight() on-chain (BLOCKING)        │
│         │  └────────┬─────────┘                                              │
│         │           │                                                        │
│         │           ▼                                                        │
│         │  ┌──────────────────┐     ┌─────────────┐                         │
│         │  │ProposalPublisher │────→│ Redis Stream │ (agent_insights)        │
│         │  └──────────────────┘     └──────┬──────┘                         │
│         │                                   │                                │
└─────────┴───────────────────────────────────┼────────────────────────────────┘
                                              │
                                              ▼ XREAD BLOCK
┌─────────────────────────────────────────────────────────────────────────────┐
│                    BFF (Backend-for-Frontend) — Hono, Port 3001              │
│                                                                             │
│  ┌───────────────┐  ┌────────────────────┐  ┌─────────────────────────────┐│
│  │ HMAC Verifier │  │ WebSocket Server   │  │   Reputation Batcher        ││
│  │(timing-safe)  │  │(JWT auth, Redis→WS)│  │(Redis → ReputationRegistry) ││
│  └───────────────┘  └─────────┬──────────┘  └─────────────────────────────┘│
│                                │                                             │
└────────────────────────────────┼─────────────────────────────────────────────┘
                                 │ WebSocket (wss://)
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    FRONTEND PWA (Vite + React + RainbowKit)                  │
│                                                                             │
│  ┌──────────┐ ┌────────────────┐ ┌──────────────┐ ┌─────────────────────┐ │
│  │  SIWE    │ │LiveAgentConsole│ │ProofOfAlpha  │ │ ERC8004Explorer     │ │
│  │  Auth    │ │(Real-time feed)│ │(Hash verify) │ │ (Agent Cards)       │ │
│  └──────────┘ └────────────────┘ └──────────────┘ └─────────────────────┘ │
│  ┌────────────────┐ ┌──────────────┐ ┌────────────────────────────────────┐│
│  │ReputationHeatmap│ │RWARiskPanel  │ │        MEVMetrics                  ││
│  │(Epoch scores)   │ │(Risk levels) │ │(TSTORE vs SSTORE gas comparison)  ││
│  └────────────────┘ └──────────────┘ └────────────────────────────────────┘│
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                     ProposalView (Execute Flash Arbitrage)               ││
│  │       User signs EIP-712 → executeFlashArbitrage() → MNT gas paid       ││
│  └─────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## System Components

### 1. Smart Contracts (Foundry/Solidity 0.8.24)

Located in `contracts/`. Compiled with Foundry (forge), Solc 0.8.24, EVM target: Cancun, optimizer: 200 runs.

#### ActiveSentinel.sol — Core Flash Arbitrage Engine

The heart of the system. Executes atomic flash loan arbitrage:

1. **Flash borrows** token A from INIT Capital (`flashBorrow`)
2. **Swaps** A → B on Merchant Moe (LBRouter)
3. **Swaps** B → A on Agni Finance (UniV3 exactInputSingle)
4. **Repays** flash loan + fee
5. **Keeps** profit (sent to `beneficiary`)

```solidity
function executeFlashArbitrage(ArbParams calldata params, bytes calldata teeSignature) external;

struct ArbParams {
    address tokenBorrow;     // Token to flash borrow
    uint256 borrowAmount;    // Amount to borrow
    address tokenIntermediate; // Intermediate swap token
    address beneficiary;     // Profit recipient
    uint256 minProfit;       // Minimum acceptable profit (slippage protection)
    uint256 deadline;        // Execution deadline (block.timestamp)
    uint256 nonce;           // Replay protection
}
```

**Security Features:**
- **Hybrid Reentrancy Guard** — TSTORE/TLOAD (EIP-1153, 100 gas) + SSTORE fallback (5000 gas). Dual protection against reentrancy in all execution contexts.
- **EIP-712 Signature Verification** — TEE agent signs ArbParams off-chain. Contract verifies on-chain. Only registered TEE signer can authorize trades.
- **Token Whitelist** — `whitelistedTokens` mapping prevents ERC-777 transfer hooks from being exploited.
- **Nonce Replay Protection** — `usedNonces` mapping. Each nonce can only be used once.
- **Context Validation (H-08)** — Flash loan callback verifies `msg.sender == initCore && initiator == address(this)` to prevent direct callback invocation.
- **Deadline Enforcement** — `block.timestamp <= params.deadline` prevents stale executions.

#### SentinelIdentity.sol — ERC-8004 Agent Identity

ERC-721 NFT registry implementing the ERC-8004 Agent Card standard:

```solidity
function registerAgent(string calldata agentCardURI) external returns (uint256 tokenId);
function updateAgentCard(uint256 tokenId, string calldata newURI) external;
```

- One agent per address (soulbound-like, 1:1 mapping)
- Monotonic counter (tokenId starts at 1, 0 = not registered)
- Agent Card URI stores JSON metadata (capabilities, TEE attestation, version)
- Required for AlphaAuditor access (only agent owners can commit insights)

#### AlphaAuditor.sol — Proof-of-Alpha Registry

Gas-optimized event-only hash registry:

```solidity
function commitInsight(uint256 agentId, bytes32 insightHash) external;
event InsightCommitted(uint256 indexed agentId, bytes32 indexed insightHash, uint256 timestamp);
```

- **No storage writes for hash** — only `emit` event (extreme gas optimization)
- **Counter only** — `agentCommitCount[agentId]++` for statistics
- **Ownership check** — Only the owner of the SentinelIdentity NFT can commit
- **Zero-hash protection** — Prevents accidental empty commits

#### ReputationRegistry.sol — On-Chain Reputation Oracle

Batch-updatable reputation system:

```solidity
function batchUpdateScores(uint256[] calldata agentIds, int128[] calldata deltas) external;
function getScore(uint256 agentId) external view returns (int256);
```

- **Oracle-pattern** — BFF aggregates HITL votes from Redis, batches on-chain
- **int128 deltas** — Supports both positive and negative score updates
- **Multi-agent batch** — Single transaction updates multiple agents (gas efficient)

#### DEX Adapters

| Adapter | Protocol | Interface |
|---------|----------|-----------|
| `AgniAdapter.sol` | Agni Finance | UniswapV3 `exactInputSingle` |
| `MerchantMoeAdapter.sol` | Merchant Moe | LBRouter `swapExactTokensForTokens` |

Both implement the unified `IDexRouter` interface:
```solidity
interface IDexRouter {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, bytes calldata extraData) external returns (uint256 amountOut);
}
```

#### Libraries

- **TransientReentrancyGuard.sol** — TSTORE/TLOAD based reentrancy protection (EIP-1153). 98% gas reduction vs traditional SSTORE-based guards (100 gas vs 5000 gas per check).

---

### 2. TEE Agent (Phala DStack CVM)

Located in `agent-tee/`. Runs inside a Trusted Execution Environment (Phala Network Confidential Virtual Machine).

#### Core Architecture

```
main.ts (Entry Point)
    │
    ├── NansenMCPClient → Fetch smart money signals
    │       │
    │       ▼
    ├── ClusteringEngine → Discover related wallets
    │       │
    │       ▼
    ├── YieldArchitect → Generate EIP-712 signed proposal
    │       │
    │       ▼
    ├── SentinelExecutor → commitInsight() on-chain (BLOCKING)
    │       │
    │       ▼
    ├── CircuitBreaker → Validate market conditions
    │       │
    │       ▼
    └── ProposalPublisher → XADD to Redis Stream
```

#### Pipeline Invariant (Critical)

```
generateProposal → commitProofOfAlpha → [CircuitBreaker] → publish
                          │
                    MUST succeed before
                    publish is allowed
```

The on-chain commitment is **BLOCKING** — if the `commitInsight()` transaction fails, the proposal is NEVER published to Redis. This ensures every published proposal has a corresponding on-chain proof.

#### Services

| Service | File | Purpose |
|---------|------|---------|
| **NansenMCPClient** | `nansenClient.ts` | Fetches smart money wallet activity from Nansen MCP API. Filters by chain (Mantle), minimum transaction value, and wallet labels. |
| **ClusteringEngine** | `strategies/clusteringEngine.ts` | Auto-discovers related wallets via transfer heuristics (shared gas sources, coordinated timing, common token interactions). Groups into clusters for signal amplification. |
| **YieldArchitect** | `strategies/yieldArchitect.ts` | Generates flash arbitrage proposals. Computes insightHash via `keccak256(encodePacked([address, string, uint256, uint256]))`. Signs with EIP-712 typed data. |
| **LLMEngine** | `strategies/llmEngine.ts` | GPT-4 reasoning engine. Interprets Nansen signals, scores conviction (0-1), recommends action (FOLLOW/FADE/IGNORE), assesses risk (1-10). |
| **SentinelExecutor** | `executor.ts` | Commits insightHash to AlphaAuditor on-chain. Handles gas estimation, nonce management, and transaction confirmation. |
| **CircuitBreaker** | `services/circuitBreaker.ts` | 3-check safety halt system. See [Circuit Breaker Safety System](#circuit-breaker-safety-system). |
| **ProposalPublisher** | `services/proposalPublisher.ts` | Publishes finalized proposals to Redis Stream `agent_insights` via XADD. |
| **BloomFilter** | `services/bloomFilter.ts` | Probabilistic noise wallet filtering. Configurable false positive rate. |
| **DynamicWatchlist** | `services/dynamicWatchlist.ts` | Redis SMEMBERS-based wallet tracking. Epoch-rate-limited updates. |
| **MEVProtection** | `services/mevProtection.ts` | Private mempool routing, flashbots-style bundle submission. |
| **SessionKeyRotator** | `services/sessionKeyRotator.ts` | ZeroDev session key rotation for Account Abstraction (future AA mode). |
| **RemoteAttestation** | `services/remoteAttestation.ts` | Phala TEE remote attestation proof generation. |
| **RateLimiter** | `services/rateLimiter.ts` | Request rate limiting for external API calls. |
| **TxEnrichment** | `services/txEnrichment.ts` | Transaction metadata enrichment (labels, protocol identification). |

#### Security Model (TEE)

- **Private key generated IN-MEMORY at each boot** — never persisted to disk
- **Only public address is exported** — for SentinelIdentity registration
- **Remote attestation** — Phala DStack provides cryptographic proof of code integrity
- **Sealed thresholds** — CircuitBreaker constants are compiled into the TEE image, immutable at runtime

#### Insight Schema (LLMInsight)

```typescript
interface LLMInsight {
    convictionScore: number;       // 0.0 - 1.0
    reasoning: string;             // Human-readable interpretation
    proposedAction: {
        asset: Address;            // Token contract address
        assetSymbol: string;       // e.g. "WMNT"
        action: "BUY" | "SELL";
        recommendedAmount: string; // Wei amount as string
    };
    nonce: number;                 // Replay protection
    deadline: number;              // Unix timestamp (TTL)
    reasoningHash: Hex;            // keccak256 of reasoning content
    teeSignerAddress: Address;     // TEE agent's ephemeral address
    priceAtGeneration: number;     // Asset price at insight time
    maxSlippagePct: number;        // Maximum acceptable slippage
    generatedAt: number;           // Unix timestamp
    signature: Hex;                // EIP-712 signature
    insightHash: Hex;              // keccak256 commitment hash
    commitTxHash: Hex;             // AlphaAuditor transaction hash
}
```

---

### 3. Backend-for-Frontend (BFF) — Hono

Located in `bff/`. HTTP + WebSocket server bridging TEE agent and frontend.

#### API Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/proposal/:id` | HMAC | Fetch proposal with optimistic lock + staleness check + EIP-712 payload |
| `POST` | `/api/proposal/:id/consume` | HMAC | Burns proposal nullifier (one-time use, prevents double-execution) |
| `POST` | `/api/proposal/:id/simulate` | HMAC | Dry-run eth_call simulation (gas estimation + revert check) |
| `GET` | `/api/health` | None | Redis + RPC connectivity health check |
| `WS` | `/ws` | JWT | Real-time proposal stream (Redis Streams → WebSocket) |

#### WebSocket Server (`wssBroadcaster.ts`)

Architecture:
1. **HTTP Upgrade** — JWT token extracted from `Authorization` header or `?token=` query param
2. **JWT Verification** — `jsonwebtoken.verify(token, HMAC_SECRET)`
3. **Redis XREAD BLOCK** — Dedicated Redis connection blocks on `agent_insights` stream
4. **Broadcast** — Every new stream entry is JSON-parsed and broadcast to all connected clients
5. **Heartbeat** — Ping every 30s, kill zombies (no pong response = terminated)
6. **Graceful shutdown** — Abort XREAD loop, clear interval, close all sockets

#### Services

| Service | Purpose |
|---------|---------|
| `proposalService.ts` | Redis SETNX locking (60s TTL), HMAC-SHA256 verification (timing-safe), nullifier consumption |
| `onChainOracle.ts` | Price staleness check via viem RPC calls, eth_call simulation for dry-runs |
| `reputationBatcher.ts` | Aggregates HITL votes from Redis, batches into ReputationRegistry.batchUpdateScores() |
| `wssBroadcaster.ts` | WebSocket server + Redis Streams consumer (see above) |

#### Middleware Stack

1. **CORS** — Allows origins: Telegram WebView, Vercel frontend, Cloudflare tunnel
2. **HMAC Verification** — Timing-safe comparison of `x-hmac-signature` header vs computed HMAC-SHA256(proposalId, secret)
3. **Rate Limiting** — Per-IP request throttling (implicit via infrastructure)

---

### 4. Frontend PWA (Vite + React)

Located in `frontend/`. Cyberpunk terminal-themed Progressive Web App.

#### Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Build | Vite | 5.4 |
| UI | React | 18.3 |
| Styling | TailwindCSS | 3.4 |
| Web3 | wagmi + viem | 2.14 / 2.21 |
| Wallet | RainbowKit | 2.2 |
| Auth | SIWE (EIP-4361) | 3.0 |
| State | @tanstack/react-query | 5.60 |
| Language | TypeScript | 5.5 |

#### Provider Tree

```
React.StrictMode
  └── WagmiProvider (Mantle mainnet, chainId 5000)
      └── QueryClientProvider (staleTime: 5s, retry: 2)
          └── RainbowKitProvider (darkTheme, accent: #00f3ff)
              └── App (Authentication Gate)
                  └── WebSocketProvider (JWT-gated singleton)
                      └── DashboardLayout (CSS Grid 12-col)
```

#### Authentication Flow (SIWE)

```
1. User connects wallet (MetaMask/Rabby/WalletConnect)
           │
           ▼
2. Construct EIP-4361 message:
   "alphaflow-suite wants you to sign in with your Ethereum account..."
   - Domain, URI, Chain ID (5000), Nonce (from BFF), IssuedAt
           │
           ▼
3. User signs message → signature
           │
           ▼
4. POST /auth/verify { message, signature }
           │
           ▼
5. BFF verifies SIWE → issues JWT (HMAC-SHA256, 24h expiry)
           │
           ▼
6. JWT stored in localStorage("alphaflow_jwt")
           │
           ▼
7. WebSocket connects with JWT → real-time stream begins
```

#### Dashboard Components

**Layout (12-column CSS Grid):**
```
┌────────────────────────────────────────────────┐
│ TopNav (full width) — RainbowKit ConnectButton │
├──────────────────────────────┬─────────────────┤
│ LiveAgentConsole (8 cols)    │ ERC8004Explorer │
│ (Real-time scrolling log)    │ (4 cols)        │
│                              │ Agent Cards     │
├──────────────────────────────┤                 │
│ ProofOfAlpha (8 cols)        │                 │
│ (On-chain hash verification) │                 │
├──────────────────────────────┼─────────────────┤
│ ReputationHeatmap (8 cols)   │ RWARiskPanel    │
│ (8x3 epoch score grid)      │ (4 cols)        │
│                              ├─────────────────┤
│                              │ MEVMetrics      │
│                              │ (4 cols)        │
└──────────────────────────────┴─────────────────┘
```

| Component | Description |
|-----------|-------------|
| **TopNav** | Header with "AlphaFlow" branding + RainbowKit ConnectButton (shows balance, chain, address) |
| **LiveAgentConsole** | Real-time scrolling terminal feed. Displays timestamped insights from WebSocket, color-coded by type: ALERT=magenta, ARBITRAGE=green, SIGNAL=cyan. Keeps last 100 entries. Auto-scrolls to bottom. |
| **ProofOfAlpha** | Trustless on-chain verification widget. Computes local keccak256 of displayed insight, queries AlphaAuditor event logs, compares hashes. Status: `HARDWARE VERIFIED` / `UNVERIFIED` / `VERIFYING` / `AUDITOR N/A` |
| **ERC8004Explorer** | Agent identity card browser. Displays registered agents from SentinelIdentity, their metadata URIs, commit counts, and reputation scores. |
| **ReputationHeatmap** | 8x3 grid visualization of agent reputation scores across epochs. Color intensity represents score magnitude. |
| **RWARiskPanel** | Real-time risk indicators with progress bars: Liquidity Risk, Slippage Risk, MEV Exposure, Oracle Deviation. Each rated LOW/MED/HIGH with color coding. |
| **MEVMetrics** | Gas efficiency comparison: Traditional reentrancy guard (5000 gas) vs AlphaFlow EIP-1153 TSTORE (100 gas) = **98% reduction**. Shows private mempool routing status. |
| **ProposalView** | Trade execution interface. Displays proposal details, user signs EIP-712 typed data, calls `executeFlashArbitrage()`. Links to MantleScan for confirmation. |

#### WebSocket Provider

```typescript
// Singleton connection with exponential backoff
interface WebSocketContextValue {
    isConnected: boolean;
    latestInsight: AgentInsight | null;
    reconnectAttempt: number;
    reconnect: () => void;
}

// Reconnection: 1s → 2s → 4s → 8s → 16s (max 5 attempts)
// Insight types: ARBITRAGE | SIGNAL | ALERT | HEARTBEAT
```

#### Styling Theme (Cyberpunk Terminal)

```javascript
// tailwind.config.js
colors: {
    bgDark: '#0D0D0D',      // Near-black background
    neonCyan: '#00f3ff',     // Primary accent (borders, text)
    neonMagenta: '#ff003c',  // Alert/error accent
    terminalGreen: '#00ff41' // Success/active indicator
}
// Font: Fira Code (monospace)
// CRT scanline overlay: 4px animated gradient line, 4s sweep cycle
// Panels: backdrop-blur with neonCyan border glow
```

---

## Data Flow & Pipeline

### Complete Transaction Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        FULL E2E PIPELINE                                     │
│                                                                             │
│  1. SIGNAL DETECTION                                                        │
│     NansenMCP → Smart Money wallet activity on Mantle                       │
│     ClusteringEngine → Discovers 3 related wallets (transfer heuristics)    │
│                                                                             │
│  2. INSIGHT GENERATION                                                      │
│     LLMEngine (GPT-4) → Interprets cluster activity                        │
│     Output: { confidence: 0.87, action: "BUY", asset: "WMNT" }             │
│                                                                             │
│  3. HASH COMPUTATION                                                        │
│     insightHash = keccak256(encodePacked(asset, action, amount, timestamp)) │
│     reasoningHash = keccak256(encodePacked(interpretation, confidence, ...)) │
│                                                                             │
│  4. ON-CHAIN COMMITMENT (BLOCKING)                                          │
│     AlphaAuditor.commitInsight(agentId=1, insightHash)                      │
│     → Event: InsightCommitted(1, insightHash, block.timestamp)              │
│     → agentCommitCount[1]++                                                 │
│                                                                             │
│  5. CIRCUIT BREAKER VALIDATION                                              │
│     ✓ Slippage < 3%                                                        │
│     ✓ Gas < 1.5x median                                                    │
│     ✓ Oracle deviation < 2%                                                │
│                                                                             │
│  6. REDIS PUBLISH                                                           │
│     XADD agent_insights * payload {JSON LLMInsight}                         │
│                                                                             │
│  7. BFF BROADCAST                                                           │
│     XREAD BLOCK → parse → broadcast to all WebSocket clients                │
│                                                                             │
│  8. FRONTEND DISPLAY                                                        │
│     LiveAgentConsole shows insight in real-time                              │
│     ProofOfAlpha verifies local hash vs AlphaAuditor event logs             │
│     Status: HARDWARE VERIFIED ✓                                             │
│                                                                             │
│  9. USER EXECUTION (Optional)                                               │
│     User clicks "Execute" → signs EIP-712 → ActiveSentinel tx              │
│     → Flash borrow → swap → swap → repay → profit                          │
│                                                                             │
│ 10. REPUTATION UPDATE                                                       │
│     BFF aggregates outcome → ReputationRegistry.batchUpdateScores()         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Redis Streams Schema

```
Stream: agent_insights
Entry: { payload: JSON string }

Payload fields:
- convictionScore (number)
- reasoning (string)
- proposedAction.asset (address)
- proposedAction.assetSymbol (string)
- proposedAction.action ("BUY" | "SELL")
- proposedAction.recommendedAmount (string, wei)
- nonce (number)
- deadline (number, unix timestamp)
- reasoningHash (hex)
- teeSignerAddress (address)
- priceAtGeneration (number)
- maxSlippagePct (number)
- generatedAt (number, unix timestamp)
- signature (hex, EIP-712)
- insightHash (hex, keccak256)
- commitTxHash (hex, AlphaAuditor tx)
```

---

## Security Model

| Layer | Mechanism | Description |
|-------|-----------|-------------|
| **Smart Contract** | Hybrid Reentrancy Guard | TSTORE (EIP-1153) + SSTORE dual-layer protection |
| **Smart Contract** | EIP-712 Signatures | Only registered TEE signer can authorize flash arb |
| **Smart Contract** | Token Whitelist | Prevents ERC-777 transfer hook exploits |
| **Smart Contract** | Nonce Replay Protection | Each nonce used exactly once |
| **Smart Contract** | Flash Loan Context (H-08) | Validates msg.sender == INIT Core + initiator == self |
| **Smart Contract** | Deadline Enforcement | Prevents stale transaction execution |
| **TEE Agent** | Phala DStack CVM | Code runs in hardware-isolated enclave |
| **TEE Agent** | Ephemeral Keys | Private key generated in-memory, never persisted |
| **TEE Agent** | Remote Attestation | Cryptographic proof of code integrity |
| **TEE Agent** | Circuit Breaker | 3-check safety halt (slippage, gas, oracle) |
| **TEE Agent** | Sealed Thresholds | Constants compiled into TEE image, immutable |
| **BFF** | HMAC-SHA256 | Timing-safe verification of all proposal endpoints |
| **BFF** | JWT (HS256) | WebSocket authentication token (24h expiry) |
| **BFF** | Optimistic Locking | Redis SETNX prevents concurrent proposal access |
| **BFF** | Nullifier Pattern | One-time proposal consumption (prevents double-spend) |
| **Frontend** | SIWE (EIP-4361) | Sign-In With Ethereum — wallet-based authentication |
| **Frontend** | EOA User-Pays | User explicitly signs and pays gas (no custodial risk) |
| **Frontend** | No Secrets | Frontend holds zero private keys or API secrets |
| **Infrastructure** | Redis AUTH | Password-protected Redis with AOF persistence |
| **Infrastructure** | CORS Whitelist | Restricted to known frontend origins |

---

## Deployment Architecture

### Docker Compose (Development/Staging)

```yaml
services:
  redis:        # Redis 7 Alpine, AOF persistence, 512MB maxmemory, password auth
  bff:          # Hono server, port 3001, depends on redis
  agent-tee-dev: # TEE agent (dev profile), port 8080
  anvil:        # Mantle fork for testing (test profile), port 8545
```

### Production Deployment

| Component | Platform | Details |
|-----------|----------|---------|
| Smart Contracts | Mantle Mainnet | Deployed via Foundry `forge script` |
| TEE Agent | Phala Network | DStack CVM (Confidential VM) |
| BFF | GCP Compute | Instance `instance-20260330-115005` (IP: 146.148.57.175) |
| Frontend | Vercel | SPA with security headers + cache |
| Redis | GCP (same instance) | Redis 7, localhost:6379 |

### Frontend Deployment (Vercel)

```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }],
  "headers": [{
    "source": "/(.*)",
    "headers": [
      { "key": "X-Frame-Options", "value": "DENY" },
      { "key": "X-Content-Type-Options", "value": "nosniff" },
      { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" }
    ]
  }]
}
```

---

## On-Chain Contracts (Mantle Mainnet)

| Contract | Address | Verified |
|----------|---------|----------|
| **SentinelIdentity** | `0xC4499035f68737c3d8a917A92bbFe043F4Ed10CC` | ✓ MantleScan |
| **AlphaAuditor** | `0xbF073B94a020626258626918d82bce05DC5E2aE0` | ✓ MantleScan |
| **ActiveSentinel** | `0xfC7069a9f7B6C4c0a5704b28FEF3e2E47e0017A8` | ✓ MantleScan |

### Protocol Addresses (Mantle Mainnet)

| Protocol | Contract | Address |
|----------|----------|---------|
| INIT Capital | Core | `0x972bCB...` |
| Merchant Moe | LBRouter | `0xeaEE7E...` |
| Agni Finance | SwapRouter | `0x319B69...` |
| WMNT | Wrapped MNT | `0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8` |

### Deployment Script (`DeployMainnet.s.sol`)

Deployment order:
1. Deploy `SentinelIdentity`
2. Deploy `AlphaAuditor(sentinelIdentityAddress)`
3. Call `sentinelIdentity.registerAgent(agentCardURI)` → tokenId = 1
4. Deploy `ActiveSentinel(initCore, dexRouterA, dexRouterB, sentinelIdentity)`
5. Call `activeSentinel.setIdentityRegistry(sentinelIdentityAddress)`
6. Call `activeSentinel.setTeeAgent(teeAgentAddress)`
7. Batch whitelist tokens (WMNT, USDC, USDT, WETH)

---

## E2E Qualification Test Results

**Executed: 2026-06-04T19:15:06Z (Mantle Mainnet)**

```
╔═══════════════════════════════════════════════════════════════════╗
║          E2E QUALIFICATION TEST — FINAL REPORT                   ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                   ║
║  ✓ Step 1: Insight Generated (WMNT BUY, confidence=0.87)         ║
║  ✓ Step 2: keccak256 Hash Computed (Proof-of-Alpha)              ║
║  ✓ Step 3: Circuit Breaker PASSED (slip/gas/oracle OK)           ║
║  ✓ Step 4: commitInsight() TX Confirmed on Mantle Mainnet        ║
║  ✓ Step 5: InsightCommitted Event Verified in Logs               ║
║  ✓ Step 6: Proposal Published to Redis Stream                    ║
║  ✓ Step 7: Redis Entry Integrity Verified                        ║
║                                                                   ║
║  PROOF-OF-ALPHA STATUS: ████ HARDWARE VERIFIED ████              ║
║                                                                   ║
╠═══════════════════════════════════════════════════════════════════╣
║  Duration:     6.8s                                               ║
║  Gas Spent:    0.0033 MNT (~$0.002)                               ║
║  Block:        96235097                                           ║
║  TX Hash:      0xedcfc7a7b1412efde2cfde1f29eef2bca6d37fe667f...  ║
║  insightHash:  0x65c21abbdbacfb6ae1d9e90cd9f461ccf818e992d610...  ║
║                                                                   ║
║  MantleScan: https://mantlescan.xyz/tx/0xedcfc7a7b1412efde2cf... ║
╚═══════════════════════════════════════════════════════════════════╝
```

**Verification Links:**
- Transaction: https://mantlescan.xyz/tx/0xedcfc7a7b1412efde2cfde1f29eef2bca6d37fe667f20dc77f00dd299ee44a08
- AlphaAuditor Contract: https://mantlescan.xyz/address/0xbF073B94a020626258626918d82bce05DC5E2aE0
- SentinelIdentity: https://mantlescan.xyz/address/0xC4499035f68737c3d8a917A92bbFe043F4Ed10CC
- ActiveSentinel: https://mantlescan.xyz/address/0xfC7069a9f7B6C4c0a5704b28FEF3e2E47e0017A8

---

## Configuration & Environment

### BFF Environment (`.env`)

```bash
PORT=3001
NODE_ENV=production
REDIS_URL=redis://localhost:6379
HMAC_SECRET=<shared-with-agent>              # HMAC-SHA256 signing key
ALLOWED_ORIGINS=https://t.me,...             # CORS whitelist
MANTLE_RPC_PRIMARY=https://rpc.mantle.xyz
MANTLE_RPC_FALLBACK_1=https://mantle-mainnet.public.blastapi.io
```

### Agent TEE Environment

```bash
DEPLOYER_PRIVATE_KEY=0x...                   # TEE ephemeral signer (in-memory in prod)
NANSEN_API_KEY=<key>                         # Nansen MCP access
OPENAI_API_KEY=<key>                         # GPT-4 reasoning
REDIS_URL=redis://localhost:6379
MANTLE_RPC=https://rpc.mantle.xyz
HMAC_SECRET=<shared-with-bff>
```

### Frontend Environment (`.env`)

```bash
VITE_BFF_WSS_URL=wss://your-bff-domain/ws
VITE_BFF_HTTP_URL=https://your-bff-domain
VITE_WC_PROJECT_ID=9add069a8830633afa75d8e490c3f246  # WalletConnect (Reown)
```

### Foundry Configuration (`foundry.toml`)

```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc_version = "0.8.24"
evm_version = "cancun"
optimizer = true
optimizer_runs = 200

[fuzz]
runs = 1000

[invariant]
runs = 256
depth = 50

[rpc_endpoints]
mantle_mainnet = "https://rpc.mantle.xyz"
mantle_fork = "http://localhost:8545"

[etherscan]
mantle = { key = "${MANTLESCAN_API_KEY}", url = "https://api.mantlescan.xyz/api" }
```

---

## Directory Structure

```
alphaflow-suite/
├── .github/
│   └── workflows/
│       └── ci.yml                    # CI: forge test + vitest + docker + integration
├── contracts/                        # Foundry project
│   ├── foundry.toml
│   ├── remappings.txt
│   ├── src/
│   │   ├── ActiveSentinel.sol        # Core flash arb engine (371 lines)
│   │   ├── AlphaAuditor.sol          # Proof-of-Alpha registry (90 lines)
│   │   ├── SentinelIdentity.sol      # ERC-8004 identity (118 lines)
│   │   ├── ReputationRegistry.sol    # Reputation oracle
│   │   ├── adapters/
│   │   │   ├── AgniAdapter.sol       # Agni Finance (UniV3)
│   │   │   └── MerchantMoeAdapter.sol # Merchant Moe (LBRouter)
│   │   ├── erc8004/
│   │   │   ├── IdentityRegistry.sol
│   │   │   └── ValidationRegistry.sol
│   │   ├── interfaces/
│   │   │   ├── IDexRouter.sol
│   │   │   ├── IFlashBorrower.sol
│   │   │   └── IINITCore.sol
│   │   └── libraries/
│   │       └── TransientReentrancyGuard.sol
│   ├── script/
│   │   ├── Deploy.s.sol              # Local/testnet deployment
│   │   └── DeployMainnet.s.sol       # Mantle mainnet deployment
│   ├── test/
│   │   ├── ActiveSentinel.t.sol      # Core tests
│   │   ├── ActiveSentinelSecurity.t.sol # Security-focused tests
│   │   ├── DexAdapters.t.sol         # Adapter tests
│   │   └── SentinelModule1.t.sol     # Module tests
│   ├── broadcast/                    # Deployment artifacts (tx receipts)
│   ├── out/                          # Compiled ABIs + bytecode
│   └── lib/                          # forge-std, openzeppelin-contracts
├── bff/                              # Backend-for-Frontend
│   ├── package.json                  # alphaflow-bff@1.0.0
│   ├── tsconfig.json
│   ├── Dockerfile
│   ├── .env
│   └── src/
│       ├── index.ts                  # Hono app + routes (443 lines)
│       ├── services/
│       │   ├── onChainOracle.ts      # Price staleness + simulation
│       │   ├── proposalService.ts    # Redis locking + HMAC
│       │   ├── reputationBatcher.ts  # Batch on-chain reputation updates
│       │   └── wssBroadcaster.ts     # WebSocket + Redis Streams (325 lines)
│       └── test/
│           └── api.test.ts
├── frontend/                         # PWA (alphaflow-pwa@2.0.0)
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   ├── tsconfig.json
│   ├── vercel.json
│   ├── index.html
│   └── src/
│       ├── main.tsx                  # Provider tree entry
│       ├── App.tsx                   # Auth gate + layout (88 lines)
│       ├── config/
│       │   └── wagmi.ts             # RainbowKit + Mantle config
│       ├── providers/
│       │   └── WebSocketProvider.tsx # Singleton WS with backoff
│       ├── hooks/
│       │   └── useAuthJWT.ts        # SIWE auth hook
│       ├── components/
│       │   ├── DashboardLayout.tsx   # CSS Grid 12-col
│       │   ├── TopNav.tsx           # Header + ConnectButton
│       │   ├── LiveAgentConsole.tsx  # Real-time insight feed
│       │   ├── ProofOfAlpha.tsx     # On-chain hash verification
│       │   ├── ERC8004Explorer.tsx  # Agent card browser
│       │   ├── ReputationHeatmap.tsx # Epoch score visualization
│       │   ├── RWARiskPanel.tsx     # Risk indicators
│       │   ├── MEVMetrics.tsx       # Gas efficiency metrics
│       │   └── ProposalView.tsx     # Trade execution UI
│       ├── utils/
│       │   └── bffClient.ts        # BFF API client
│       └── styles/
│           └── index.css            # Tailwind + CRT scanline
├── agent-tee/                        # TEE Agent
│   ├── package.json                  # alphaflow-agent-tee@1.0.0
│   ├── tsconfig.json
│   ├── Dockerfile
│   ├── scripts/
│   │   └── generateAgentCard.ts     # ERC-8004 metadata generator
│   └── src/
│       ├── main.ts                  # Entry + polling loop (637 lines)
│       ├── executor.ts              # On-chain commit executor
│       ├── types/
│       │   └── index.ts            # Shared type definitions
│       ├── config/
│       │   └── rwaRegistry.ts      # RWA asset registry
│       ├── services/
│       │   ├── bloomFilter.ts      # Noise wallet filtering
│       │   ├── byrealClient.ts     # Byreal CLMM aggregator
│       │   ├── circuitBreaker.ts   # Safety halt (396 lines)
│       │   ├── dynamicWatchlist.ts  # Redis wallet tracking
│       │   ├── mevProtection.ts    # Private mempool routing
│       │   ├── nansenClient.ts     # Nansen MCP API
│       │   ├── proposalPublisher.ts # Redis Streams XADD
│       │   ├── rateLimiter.ts      # API rate limiting
│       │   ├── remoteAttestation.ts # TEE attestation
│       │   ├── sessionKeyRotator.ts # ZeroDev key rotation
│       │   └── txEnrichment.ts     # Tx metadata enrichment
│       ├── strategies/
│       │   ├── clusteringEngine.ts # Wallet cluster discovery
│       │   ├── llmEngine.ts        # GPT-4 reasoning
│       │   └── yieldArchitect.ts   # Proposal + EIP-712 signing
│       └── test/
│           ├── circuitBreaker.test.ts
│           ├── e2e-mainnet.ts       # Mainnet qualification test
│           └── yieldArchitect.test.ts
├── tests/
│   └── e2e-pipeline.test.ts         # Integration test (Anvil fork)
├── docs/
│   ├── ARCHITECTURE.md
│   ├── PROJECT_DETAILS.md
│   └── PROJECT_OVERVIEW.md
├── docker-compose.yml
├── README.md
├── PROJECT.md
├── CONCEPT.md
├── ARCHITECTURE.md
└── FULL_PROJECT_DESCRIPTION.md       # ← This file
```

---

## Build & Run

### Prerequisites

- Node.js 20+
- pnpm or npm
- Foundry (forge, cast, anvil)
- Redis 7+
- Docker + Docker Compose (optional)

### Quick Start (Docker Compose)

```bash
# Clone and enter project
git clone https://github.com/rocknrolla77/alphaflow-suite.git
cd alphaflow-suite

# Copy env files
cp .env.example .env
cp bff/.env.example bff/.env
# Edit .env files with your keys

# Start all services
docker compose up -d

# Verify
curl http://localhost:3001/api/health
```

### Manual Start

```bash
# 1. Start Redis
redis-server --daemonize yes

# 2. Build & deploy contracts (local fork)
cd contracts
forge build
anvil --fork-url https://rpc.mantle.xyz &
forge script script/Deploy.s.sol --rpc-url http://localhost:8545 --broadcast

# 3. Start BFF
cd ../bff
npm install
npm run dev  # tsx watch src/index.ts

# 4. Start Frontend
cd ../frontend
npm install
npm run dev  # vite, port 5173

# 5. Start TEE Agent (dev mode)
cd ../agent-tee
npm install
npm run dev  # tsx src/main.ts
```

### Build for Production

```bash
# Contracts
cd contracts && forge build --optimize

# BFF
cd bff && npm run build  # tsc → dist/

# Frontend
cd frontend && npm run build  # vite build → dist/

# Agent
cd agent-tee && npm run build  # tsc → dist/
```

---

## Testing Strategy

### Smart Contracts (Foundry)

```bash
cd contracts

# Unit tests
forge test -vvv

# Fuzz tests (1000 runs)
forge test --match-test "testFuzz" -vvv

# Invariant tests (256 runs, depth 50)
forge test --match-test "invariant" -vvv

# Security-focused tests
forge test --match-path "test/ActiveSentinelSecurity.t.sol" -vvv

# Gas report
forge test --gas-report

# Coverage
forge coverage
```

**Test Files:**
- `ActiveSentinel.t.sol` — Core flash arb logic, success paths
- `ActiveSentinelSecurity.t.sol` — Reentrancy, replay, authorization, deadlines
- `DexAdapters.t.sol` — Adapter swap correctness
- `SentinelModule1.t.sol` — Identity + Auditor integration

### TypeScript (Vitest)

```bash
# BFF tests
cd bff && npm test

# Agent tests
cd agent-tee && npm test

# Integration E2E (requires Redis + Anvil fork)
cd tests && npx tsx e2e-pipeline.test.ts
```

### Mainnet E2E Qualification

```bash
cd agent-tee
DEPLOYER_PRIVATE_KEY=0x... npx tsx src/test/e2e-mainnet.ts
```

### CI Pipeline (`.github/workflows/ci.yml`)

Jobs:
1. **contracts** — `forge test` (all Solidity tests)
2. **typescript** — `vitest` (BFF + Agent unit tests)
3. **docker** — Build all Dockerfiles
4. **integration** — Anvil fork + deploy + full E2E pipeline

---

## Protocol Integrations

### INIT Capital (Flash Loans)

- **Interface**: `IINITCore.flashBorrow(token, amount, data)`
- **Callback**: `onFlashBorrow(initiator, token, amount, fee, data)`
- **Fee**: Variable (currently ~0.05%)
- **Usage**: Borrow token A → swap across DEXes → repay + fee

### Merchant Moe (DEX — LBRouter)

- **Type**: Liquidity Book (concentrated liquidity, bin-based)
- **Interface**: `LBRouter.swapExactTokensForTokens(amountIn, minOut, path, to, deadline)`
- **Usage**: First swap in arb route (A → B)
- **Adapter**: `MerchantMoeAdapter.sol`

### Agni Finance (DEX — UniV3 Fork)

- **Type**: Concentrated Liquidity (tick-based, UniswapV3 clone)
- **Interface**: `SwapRouter.exactInputSingle(params)`
- **Usage**: Second swap in arb route (B → A)
- **Adapter**: `AgniAdapter.sol`

### Nansen MCP (Smart Money Signals)

- **API**: Nansen Model Context Protocol
- **Signals**: Wallet labels, transaction volumes, token flows
- **Usage**: Identify smart money activity on Mantle for arb opportunity detection

### ZeroDev (Account Abstraction — Future)

- **SDK**: @zerodev/sdk v5.5
- **Kernel**: v3.1 (ERC-4337 Smart Account)
- **Validator**: Passkey (WebAuthn)
- **Session Keys**: Scoped permissions for TEE agent
- **Status**: Integrated in agent-tee, not active in current User-Pays mode

### Phala Network (TEE)

- **Platform**: DStack CVM (Confidential Virtual Machine)
- **Attestation**: Remote attestation via Intel SGX / TDX
- **Security**: Code integrity proof, sealed execution environment
- **Key Management**: Ephemeral keys generated in-enclave

---

## ERC-8004 Agent Identity Standard

AlphaFlow implements the **ERC-8004 Agent Card** standard for AI agent identity:

### Concept

Each autonomous agent is represented by a unique on-chain NFT (ERC-721) containing:
- **Agent Card URI** — JSON metadata describing capabilities, version, TEE attestation
- **Soulbound-like binding** — 1 address = 1 agent (non-transferable identity)
- **On-chain history** — Commit count, reputation score linked to tokenId

### Implementation (`SentinelIdentity.sol`)

```solidity
// Registration
function registerAgent(string calldata agentCardURI) external returns (uint256 tokenId);

// Identity lookup
function agentOf(address owner) external view returns (uint256 tokenId);

// Metadata update
function updateAgentCard(uint256 tokenId, string calldata newURI) external;
```

### Agent Card Metadata Schema

```json
{
    "name": "AlphaFlow Sentinel Agent #1",
    "description": "TEE-secured flash arbitrage agent on Mantle Network",
    "version": "1.0.0",
    "capabilities": ["flash_arbitrage", "smart_money_analysis", "proof_of_alpha"],
    "tee_platform": "phala_dstack",
    "attestation_hash": "0x...",
    "created_at": 1780000000,
    "chain_id": 5000
}
```

---

## Circuit Breaker Safety System

The CircuitBreaker is an **off-chain safety module** running inside the TEE that prevents dangerous proposals from being published.

### Three Hardcoded Checks

| Check | Threshold | Description |
|-------|-----------|-------------|
| **Slippage** | ≤ 3.0% | Maximum estimated trade slippage |
| **Gas Spike** | ≤ 1.5x median | Current gas vs 20-block rolling median |
| **Oracle Deviation** | ≤ 2.0% | Oracle price vs DEX spot price divergence |

### Architecture

```typescript
class CircuitBreaker {
    // Thresholds sealed in TEE image (immutable at runtime)
    private readonly MAX_SLIPPAGE = 0.03;
    private readonly MAX_GAS_MULTIPLIER = 1.5;
    private readonly MAX_ORACLE_DEVIATION = 0.02;

    // Rolling state
    private gasHistory: bigint[] = [];  // Last 20 blocks
    private lastHaltTime: number = 0;
    private readonly COOLDOWN_MS = 60_000;  // 60s cooldown after halt

    async validateMarketConditions(params: MarketParams): Promise<CBResult>;
}
```

### Failure Modes

- **CriticalHaltError** — Thrown when any check fails. Aborts the entire pipeline.
- **Cooldown** — After a halt, 60 seconds must pass before new proposals are allowed.
- **Logging** — All checks logged with values for post-mortem analysis.

### Gas Spike Detection Algorithm

```
1. Fetch baseFeePerGas from latest Mantle block
2. Maintain rolling buffer of last 20 gas prices
3. Compute median of buffer
4. multiplier = currentGas / medianGas
5. If multiplier > 1.5 → HALT (network congestion detected)
```

---

## Proof-of-Alpha Mechanism

### Concept

Every AI-generated insight is **cryptographically committed on-chain BEFORE** it is published or acted upon. This creates an immutable, timestamped proof that the agent generated the insight at a specific time.

### Hash Computation

```typescript
// Insight Hash (identifies the trade proposal)
insightHash = keccak256(
    encodePacked(
        ["address", "string", "uint256", "uint256"],
        [asset, action, amount, timestamp]
    )
);

// Reasoning Hash (identifies the reasoning content)
reasoningHash = keccak256(
    encodePacked(
        ["string", "uint8", "string", "uint8"],
        [interpretation, confidence*100, rationale, riskScore]
    )
);
```

### On-Chain Commitment

```solidity
// AlphaAuditor.sol
function commitInsight(uint256 agentId, bytes32 insightHash) external {
    require(identityRegistry.ownerOf(agentId) == msg.sender);
    require(insightHash != bytes32(0));
    agentCommitCount[agentId]++;
    emit InsightCommitted(agentId, insightHash, block.timestamp);
}
```

### Frontend Verification

The `ProofOfAlpha` component performs client-side verification:

1. Receives insight from WebSocket
2. Locally computes `keccak256(encodePacked(...))` from insight data
3. Queries AlphaAuditor contract for `InsightCommitted` events matching the hash
4. Compares local hash vs on-chain event hash
5. Displays status: **HARDWARE VERIFIED** (match) or **UNVERIFIED** (no match)

### Why This Matters

- **Prevents frontrunning** — Hash committed before anyone else sees the insight
- **Proves timing** — Block timestamp proves when the insight was generated
- **Auditable** — Full history recoverable from event logs (no storage cost)
- **Trustless** — Anyone can verify without trusting the agent
- **TEE-backed** — Insight generated in hardware enclave, committed immediately

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Event-only hash storage** | Gas optimization: emit is 375 gas vs SSTORE 20000 gas. Full history recoverable from logs. |
| **TSTORE reentrancy guard** | EIP-1153 transient storage: 100 gas per check vs 5000 gas for SSTORE. 98% gas reduction. |
| **Ephemeral TEE keys** | Zero persistence = zero extraction surface. Key lives only in enclave RAM. |
| **BLOCKING commit before publish** | Guarantees every published proposal has on-chain proof. No orphan proposals. |
| **User-Pays (EOA) over AA** | Simpler UX for hackathon demo. ZeroDev infrastructure integrated for future paymaster flow. |
| **Redis Streams over Pub/Sub** | Persistence, replay capability, consumer groups. Message not lost on disconnect. |
| **HMAC over API keys** | Timing-safe verification prevents timing attacks. Shared secret between TEE and BFF. |
| **Optimistic locking (SETNX)** | Prevents race conditions without distributed locks. 60s TTL auto-releases dead locks. |
| **CRT scanline overlay** | Pure CSS animation. Zero JS overhead. Brand differentiation (cyberpunk aesthetic). |

---

## Future Roadmap

- [ ] **Account Abstraction (ZeroDev Paymaster)** — Gasless UX via session keys
- [ ] **Formal Verification** — Certora/Halmos for ActiveSentinel invariants
- [ ] **Multi-Agent Swarm** — Multiple TEE agents with reputation-weighted voting
- [ ] **Subgraph Indexer** — TheGraph indexing for InsightCommitted events
- [ ] **Mobile App** — React Native with WalletConnect v2
- [ ] **Cross-Chain** — Expand to Arbitrum, Optimism via LayerZero messaging
- [ ] **MEV Protection** — Flashbots Protect integration for execution phase

---

## License

MIT

---

## Links

- **Repository**: https://github.com/rocknrolla77/alphaflow-suite
- **MantleScan (AlphaAuditor)**: https://mantlescan.xyz/address/0xbF073B94a020626258626918d82bce05DC5E2aE0
- **MantleScan (ActiveSentinel)**: https://mantlescan.xyz/address/0xfC7069a9f7B6C4c0a5704b28FEF3e2E47e0017A8
- **MantleScan (SentinelIdentity)**: https://mantlescan.xyz/address/0xC4499035f68737c3d8a917A92bbFe043F4Ed10CC
- **Proof-of-Alpha TX**: https://mantlescan.xyz/tx/0xedcfc7a7b1412efde2cfde1f29eef2bca6d37fe667f20dc77f00dd299ee44a08
- **WalletConnect Dashboard**: https://dashboard.reown.com
- **Phala Network**: https://phala.network
- **INIT Capital**: https://init.capital
- **Merchant Moe**: https://merchantmoe.com
- **Agni Finance**: https://agni.finance
