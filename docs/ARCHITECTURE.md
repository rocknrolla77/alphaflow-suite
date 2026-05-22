# AlphaFlow Suite — Detailed Architecture Document

> **Version:** 2.0 (Phase 2 — Proof-of-Alpha)  
> **Last Updated:** 2025-05-22  
> **Status:** Active Development (Modules 1-5 complete, Phase 2 in progress)  
> **Network:** Mantle L2 (Chain ID: 5000)  
> **Winner:** DoraHacks Mantle Hackathon

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Architecture Diagram](#architecture-diagram)
3. [Monorepo Structure](#monorepo-structure)
4. [Smart Contracts (`contracts/`)](#smart-contracts)
5. [TEE Agent (`agent-tee/`)](#tee-agent)
6. [Backend-for-Frontend (`bff/`)](#backend-for-frontend)
7. [Telegram Bot (`devops/src/tg-bot/`)](#telegram-bot)
8. [Frontend TMA (`frontend/`)](#frontend-tma)
9. [Security Model](#security-model)
10. [Data Flow & Pipeline Invariant](#data-flow--pipeline-invariant)
11. [Deployment & Infrastructure](#deployment--infrastructure)
12. [Environment Variables Reference](#environment-variables-reference)
13. [Development Roadmap](#development-roadmap)

---

## Project Overview

**AlphaFlow Suite** is a fully autonomous flash arbitrage system operating on Mantle Network. It leverages:

- **TEE (Trusted Execution Environment)** via Phala Network DStack CVM for tamper-proof strategy execution
- **ZeroDev Account Abstraction** (Kernel v3.1, Session Keys, Passkeys) for gasless UX
- **Smart Money Signals** from Nansen MCP for alpha discovery
- **EIP-712 Typed Signatures** for proposal authenticity verification
- **Proof-of-Alpha (Phase 2)** — on-chain commitment of insight hashes before public disclosure

The system detects arbitrage opportunities across INIT Capital (flash loans), Merchant Moe (DEX), and Agni Finance (DEX) on Mantle, generates risk-adjusted proposals in a TEE, commits proof on-chain, and delivers signals to users via Telegram Mini App.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         AlphaFlow Suite Architecture                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐     ┌──────────────────────────────────────────────────┐  │
│  │ Nansen MCP  │────▶│            TEE Agent (Phala DStack CVM)           │  │
│  │ Smart Money │     │                                                    │  │
│  │  Signals    │     │  ┌──────────────┐  ┌─────────────────────────┐    │  │
│  └─────────────┘     │  │YieldArchitect│  │   SentinelExecutor      │    │  │
│                       │  │  - Risk Calc │  │   - Flash Arb (AA)      │    │  │
│                       │  │  - EIP-712   │  │   - ProofOfAlpha Commit │    │  │
│                       │  │  - Hashing   │  │   - Rate Limiting       │    │  │
│                       │  └──────┬───────┘  └──────────┬──────────────┘    │  │
│                       │         │                      │                    │  │
│                       │         ▼                      ▼                    │  │
│                       │  ┌──────────────────────────────────────────┐      │  │
│                       │  │         ProposalPipeline (main.ts)       │      │  │
│                       │  │  1. Generate → 2. Commit → 3. Publish   │      │  │
│                       │  └──────────────────────┬───────────────────┘      │  │
│                       └──────────────────────────┼────────────────────────┘  │
│                                                  │                           │
│                                                  ▼                           │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                         Redis Pub/Sub                                 │   │
│  │  Channels: tee_proposals, proposal_status                             │   │
│  │  Keys: proposal:{id}, proposal:{id}:status, proposal_lock:{id},      │   │
│  │        nullifier:{hash}                                               │   │
│  └────────────────┬─────────────────────────────────────┬────────────────┘   │
│                   │                                     │                    │
│                   ▼                                     ▼                    │
│  ┌────────────────────────┐              ┌────────────────────────────┐     │
│  │   Telegram Bot (HITL)  │              │      BFF (Hono + Node)     │     │
│  │  - /status, /pause     │              │  - HMAC verification       │     │
│  │  - Proposal formatting │              │  - Optimistic locking      │     │
│  │  - User notifications  │              │  - Staleness check         │     │
│  │  - Whitelist guard     │              │  - Nullifier burn          │     │
│  └────────────┬───────────┘              └──────────────┬─────────────┘     │
│               │                                         │                    │
│               ▼                                         ▼                    │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │              Frontend TMA (React 18 + Vite 5)                      │     │
│  │  - ZeroDev SDK v5.5 (Kernel v3.1, Passkeys)                       │     │
│  │  - WebAuthn passkey creation/validation                            │     │
│  │  - Session Key management                                          │     │
│  │  - Proposal approval → UserOperation execution                     │     │
│  └────────────────────────────────────────────────────────────────────┘     │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │              Mantle Network (EVM L2, Chain ID 5000)                 │     │
│  │                                                                    │     │
│  │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐   │     │
│  │  │ ActiveSentinel  │  │  AlphaAuditor    │  │SentinelIdentity│   │     │
│  │  │ - Flash Arb     │  │  - Proof-of-Alpha│  │ - ERC-721 Agent│   │     │
│  │  │ - EIP-1153      │  │  - InsightCommit │  │   Identity NFT │   │     │
│  │  │ - TSTORE guard  │  │  - Event-only    │  │ - Ownership    │   │     │
│  │  └─────────────────┘  └──────────────────┘  └────────────────┘   │     │
│  │                                                                    │     │
│  │  External: INIT Capital │ Merchant Moe │ Agni Finance              │     │
│  └────────────────────────────────────────────────────────────────────┘     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Monorepo Structure

```
alphaflow-suite/
├── contracts/                 # Foundry project — Solidity smart contracts
│   ├── src/
│   │   ├── ActiveSentinel.sol       # Flash arbitrage executor (EIP-1153 TSTORE)
│   │   ├── AlphaAuditor.sol         # Proof-of-Alpha registry (Phase 2)
│   │   ├── SentinelIdentity.sol     # ERC-721 agent identity NFT
│   │   ├── interfaces/
│   │   │   ├── IDexRouter.sol       # DEX router interface (Merchant Moe/Agni)
│   │   │   ├── IFlashBorrower.sol   # INIT Capital flash loan callback
│   │   │   └── IINITCore.sol        # INIT Capital core interface
│   │   └── libraries/
│   │       └── TransientReentrancyGuard.sol  # EIP-1153 transient storage guard
│   ├── test/
│   │   ├── ActiveSentinel.t.sol     # Fuzz tests for arbitrage contract
│   │   └── SentinelModule1.t.sol    # Module 1 integration tests
│   ├── script/
│   │   └── Deploy.s.sol            # Deployment script
│   └── foundry.toml                # Foundry config (Mantle fork, optimizer)
│
├── agent-tee/                 # TEE Agent — runs inside Phala DStack CVM
│   ├── src/
│   │   ├── main.ts                  # Entry point, pipeline orchestration
│   │   ├── executor.ts              # UserOperation sender (arb + PoA commit)
│   │   ├── strategies/
│   │   │   └── yieldArchitect.ts    # Strategy: risk calc, EIP-712, hashing
│   │   ├── services/
│   │   │   ├── proposalPublisher.ts # Redis Pub/Sub publisher
│   │   │   ├── mevProtection.ts     # Gas price validation, private bundler
│   │   │   ├── nansenClient.ts      # Nansen MCP API integration
│   │   │   ├── rateLimiter.ts       # Paymaster rate limiting
│   │   │   ├── remoteAttestation.ts # SGX/TDX attestation (Phala)
│   │   │   └── sessionKeyRotator.ts # Session Key lifecycle management
│   │   ├── types/
│   │   │   └── index.ts            # All TypeScript interfaces
│   │   └── test/
│   │       └── yieldArchitect.test.ts # Vitest unit tests
│   ├── Dockerfile                   # Phala CVM Docker image
│   ├── package.json                 # ethers v6, zod, ioredis, viem, @zerodev/*
│   └── tsconfig.json               # Strict mode, ES2022, Node16 modules
│
├── bff/                       # Backend-for-Frontend (API Gateway)
│   ├── src/
│   │   ├── index.ts                 # Hono HTTP server entry point
│   │   ├── services/
│   │   │   ├── proposalService.ts   # Proposal CRUD, optimistic locking
│   │   │   └── onChainOracle.ts     # Staleness check (eth_call: slot0/getReserves)
│   │   └── test/
│   │       └── api.test.ts          # Integration tests
│   ├── Dockerfile
│   ├── package.json                 # hono, ioredis, viem
│   └── tsconfig.json
│
├── devops/                    # DevOps utilities
│   ├── src/tg-bot/
│   │   ├── index.ts                 # Telegraf v4 bot entry point
│   │   ├── config.ts               # Bot configuration (zod validated)
│   │   └── proposalStore.ts        # Redis proposal read/subscription
│   ├── Dockerfile
│   └── package.json                 # telegraf, ioredis
│
├── frontend/                  # Telegram Mini App (TMA)
│   ├── src/
│   │   ├── hooks/
│   │   │   └── useWebAuthn.ts       # Passkey creation & authentication
│   │   ├── utils/
│   │   │   └── bffClient.ts        # BFF API client with HMAC headers
│   │   └── vite-env.d.ts
│   ├── vite.config.ts
│   ├── package.json                 # react 18, @zerodev/sdk v5.5, vite 5
│   └── tsconfig.json
│
├── docker-compose.yml         # Full-stack local development
├── .github/workflows/
│   └── ci.yml                 # GitHub Actions CI pipeline
└── README.md
```

---

## Smart Contracts

### ActiveSentinel.sol

**Purpose:** Atomic flash arbitrage executor on Mantle.

**Key Features:**
- Borrows from INIT Capital via `flashBorrow()`, swaps on Merchant Moe → Agni Finance
- **EIP-1153 TSTORE** reentrancy guard — gas-free transient storage lock
- Validates minimum profit after all swaps
- Only callable by authorized operators (Session Keys from ZeroDev)

**Critical Functions:**
```solidity
function executeFlashArbitrage(ArbParams calldata params) external onlyOperator
function onFlashBorrow(address token, uint256 amount, bytes calldata data) external // INIT callback
```

**Security:**
- TSTORE-based reentrancy lock (cheaper than SSTORE, resets per transaction)
- Operator whitelist via SentinelIdentity NFT ownership
- minProfit assertion — reverts if arbitrage is unprofitable
- Flash loan callback validation (only INIT Core can call)

---

### AlphaAuditor.sol

**Purpose:** On-chain Proof-of-Alpha registry. Proves that the TEE agent generated an insight BEFORE it was publicly disclosed.

**Key Features:**
- `commitInsight(uint256 agentId, bytes32 insightHash)` — gas-optimized: emits event, increments counter, NO hash storage (event-only pattern)
- Only agents registered in SentinelIdentity can commit
- Immutable reference to `SentinelIdentity` for authorization

**Events:**
```solidity
event InsightCommitted(uint256 indexed agentId, bytes32 indexed insightHash, uint256 timestamp)
```

**Gas Optimization:**
- Hash is NOT stored in contract storage (saves ~20k gas per commit)
- Verification done off-chain by indexing `InsightCommitted` events
- Only `commitCount[agentId]` is updated (cold storage write once per new agent)

---

### SentinelIdentity.sol

**Purpose:** ERC-721 NFT representing agent identity. Each TEE agent mints one token as proof of registration.

**Key Features:**
- Soulbound characteristics (non-transferable in production config)
- URI storage for agent metadata
- Ownership check used by AlphaAuditor for authorization

---

### TransientReentrancyGuard.sol

**Purpose:** Library implementing reentrancy protection using EIP-1153 transient storage (TSTORE/TLOAD).

**Advantages over OpenZeppelin ReentrancyGuard:**
- Zero gas for state reset (transient storage clears after tx)
- ~100 gas per check vs ~5000 for SSTORE-based
- Native support on Mantle (Cancun opcodes enabled)

---

## TEE Agent

### Runtime Environment

- **Platform:** Phala Network DStack CVM (Confidential VM)
- **Attestation:** Intel SGX / TDX remote attestation
- **Runtime:** Node.js 20 + TypeScript (ES2022)
- **Key Management:** In-memory ECDSA key (never persisted to disk)

### Core Modules

#### YieldArchitect (`src/strategies/yieldArchitect.ts`)

The strategy brain of the system:

1. **Signal Processing:** Receives Smart Money signals from Nansen MCP
2. **Risk Calculation:**
   - `recommendedAmount = min(tradeVolume × riskCoefficient, availableBalance × 0.95)`
   - Volume cap: never exceeds 95% of user's available balance
   - Dust filter: rejects proposals below minimum threshold
3. **EIP-712 Typed Signing:**
   - Domain: `AlphaFlowSentinel`, version `1`, chainId `5000`
   - Struct: `Proposal(address asset, string action, uint256 amount, uint256 nonce, uint256 deadline, bytes32 reasoningHash, bytes32 insightHash, bytes32 commitTxHash)`
4. **Insight Hashing (Phase 2):**
   - `insightHash = keccak256(abi.encode(asset, action, recommendedAmount, timestamp))`
   - Deterministic — same inputs always produce same hash
   - Used for on-chain Proof-of-Alpha commitment
5. **2D Nonce Management:**
   - Monotonically increasing nonce per TEE session
   - Resets on CVM restart (new key = new nonce sequence)

**Interface:**
```typescript
class YieldArchitect {
    generateProposal(signal, profile, ttlSec, commitTxHash?): Promise<SignedProposal>
    computeInsightHash(asset, action, amount, timestamp): string
    static verifyProposal(proposal, signature, expectedSigner, chainId): boolean
}
```

#### SentinelExecutor (`src/executor.ts`)

Manages all on-chain interactions through ZeroDev Account Abstraction:

1. **Proof-of-Alpha Commit:**
   - Encodes `AlphaAuditor.commitInsight(agentId, insightHash)`
   - Sends UserOperation via Session Key through private bundler
   - Returns `commitTxHash` on success, throws on failure
   - **Pipeline invariant:** failure here = proposal NOT published

2. **Flash Arbitrage Execution:**
   - Encodes `ActiveSentinel.executeFlashArbitrage(params)`
   - 2D nonce keys: unique per route pair (prevents nonce conflicts for parallel ops)
   - Gas price validation: rejects if baseFee > 50 gwei threshold

3. **Rate Limiting:**
   - `maxOpsPerMinute: 5`, `maxOpsPerHour: 30`
   - Cooldown on reverts: 30 seconds
   - Force-unblock via Telegram HITL command

**ZeroDev Configuration:**
- Kernel v3.1 (`constants.KERNEL_V3_1`)
- EntryPoint v0.7 (`0x0000000071727De22E5E9d8BAf0edAc6f37da032`)
- Session Key validator for TEE agent signing
- Private bundler for MEV protection

#### ProposalPipeline (`src/main.ts`)

The orchestration layer enforcing the critical pipeline invariant:

```
Signal → YieldArchitect.generateProposal()
       → SentinelExecutor.commitProofOfAlpha(insightHash)  // BLOCKING
       → Re-sign proposal with commitTxHash
       → ProposalPublisher.publish()  // ONLY after successful commit
```

**Hard Invariant:** If `commitProofOfAlpha()` throws → `publish()` is NEVER called.

---

### Supporting Services

| Service | File | Purpose |
|---------|------|---------|
| ProposalPublisher | `services/proposalPublisher.ts` | Redis Pub/Sub message formatting & delivery |
| MEV Protection | `services/mevProtection.ts` | Gas price anomaly detection, private bundler routing |
| Nansen Client | `services/nansenClient.ts` | Nansen MCP API wrapper, rate limiting, signal parsing |
| Rate Limiter | `services/rateLimiter.ts` | Paymaster gas vault protection (ops/min, ops/hour) |
| Remote Attestation | `services/remoteAttestation.ts` | SGX/TDX attestation report generation |
| Session Key Rotator | `services/sessionKeyRotator.ts` | Periodic Session Key renewal |

---

## Backend-for-Frontend

### BFF (`bff/`)

**Stack:** Hono + Node.js + ioredis + viem

**Responsibilities:**
1. **HMAC Verification:** Validates `x-hmac-signature` header (timing-safe comparison)
2. **Optimistic Locking:** `SETNX(proposal_lock:{id}, 60s)` prevents double-execution
3. **Staleness Check:** `eth_call` to on-chain oracles (`slot0()` for Uniswap-style, `getReserves()` for constant-product)
4. **Nullifier Burn:** `SET nullifier:{hash}` — prevents replay of same proposal
5. **RPC Fallback:** `viem.fallback([primary, fallback1, fallback2])` for reliability

**Redis Key Schema:**
```
proposal:{id}          → JSON serialized proposal
proposal:{id}:status   → "pending" | "approved" | "executed" | "expired"
proposal_lock:{id}     → "locked" (TTL: 60s, via SETNX)
nullifier:{hash}       → "burned" (permanent)
```

**API Endpoints:**
- `POST /api/proposals/:id/approve` — approve and execute proposal
- `GET /api/proposals/:id` — fetch proposal details
- `GET /api/health` — health check with Redis/RPC status

---

## Telegram Bot

### Bot (`devops/src/tg-bot/`)

**Stack:** Telegraf v4 + ioredis (dual clients)

**Key Design Decisions:**
1. **Dual Redis Clients:** Subscriber client cannot perform CRUD operations (Redis limitation), so a separate publisher client handles reads/writes
2. **Whitelist Middleware:** Silently drops messages from non-`TARGET_CHAT_ID` (no error responses to attackers)
3. **HMAC URL Generation:** Computes `HMAC-SHA256(proposalId, HMAC_SECRET)` → Base64url → appended to Telegram Mini App `startapp` parameter

**Commands:**
- `/status` — Show agent status (uptime, pending proposals, rate limit state)
- `/pause` — Pause proposal delivery (operator safety switch)
- `/resume` — Resume proposal delivery

**Message Format:**
```
🎯 New Alpha Signal

Asset: WMNT
Action: BUY
Amount: 5,000 WMNT
Confidence: 92%
Deadline: 5 min

[Open in App →]  ← Deep link with HMAC
```

**startapp Parameter Format:** `{proposalId}_{hmacBase64url}`

---

## Frontend TMA

### Telegram Mini App (`frontend/`)

**Stack:** React 18 + Vite 5 + @zerodev/sdk v5.5

**Key Integrations:**
1. **Passkey Authentication:**
   - `toPasskeyValidator()` (NOT `signerToPasskeyValidator` — deprecated)
   - `PasskeyValidatorContractVersion.V0_0_3_PATCHED`
   - `constants.KERNEL_V3_1`

2. **Session Key Flow:**
   - User authenticates with Passkey → creates Session Key for TEE agent
   - Session Key has scoped permissions (only `ActiveSentinel.executeFlashArbitrage`)
   - TEE uses Session Key for gasless operations

3. **HMAC Verification:**
   - Extracts `{proposalId}_{hmacBase64url}` from `startapp` parameter
   - Passes as `x-hmac-signature` header to BFF API
   - BFF verifies timing-safe before returning proposal data

4. **Browser Compatibility:**
   - EventEmitter polyfill required for browser environment
   - `events` package installed for Node.js EventEmitter in browser

---

## Security Model

### Threat Mitigation Matrix

| Threat | Mitigation | Module |
|--------|-----------|--------|
| MEV front-running | Private bundler, gas price threshold | `executor.ts`, `mevProtection.ts` |
| Reentrancy | EIP-1153 TSTORE transient lock | `TransientReentrancyGuard.sol` |
| Key extraction | In-memory only, Phala CVM attestation | `main.ts`, TEE hardware |
| Replay attack | 2D nonces + nullifier burn | `executor.ts`, BFF |
| Gas drain | Rate limiter (5/min, 30/hr) | `rateLimiter.ts` |
| Stale price | On-chain oracle check before execute | `onChainOracle.ts` |
| Unauthorized commit | SentinelIdentity NFT ownership check | `AlphaAuditor.sol` |
| HMAC forgery | HMAC-SHA256 + timing-safe comparison | BFF, Telegram Bot |
| Double execution | Optimistic lock (SETNX 60s) | BFF `proposalService.ts` |
| Signal fabrication | Proof-of-Alpha on-chain before publish | `ProposalPipeline` |

### Key Lifecycle

```
CVM Boot → Wallet.createRandom() → HDNodeWallet (in-memory only)
         → Public address exported via /health endpoint
         → Session Key registered on-chain (ZeroDev)
         → Key NEVER: logged, persisted, transmitted
         → CVM Restart → New key generated, old Session Key revoked
```

---

## Data Flow & Pipeline Invariant

### Complete Signal-to-Execution Flow

```
1. Nansen MCP detects Smart Money movement
   └──▶ SmartMoneySignal {wallet, asset, action, volume, reputation}

2. TEE Agent receives signal
   └──▶ YieldArchitect.generateProposal(signal, riskProfile)
        ├── Risk-adjusted amount calculation
        ├── EIP-712 typed data signing
        ├── Insight hash computation (keccak256)
        └── SignedProposal {insightHash, signature, nonce, deadline}

3. On-chain Proof-of-Alpha commit (BLOCKING)
   └──▶ SentinelExecutor.commitProofOfAlpha(insightHash)
        ├── Encode AlphaAuditor.commitInsight(agentId, insightHash)
        ├── Send UserOperation via Session Key
        ├── Wait for bundler confirmation
        └── Return commitTxHash OR throw (abort pipeline)

4. Publish to Redis (ONLY after step 3 succeeds)
   └──▶ ProposalPublisher.publish({proposal, commitTxHash})
        └── Redis PUBLISH "tee_proposals" → JSON payload

5. Telegram Bot receives and formats
   └──▶ Bot subscribes to "tee_proposals"
        ├── Format message with action buttons
        ├── Compute HMAC for deep link
        └── Send to TARGET_CHAT_ID

6. User opens TMA via deep link
   └──▶ Frontend extracts proposalId + HMAC from startapp
        ├── Calls BFF: GET /api/proposals/:id (with HMAC header)
        ├── BFF verifies HMAC (timing-safe)
        ├── BFF checks staleness (on-chain oracle)
        └── Returns proposal if valid

7. User approves → Execute
   └──▶ Frontend: POST /api/proposals/:id/approve
        ├── BFF: SETNX proposal_lock:{id} (optimistic lock)
        ├── BFF: Check nullifier (replay prevention)
        ├── BFF: SET nullifier:{hash} (burn)
        └── Execute via ZeroDev UserOperation
```

### Pipeline Invariant (Critical)

```
IF commitProofOfAlpha() throws:
  THEN publish() is NEVER called
  AND  proposal is NEVER sent to Telegram
  AND  user NEVER sees the signal

REASON: Without on-chain proof, anyone could fabricate signals.
        Proof-of-Alpha guarantees the TEE committed the insight
        BEFORE public disclosure.
```

---

## Deployment & Infrastructure

### Docker Compose Services

```yaml
services:
  agent-tee:     # Phala CVM container (attestation-enabled)
  bff:           # Hono API (port 3000)
  tg-bot:        # Telegram bot (polling mode)
  frontend:      # Vite dev server (port 5173) / nginx (prod)
  redis:         # Redis 7.x (persistence: AOF)
```

### GCP Instance

- Instance: `instance-20260330-115005`
- OS: Debian 12 (Linux 6.1.0-44-cloud-amd64)
- Region: Configured for low-latency to Mantle RPC

### CI/CD (`.github/workflows/ci.yml`)

- Foundry tests (`forge test --fuzz-runs 256`)
- TypeScript compilation check (`tsc --noEmit`)
- Vitest unit tests
- Docker image build verification

---

## Environment Variables Reference

### TEE Agent (`agent-tee/`)

| Variable | Required | Description |
|----------|----------|-------------|
| `REDIS_URL` | Yes | Redis connection string |
| `CHAIN_ID` | Yes | Network chain ID (5000 for Mantle) |
| `ALPHA_AUDITOR_ADDRESS` | Yes | Deployed AlphaAuditor contract address |
| `AGENT_ID` | Yes | uint256 agent ID (SentinelIdentity tokenId) |
| `PROPOSAL_TTL_SECONDS` | No | Proposal validity (default: 300) |
| `HEALTH_PORT` | No | Health endpoint port (default: 8080) |
| `ATTESTATION_ENABLED` | No | Enable SGX attestation (default: false) |
| `SESSION_PRIVATE_KEY` | Yes* | Session Key private key (hex) |
| `KERNEL_ADDRESS` | Yes* | ZeroDev Kernel account address |
| `ACTIVE_SENTINEL_ADDRESS` | Yes* | Deployed ActiveSentinel address |
| `BUNDLER_URL` | Yes* | Private bundler endpoint |
| `MANTLE_RPC_URL` | No | Mantle RPC (default: https://rpc.mantle.xyz) |

*Required for production mode (on-chain operations)

### BFF (`bff/`)

| Variable | Required | Description |
|----------|----------|-------------|
| `REDIS_URL` | Yes | Redis connection string |
| `HMAC_SECRET` | Yes | Shared secret for HMAC-SHA256 |
| `MANTLE_RPC_URL` | Yes | Primary RPC endpoint |
| `MANTLE_RPC_FALLBACK_1` | No | Fallback RPC 1 |
| `MANTLE_RPC_FALLBACK_2` | No | Fallback RPC 2 |
| `PORT` | No | API port (default: 3000) |

### Telegram Bot (`devops/src/tg-bot/`)

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | Yes | Telegram Bot API token |
| `TARGET_CHAT_ID` | Yes | Whitelisted chat ID |
| `REDIS_URL` | Yes | Redis connection string |
| `HMAC_SECRET` | Yes | Same secret as BFF |
| `TMA_URL` | Yes | Frontend TMA URL |

### Frontend (`frontend/`)

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_BFF_URL` | Yes | BFF API base URL |
| `VITE_CHAIN_ID` | Yes | Chain ID (5000) |
| `VITE_BUNDLER_URL` | Yes | ZeroDev bundler URL |
| `VITE_PAYMASTER_URL` | No | ZeroDev paymaster URL |

---

## Development Roadmap

### ✅ Completed (Modules 1-5)

| Module | Description | Status |
|--------|-------------|--------|
| Module 1 | ActiveSentinel.sol — Flash arbitrage with EIP-1153 | ✅ Complete |
| Module 2 | TEE Agent — YieldArchitect, EIP-712, key management | ✅ Complete |
| Module 3 | BFF — HMAC, optimistic lock, staleness, nullifier | ✅ Complete |
| Module 4 | Frontend TMA — Passkeys, ZeroDev v5.5, Session Keys | ✅ Complete |
| Module 5 | Telegram Bot — Dual Redis, whitelist, HITL commands | ✅ Complete |

### 🔄 In Progress (Phase 2)

| Feature | Description | Status |
|---------|-------------|--------|
| AlphaAuditor.sol | Proof-of-Alpha on-chain registry | ✅ Deployed |
| SentinelIdentity.sol | ERC-721 agent identity | ✅ Deployed |
| Pipeline Invariant | Commit-before-publish enforcement | ✅ Implemented |
| Insight Hashing | Deterministic keccak256 encoding | ✅ Implemented |
| Executor Integration | commitProofOfAlpha via Session Key | ✅ Implemented |

### 📋 Planned (Phase 3+)

| Feature | Description |
|---------|-------------|
| Circuit Breaker | Auto-pause on consecutive losses or anomalies |
| Formal Verification | Certora/Halmos specs for ActiveSentinel invariants |
| Multi-Path Arbitrage | 3+ hop routes (INIT → Moe → Agni → FusionX) |
| Portfolio Rebalancing | Automated position management based on signals |
| Cross-chain Expansion | Arbitrum, Base, Scroll integration |
| Governance | DAO for parameter updates (risk coefficients, fees) |

---

## Technical Decisions & Rationale

### Why ethers v6 (not viem-only)?

- `Wallet.createRandom()` returns `HDNodeWallet` — more ergonomic for EIP-712
- `AbiCoder.defaultAbiCoder().encode()` for deterministic hashing
- `TypedDataEncoder` for EIP-712 struct hash computation
- viem used in executor for compatibility with ZeroDev SDK

### Why EIP-1153 TSTORE (not OpenZeppelin ReentrancyGuard)?

- 100 gas vs 5000 gas per reentrancy check
- Transient storage auto-clears after transaction (no warm/cold slot issues)
- Mantle supports Cancun opcodes (TSTORE/TLOAD available)

### Why Event-only in AlphaAuditor (not SSTORE hash)?

- Save 20,000 gas per commit (no SSTORE)
- Verification is off-chain (event indexing via The Graph or direct RPC logs)
- On-chain proof exists in transaction receipt regardless

### Why Dual Redis Clients in Bot?

- Redis protocol limitation: a client in SUBSCRIBE mode cannot execute other commands
- Separate publisher client handles CRUD operations
- Both share same connection URL but different instances

### Why Private Bundler?

- Public bundlers expose UserOperations to MEV searchers
- Our bundler sends directly to sequencer (Mantle uses centralized sequencer)
- Eliminates sandwich attacks on arbitrage transactions

---

*Document auto-generated from codebase analysis. Last verified against commit tree on 2025-05-22.*
