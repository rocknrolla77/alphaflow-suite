# AlphaFlow Suite — Technical Architecture

> **Agentic Commerce Infrastructure on Mantle Network**
> DoraHacks Mantle Hackathon Winner
> Stack: Solidity · Phala TEE · ZeroDev ERC-4337 · Hono · React TMA · Telegraf

---

## Table of Contents

1. [Monorepo Structure](#1-monorepo-structure)
2. [Module 1 — Smart Contracts](#2-module-1--smart-contracts-contracts)
3. [Module 2 — TEE Agent](#3-module-2--tee-agent-agent-tee)
4. [Module 3 — BFF API Server](#4-module-3--bff-api-server-bff)
5. [Module 4 — Telegram Mini App](#5-module-4--telegram-mini-app-frontend)
6. [Module 5 — HITL Telegram Bot](#6-module-5--hitl-telegram-bot-devopssrc-tg-bot)
7. [End-to-End Data Flow](#7-end-to-end-data-flow)
8. [Redis Key Schema](#8-redis-key-schema)
9. [Security Invariants](#9-security-invariants)
10. [Environment Variables](#10-environment-variables)
11. [Running Locally](#11-running-locally)

---

## 1. Monorepo Structure

```
alphaflow-suite/
├── contracts/                    # Solidity — ActiveSentinel flash arbitrage
│   ├── foundry.toml
│   ├── src/
│   │   ├── ActiveSentinel.sol        ← core arbitrage contract
│   │   ├── interfaces/
│   │   │   ├── IINITCore.sol         ← INIT Capital flash borrow interface
│   │   │   ├── IFlashBorrower.sol
│   │   │   └── IDexRouter.sol        ← Merchant Moe + Agni Finance
│   │   └── libraries/
│   │       └── TransientReentrancyGuard.sol  ← EIP-1153 TSTORE guard
│   ├── test/
│   │   └── ActiveSentinel.t.sol      ← Foundry fuzz tests
│   └── script/
│       └── Deploy.s.sol
│
├── agent-tee/                    # TEE Agent — Phala Network CVM
│   ├── Dockerfile                    ← Phala DStack compatible image
│   ├── package.json                  ← ethers v6, ioredis, tsx, vitest
│   ├── tsconfig.json                 ← strict, Node16
│   └── src/
│       ├── main.ts                   ← entry point, key gen, health :8080
│       ├── types/
│       │   └── index.ts              ← SmartMoneySignal, UserRiskProfile,
│       │                                Proposal, SignedProposal, EIP712Domain
│       └── strategies/
│           └── yieldArchitect.ts     ← conviction weight + EIP-712 signing
│
├── bff/                          # Backend-for-Frontend — Hono (Node.js)
│   ├── package.json                  ← hono, ioredis, viem, zod
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                  ← Hono server, routes, middleware
│       └── services/
│           ├── proposalService.ts    ← Redis CRUD, HMAC, optimistic lock
│           └── onChainOracle.ts      ← viem fallback client, staleness check
│
├── frontend/                     # Telegram Mini App — React + Vite
│   ├── package.json                  ← React 18, @zerodev/sdk 5.5, viem v2
│   ├── vite.config.ts                ← events polyfill, code-split
│   ├── tsconfig.json
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── vite-env.d.ts
│       ├── App.tsx                   ← startapp parsing, Telegram.WebApp.ready()
│       ├── components/
│       │   └── InvestFlowApp.tsx     ← main UI + ZeroDev flow + terminal log
│       ├── hooks/
│       │   └── useWebAuthn.ts        ← detection + WebView fallback
│       └── utils/
│           └── bffClient.ts          ← typed API client, HMAC header
│
├── devops/                       # Bot + Infrastructure
│   ├── Dockerfile
│   ├── package.json                  ← telegraf v4, ioredis, uuid, zod
│   ├── tsconfig.json
│   ├── setup-debian.sh               ← server hardening script
│   └── src/tg-bot/
│       ├── index.ts                  ← Telegraf bot, whitelist, commands, broadcast
│       └── proposalStore.ts          ← Redis Pub/Sub, HMAC, nullifier
│
├── docker-compose.yml            ← redis + bff + tg-bot + agent-dev + anvil
├── CONCEPT.md                    ← product concept & business rationale
├── ARCHITECTURE.md               ← this file — technical reference
└── README.md
```

---

## 2. Module 1 — Smart Contracts (`contracts/`)

### ActiveSentinel.sol

Flash arbitrage contract deployed on Mantle Network (Chain ID: 5000).

**Atomic execution path:**
```
executeFlashArbitrage(params)
  └─▶ INIT Capital: flashBorrow(tokenA, amount)
        └─▶ onFlashLoan() callback:
              1. Merchant Moe: swapExactTokensForTokens(A → B)
              2. Agni Finance:  swapExactTokensForTokens(B → A)
              3. repay(tokenA, amount + fee)
              4. invariant check: profit >= params.minProfitTokenA
                   └─▶ revert InvariantViolated() if false
```

**Reentrancy guard — EIP-1153 (transient storage):**
```solidity
// Gas cost: 100 gas (TSTORE) vs 20,000 gas (SSTORE)
// Clears automatically at end of transaction — no cleanup needed
uint256 private constant ENTERED = 1;
uint256 private constant NOT_ENTERED = 0;

modifier nonReentrant() {
    require(tload(SLOT) == NOT_ENTERED);
    tstore(SLOT, ENTERED);
    _;
    tstore(SLOT, NOT_ENTERED);  // restored, not cleared
}
```

**Function signature:** `executeFlashArbitrage(FlashArbitrageParams calldata params)`

**FlashArbitrageParams struct:**
```solidity
struct FlashArbitrageParams {
    address tokenA;             // borrow token
    address tokenB;             // intermediate token
    uint256 flashAmount;        // amount to borrow from INIT
    uint256 amountOutMinRoute1; // min tokenB from Merchant Moe
    uint256 amountOutMinRoute2; // min tokenA from Agni Finance
    uint256 minProfitTokenA;    // minimum net profit (invariant)
    uint256 deadline;           // block.timestamp limit
}
```

**Authorization:** `onlyOwner` (ZeroDev Kernel account via Session Key)

**Gas:** ~268,000 per full arbitrage cycle (measured on Mantle fork)

### ZeroDev Account Abstraction

**Kernel v3 wallet hierarchy:**
```
User (Passkey / WebAuthn hardware key)
  └── ZeroDev Kernel v3 (ERC-4337 Smart Account)
        ├── Passkey Validator  ← owner, used for setup & large operations
        └── Session Key Validator ← TEE agent signer, scoped permissions
```

**Session Key policies (5 restrictions):**

| Policy | Value | Rationale |
|--------|-------|-----------|
| Target contract | `ActiveSentinel` address only | TEE cannot call arbitrary contracts |
| Function selector | `executeFlashArbitrage` only | rescue/rescueNative blocked |
| Native value | 0 MNT | Cannot drain native token |
| Gas | maxFeePerGas ≤ 50 gwei, gasLimit ≤ 500k | Protects gas vault from drain |
| Validity | 24h window + pre-emptive rotation | Auto-expire, T-1h rotation |

**2D Nonces — parallel UserOps without collision:**
```
nonce key = uint192(keccak256(abi.encode(tokenA, tokenB, route1_payload)))

USDC→WMNT pair:  nonce lane A (independent)
USDC→FBTC pair:  nonce lane B (independent)
→ both can execute in the same block without collision
```

**EntryPoint:** v0.7 (`0x0000000071727De22E5E9d8BAf0edAc6f37da032`)

---

## 3. Module 2 — TEE Agent (`agent-tee/`)

Runs inside Phala Network Confidential Virtual Machine (Intel TDX/SGX).

### Types (`src/types/index.ts`)

```typescript
interface SmartMoneySignal {
  readonly walletAddress:   string;   // 0x...
  readonly walletTag:       string;   // "Fund" | "VC" | "90D Smart Trader"
  readonly asset:           string;   // token address
  readonly assetSymbol:     string;
  readonly tradeVolume:     bigint;   // in wei
  readonly portfolioValue:  bigint;   // in wei
  readonly action:          "BUY" | "SELL";
  readonly timestamp:       number;
  readonly chainId:         number;
  readonly txHash:          string;
  readonly confidence:      number;   // 0.0 – 1.0
}

interface UserRiskProfile {
  readonly userAddress:     string;
  readonly availableBalance: bigint;  // in wei
  readonly riskTolerance:   number;   // K_risk ∈ [0.1, 1.0]
  readonly chainId:         number;
  readonly maxPositionPct:  number;   // cap: 0.0 – 1.0
}

interface Proposal {
  readonly asset:             string;   // token address
  readonly action:            "BUY" | "SELL";
  readonly recommendedAmount: bigint;   // S_user in wei
  readonly nonce:             number;   // monotonic per-signer
  readonly deadline:          number;   // unix timestamp
  readonly reasoningHash:     string;   // bytes32 hex
}

interface SignedProposal extends Proposal {
  readonly signature:     string;   // EIP-712 sig (hex)
  readonly signerAddress: string;   // TEE ephemeral key
  readonly generatedAt:   number;   // unix timestamp
}
```

### Strategy Engine (`src/strategies/yieldArchitect.ts`)

**Conviction weight formula:**
```
W = S_smart / V_smart
  S_smart = signal.tradeVolume   (Smart Money trade size)
  V_smart = signal.portfolioValue (Smart Money total portfolio)
  W ∈ (0, 1]  — fraction of portfolio committed to the trade

User position sizing:
  S_user = V_user × W × K_risk
  V_user = profile.availableBalance
  K_risk = profile.riskTolerance  ∈ [0.1, 1.0]
  S_user capped at profile.maxPositionPct × V_user
```

**Integer arithmetic (no floating point):**
- All values scaled to 10^18 precision
- Division last to preserve precision
- Result: `S_user = (V_user × W_num × K_risk_scaled) / (W_denom × SCALE)`

**Reasoning hash:**
```typescript
reasoningHash = keccak256(abi.encode(
  walletAddress, asset, action, tradeVolume,
  portfolioValue, riskTolerance, availableBalance,
  chainId, nonce
))
```
Proves: decision derived from specific on-chain data, not arbitrary.

**EIP-712 domain:**
```typescript
{
  name:              "AlphaFlow YieldArchitect",
  version:           "1",
  chainId:           5000,         // Mantle
  verifyingContract: SENTINEL_ADDRESS
}
```

**Signature verification (static method):**
```typescript
YieldArchitect.verifyProposal(signed: SignedProposal): boolean
// Recovers signer from EIP-712 signature, compares to signerAddress
```

### Entry Point (`src/main.ts`)

- Generates ephemeral ECDSA key via `Wallet.createRandom()` (HDNodeWallet)
- Private key **never** logged, persisted, or exported
- Health HTTP server on `:8080`
  - `GET /health` → `{ status: "ok", signer: address, uptime: N }`
  - `GET /attestation` → placeholder for Phala DStack quote
- Graceful shutdown: SIGINT / SIGTERM

---

## 4. Module 3 — BFF API Server (`bff/`)

Hono (Node.js) server on port `:3001`. Bridge between TMA, Redis, and Mantle RPC.

### Routes

```
GET  /api/health
  → Redis PING + RPC eth_blockNumber
  → { redis: "ok"|"error", rpc: "ok"|"error", timestamp }
  ← No HMAC required

GET  /api/proposal/:id
  Headers: x-hmac-signature: <hex>
  1. verifyHmac(proposalId, signature)  ← timing-safe
  2. getAndLockProposal(id)             ← optimistic lock (60s TTL)
  3. checkPriceStaleness(asset, max%)   ← on-chain price, NOT from client
  4. If deviation > maxSlippagePct → 409 Conflict
  → { proposal, eip712Payload, domain, ttlSeconds }

POST /api/proposal/:id/consume
  Headers: x-hmac-signature: <hex>
  1. verifyHmac
  2. consumeProposal(id)  ← atomic: nullifier + status="consumed"
  → { consumed: true }

POST /api/proposal/:id/simulate
  Headers: x-hmac-signature: <hex>
  Body: { from, calldata }
  1. verifyHmac
  2. eth_call (viem publicClient)
  → { success, gasUsed, returnData }
```

### HMAC Verification (`src/services/proposalService.ts`)

```typescript
// Server generates HMAC (used by TG bot on broadcast):
computeHmac(proposalId: string): string
  → createHmac("sha256", HMAC_SECRET).update(proposalId).digest("hex")

// Server verifies HMAC (used on each API call):
verifyHmac(proposalId: string, clientHex: string): boolean
  → timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(clientHex, "hex")
    )
  // Fixed-length comparison — not vulnerable to timing oracle
  // Returns false (not throw) on length mismatch
```

### Optimistic Lock

```typescript
// Redis pipeline (atomic):
SETNX proposal:{id}:lock  "1"  EX 60
SET   proposal:{id}:status "dispensed"  EX ttl

// Race condition protection:
// If two requests hit simultaneously, only one gets the lock.
// Second gets HTTP 423 Locked.
// Lock auto-expires after 60s (handles TMA crash without manual cleanup).
```

### On-Chain Oracle (`src/services/onChainOracle.ts`)

**viem multi-RPC fallback:**
```typescript
createPublicClient({
  chain: mantle,
  transport: fallback([
    http(PRIMARY_RPC,    { timeout: 10_000 }),   // Alchemy/Ankr
    http(FALLBACK_RPC_1, { timeout: 15_000 }),   // public Mantle RPC
    http(FALLBACK_RPC_2, { timeout: 15_000 }),   // backup
  ], { rank: true })  // auto-ranks by latency + error rate
})
```

**Staleness check algorithm:**
```typescript
// Try UniV3 slot0 (Agni Finance style):
const [sqrtPriceX96] = await client.readContract({ ... getSlot0 })
currentPrice = (sqrtPriceX96 ** 2n) / (2n ** 192n)

// Fallback → UniV2 getReserves (Merchant Moe style):
const [r0, r1] = await client.readContract({ ... getReserves })
currentPrice = r0 / r1

// Deviation check:
deviation = abs(currentPrice - proposalPrice) / proposalPrice
if (deviation > maxSlippagePct / 100) → return { stale: true }
```

### Middleware

```typescript
// CORS — Telegram origins only:
app.use("*", cors({
  origin: ["https://web.telegram.org", "https://t.me"],
  allowHeaders: ["x-hmac-signature", "content-type"],
}))

// HMAC middleware (applied to /api/* except /api/health):
app.use("/api/*", async (ctx, next) => {
  const sig = ctx.req.header("x-hmac-signature")
  const id  = ctx.req.param("id")
  if (!verifyHmac(id, sig)) return ctx.json({ error: "Unauthorized" }, 401)
  return await next()
})
```

---

## 5. Module 4 — Telegram Mini App (`frontend/`)

React 18 SPA, opened inside Telegram WebView via inline keyboard WebApp button.

### Entry Point (`src/App.tsx`)

**Telegram `startapp` parameter parsing:**
```
Deep link format:
  https://t.me/AlphaFlowBot/app?startapp={proposalId}_{hmacBase64url}

Parsing sequence:
  1. window.Telegram?.WebApp?.initDataUnsafe?.start_param
     (native TMA API — preferred)
  2. new URLSearchParams(window.location.hash.slice(1)).get("tgWebAppStartParam")
     (URL hash fallback for older Telegram versions)
  3. new URLSearchParams(window.location.search).get("startapp")
     (direct URL access / dev mode)

Format: "{uuid}_{base64url-encoded-hmac-hex}"
Split on last "_" → [proposalId, hmacB64url]

Base64url → hex decoding:
  hmacB64url
    .replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(...)  ← add "=" padding
  → Buffer.from(b64, "base64").toString("hex")
  → hmacHex  (passed as x-hmac-signature header)
```

**Telegram SDK initialization:**
```typescript
window.Telegram?.WebApp?.ready()    // signals TMA loaded
window.Telegram?.WebApp?.expand()   // request full-screen
```

### BFF Client (`src/utils/bffClient.ts`)

```typescript
// Type-safe fetch wrapper with timeout:
fetchProposal(id: string, hmacHex: string): Promise<ProposalResponse>
  GET /api/proposal/${id}
  Headers: { "x-hmac-signature": hmacHex }
  Timeout: 15s (AbortController)

consumeProposal(id: string, hmacHex: string): Promise<void>
  POST /api/proposal/${id}/consume
  Headers: { "x-hmac-signature": hmacHex }

simulateTransaction(id, hmacHex, from, calldata): Promise<SimulateResult>
  POST /api/proposal/${id}/simulate

// Error classification:
class BffApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code: "UNAUTHORIZED" | "NOT_FOUND" | "STALE_PRICE" |
                 "LOCKED" | "CONSUMED" | "EXPIRED" | "SERVER_ERROR"
  ) {}
}
```

### WebAuthn Hook (`src/hooks/useWebAuthn.ts`)

**3-level capability detection:**
```typescript
// Level 1: API exists in window
typeof window.PublicKeyCredential !== "undefined"

// Level 2: Platform authenticator available
await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
// → true on iPhone FaceID, Mac TouchID, Android biometric

// Level 3: Conditional mediation (autofill UI)
await PublicKeyCredential.isConditionalMediationAvailable?.()
```

**Telegram WebView detection:**
```typescript
const isTelegramWebView =
  /Telegram/i.test(navigator.userAgent) ||
  typeof window.Telegram?.WebApp !== "undefined"
```

**Error classification:**
```typescript
classifyWebAuthnError(err: unknown): WebAuthnError
  NotAllowedError   → { type: "not_allowed", shouldOpenExternal: true }
  SecurityError     → { type: "security", shouldOpenExternal: true }
  NotSupportedError → { type: "not_supported", shouldOpenExternal: true }
  AbortError        → { type: "user_cancelled", shouldOpenExternal: false }
  default           → { type: "unknown", shouldOpenExternal: false }
```

**External browser fallback:**
```typescript
// Opens link in native browser (Safari/Chrome) from Telegram
window.Telegram?.WebApp?.openLink(currentUrl, { try_instant_view: false })
```

### Main Component (`src/components/InvestFlowApp.tsx`)

**Status FSM:**
```
idle → verifying → ready → signing → executing → success
                ↘                             ↗
                  ──────────── error ────────
```

**ZeroDev execution flow (lazy-loaded):**
```typescript
// 1. Parse Telegram startapp → proposalId + hmacHex
// 2. Fetch proposal from BFF (HMAC header)
// 3. On "Execute" click:
const { createKernelAccountClient, createKernelAccount, constants } =
  await import("@zerodev/sdk")
const { toPasskeyValidator, toWebAuthnKey, WebAuthnMode,
        PasskeyValidatorContractVersion } =
  await import("@zerodev/passkey-validator")

// Create/login passkey:
const webAuthnKey = await toWebAuthnKey({
  passkeyName:     "AlphaFlow",
  passkeyServerUrl: ZERODEV_PROJECT_ID,
  mode:             WebAuthnMode.Login,   // or .Register for new users
})

// Initialize validator:
const passkeyValidator = await toPasskeyValidator(publicClient, {
  webAuthnKey,
  entryPoint:        { address: ENTRYPOINT_V07, version: "0.7" },
  kernelVersion:     constants.KERNEL_V3_1,
  validatorContractVersion: PasskeyValidatorContractVersion.V0_0_3_PATCHED,
})

// Create Kernel account:
const kernelAccount = await createKernelAccount(publicClient, {
  plugins:      { sudo: passkeyValidator },
  entryPoint:   { address: ENTRYPOINT_V07, version: "0.7" },
  kernelVersion: constants.KERNEL_V3_1,
})

// Create client with bundler + paymaster:
const kernelClient = await createKernelAccountClient({
  account: kernelAccount,
  chain:   mantle,
  bundlerTransport: http(BUNDLER_URL),
  paymaster: {
    getPaymasterData: async (userOp) => ({
      paymaster: PAYMASTER_ADDRESS,
      paymasterData: "0x",
    })
  }
})

// Send UserOperation:
const userOpHash = await kernelClient.sendUserOperation({
  callData: await kernelAccount.encodeCalls([{
    to:    SENTINEL_ADDRESS,
    value: 0n,
    data:  eip712Payload.calldata,  // from BFF
  }])
})

// Wait for receipt:
const receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash })

// Burn nullifier:
await consumeProposal(proposalId, hmacHex)
```

**Anti-double-click guard:**
```typescript
const executionLockRef = useRef<boolean>(false)

const handleExecute = useCallback(async () => {
  if (executionLockRef.current) return  // ← blocks on second call
  executionLockRef.current = true       // ← set immediately, never reset
  // ... execution
}, [])
```

**Terminal log UI:**
```
[HH:MM:SS] Verifying proposal signature...
[HH:MM:SS] HMAC verified ✓
[HH:MM:SS] Price check: deviation 0.43% < 2.00% ✓
[HH:MM:SS] Proposal ready — Action: BUY WMNT
[HH:MM:SS] Awaiting Passkey signature (FaceID)...
[HH:MM:SS] UserOp submitted: 0x1a2b3c...
[HH:MM:SS] Confirmed in block 8293847 ✓
[HH:MM:SS] Nullifier burned ✓
```

---

## 6. Module 5 — HITL Telegram Bot (`devops/src/tg-bot/`)

Telegraf v4 bot. Receives TEE proposals via Redis Pub/Sub, broadcasts to user.

### Proposal Store (`src/tg-bot/proposalStore.ts`)

**Dual Redis connection pattern:**
```
subscriber (ioredis) — subscribe mode only, blocked after subscribe()
commander  (ioredis) — all CRUD operations (GET, SET, DEL, pipeline)

IMPORTANT: ioredis client in subscribe mode CANNOT execute regular commands.
Two separate connections are mandatory.
```

**storeProposal() — 7-step atomic pipeline:**
```
1. GET bot:paused → if "1": drop (return null)
2. JSON.parse + Zod TeeProposalSchema.parse(raw) → validate
3. Check proposal.deadline > Math.floor(Date.now() / 1000) → drop if expired
4. EXISTS nullifier:{reasoningHash} → drop if already processed (replay)
5. randomUUID() → proposalId
6. HMAC-SHA256(proposalId, HMAC_SECRET) → hmacHex → hexToBase64url → hmacB64url
7. Redis pipeline (atomic):
     SET proposal:{id}         JSON  EX ttlSeconds
     SET proposal:{id}:status  "pending"  EX ttlSeconds+120
     SET nullifier:{hash}      "1"        (no TTL — permanent)
     INCR bot:signal_count
```

**HMAC encoding for Telegram URL:**
```typescript
computeHmac(proposalId: string): string
  // createHmac("sha256", HMAC_SECRET).update(proposalId).digest("hex")
  // Same algorithm as BFF — BFF can verify with timingSafeEqual

hexToBase64url(hex: string): string
  // Buffer.from(hex, "hex").toString("base64")
  //   .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  // RFC 4648 §5 — URL-safe, no padding
  // Telegram truncates/breaks "=" padding in startapp parameter
```

**TeeProposalSchema (Zod):**
```typescript
z.object({
  asset:             z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  assetSymbol:       z.string().min(1).max(20),
  action:            z.enum(["BUY", "SELL"]),
  recommendedAmount: z.string().regex(/^\d+$/),   // bigint as string
  nonce:             z.number().int().nonnegative(),
  deadline:          z.number().int().positive(),
  reasoningHash:     z.string().regex(/^0x[a-fA-F0-9]{64}$/),  // bytes32
  signature:         z.string().regex(/^0x[a-fA-F0-9]{130}$/), // 65-byte ECDSA
  signerAddress:     z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  generatedAt:       z.number().int().positive(),
  priceAtGeneration: z.string().optional(),
  maxSlippageBps:    z.number().int().min(0).max(10000).optional(),
})
```

### Bot Entry Point (`src/tg-bot/index.ts`)

**Whitelist middleware (security invariant):**
```typescript
bot.use(async (ctx, next) => {
  if (ctx.chat?.id !== TARGET_CHAT_ID) {
    // Silent drop — no reply, no acknowledgement
    // Does NOT call next() → downstream handlers never run
    return
  }
  return next()
})
```

**Commands:**

| Command | Redis operation | Response |
|---------|----------------|----------|
| `/start` | none | Welcome message + command list |
| `/status` | PING + GET bot:paused + GET bot:signal_count | Redis latency + state + counter |
| `/pause` | SET bot:paused "1" | Confirmation message |
| `/resume` | DEL bot:paused | Confirmation message |
| `/help` | none | Command reference |

**Broadcast message format:**
```
⚡ AlphaFlow TEE Signal
━━━━━━━━━━━━━━━━━━━━
🟢 Action:   `LONG / BUY`
💎 Asset:    `WMNT`
   `0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8`
💰 Volume:   `250.0 tokens`
🛡 Slippage: `2.00%`
⏱ Expires:  `14m 30s`
━━━━━━━━━━━━━━━━━━━━
🔐 Proof-of-Reasoning:
`0x1a2b3c4d5e...8f9a0b1c`

_Signed by TEE Signer: 0x742d35Cc..._

[ 🟢 Execute via Passkey ]   ← WebApp inline button
```

**Deep link URL construction:**
```typescript
const startappParam = `${proposalId}_${hmacB64url}`
// e.g.: "550e8400-e29b-41d4-a716-446655440000_dGhpcyBpcyBhIHRlc3Q"

const webAppUrl = `https://t.me/${BOT_USERNAME}/app?startapp=${startappParam}`

Markup.button.webApp("🟢 Execute via Passkey", webAppUrl)
// Telegram opens TMA with window.Telegram.WebApp.initDataUnsafe.start_param
// = "550e8400-e29b-41d4-a716-446655440000_dGhpcyBpcyBhIHRlc3Q"
```

---

## 7. End-to-End Data Flow

### Full Proposal Lifecycle

```
TEE Agent (Phala CVM)
  │
  │  1. Nansen MCP: detect Smart Money signal
  │     GET /nansen/wallets?tag=Fund&asset=WMNT&action=BUY
  │
  │  2. YieldArchitect.calculateVolume(signal, profile)
  │     S_user = V_user × (S_smart/V_smart) × K_risk
  │
  │  3. YieldArchitect.generateProposal(signal, profile)
  │     reasoningHash = keccak256(abi.encode(9 fields))
  │     EIP-712 sign → SignedProposal
  │
  │  4. Redis PUBLISH "tee_proposals" (JSON)
  │
  ▼
Redis Pub/Sub Channel: "tee_proposals"
  │
  ▼
TG Bot (devops/src/tg-bot/index.ts)
  │
  │  5. subscriber.on("message") fires
  │
  │  6. proposalStore.storeProposal(raw):
  │     - Check bot:paused flag
  │     - Zod validate
  │     - Check deadline > now
  │     - EXISTS nullifier:{reasoningHash} → reject if replay
  │     - Generate UUID proposalId
  │     - HMAC-SHA256(proposalId) → hmacHex → hmacB64url
  │     - Redis pipeline: SET proposal + status + nullifier + INCR counter
  │
  │  7. broadcastProposal(stored, proposalId, hmacB64url, ttl)
  │     - Format message (action, asset, volume, slippage, expiry)
  │     - Build deep link: startapp={proposalId}_{hmacB64url}
  │     - bot.telegram.sendMessage(TARGET_CHAT_ID, message, { inlineKeyboard })
  │
  ▼
Telegram User Chat
  │
  │  8. User sees proposal notification + [Execute via Passkey] button
  │  9. User taps button → Telegram opens TMA WebView
  │
  ▼
TMA Frontend (frontend/)
  │
  │  10. App.tsx: Telegram.WebApp.ready() + expand()
  │      Parse startapp → proposalId + hmacHex (base64url → hex)
  │
  │  11. InvestFlowApp: status = "verifying"
  │      bffClient.fetchProposal(proposalId, hmacHex)
  │
  ▼
BFF API Server (bff/)
  │
  │  12. GET /api/proposal/:id
  │      x-hmac-signature: <hmacHex>
  │
  │  13. verifyHmac(proposalId, hmacHex)  ← timingSafeEqual
  │
  │  14. getAndLockProposal(proposalId):
  │      GET proposal:{id} from Redis
  │      Check status != "consumed" | "expired"
  │      SETNX proposal:{id}:lock "1" EX 60  ← optimistic lock
  │      SET proposal:{id}:status "dispensed"
  │
  │  15. checkPriceStaleness(asset, maxSlippagePct):
  │      eth_call → UniV3 slot0 (or UniV2 getReserves fallback)
  │      Compare current price vs proposal.priceAtGeneration
  │      deviation > maxSlippagePct → 409 Conflict
  │
  │  16. Return { proposal, eip712Payload, domain, ttlSeconds }
  │
  ▼
TMA Frontend (continued)
  │
  │  17. status = "ready" — display trade details
  │
  │  18. User clicks "Execute" → executionLockRef.current = true (permanent)
  │      status = "signing"
  │
  │  19. useWebAuthn: check WebAuthn support
  │      If Telegram WebView blocks → show "Open in External Browser" button
  │      Else → proceed
  │
  │  20. ZeroDev SDK (lazy import):
  │      toWebAuthnKey → toPasskeyValidator → createKernelAccount
  │      createKernelAccountClient (bundler + paymaster)
  │      status = "executing"
  │
  │  21. kernelClient.sendUserOperation({ callData })
  │      → Pimlico bundler (private, MEV-protected)
  │      → EntryPoint v0.7 → Kernel v3 → ActiveSentinel.executeFlashArbitrage
  │
  ▼
Mantle Network (Chain ID: 5000)
  │
  │  22. On-chain execution:
  │      INIT Capital flashBorrow → Merchant Moe swap → Agni Finance swap
  │      → repay → invariant check → profit to Kernel account
  │
  ▼
TMA Frontend (receipt)
  │
  │  23. waitForUserOperationReceipt({ hash: userOpHash })
  │      status = "success"
  │
  │  24. bffClient.consumeProposal(proposalId, hmacHex)
  │
  ▼
BFF API Server
  │
  │  25. POST /api/proposal/:id/consume
  │      consumeProposal(id):
  │      Redis pipeline:
  │        SET nullifier:{reasoningHash} "consumed"  (upgrade existing)
  │        SET proposal:{id}:status "consumed"
  │        DEL proposal:{id}:lock
  │
  └── DONE
```

---

## 8. Redis Key Schema

All keys follow the same convention across TG Bot and BFF for cross-service compatibility.

| Key pattern | Type | TTL | Owner | Purpose |
|-------------|------|-----|-------|---------|
| `proposal:{id}` | String (JSON) | ttl_seconds | TG Bot write, BFF read | Full StoredProposal |
| `proposal:{id}:status` | String | ttl+120s | TG Bot write, BFF update | FSM state |
| `proposal:{id}:lock` | String | 60s | BFF | Optimistic lock (prevents race) |
| `nullifier:{reasoningHash}` | String | **none** | TG Bot write, BFF write | Permanent anti-replay |
| `bot:paused` | String | **none** | TG Bot | Pause flag (exists="1" or absent) |
| `bot:signal_count` | String | **none** | TG Bot | INCR counter for /status |

**Proposal status FSM:**
```
pending → dispensed → consumed
       ↘           ↗
         (TTL expiry: auto-deleted from Redis — treated as "expired")
```

**Nullifier lifecycle:**
```
Not set                    → proposal not yet seen
"1"    (permanent)         → proposal received, not yet consumed
"consumed" (or "1")        → proposal fully executed
```

---

## 9. Security Invariants

These are non-negotiable properties enforced at the code level.

### 1. No secrets on client (frontend)
```
HMAC_SECRET  → only in BFF process.env, never in API response
BOT_TOKEN    → only in devops process.env
Private keys → only in TEE memory (Wallet.createRandom(), never exported)
```

### 2. Timing-safe HMAC comparison (BFF)
```typescript
// WRONG (vulnerable to timing oracle):
clientHmac === serverHmac

// CORRECT:
timingSafeEqual(
  Buffer.from(serverHmac, "hex"),  // fixed-length
  Buffer.from(clientHmac, "hex")   // fixed-length
)
// Returns false on length mismatch (no throw = no timing difference)
```

### 3. Price source: on-chain only (BFF)
```
Staleness check reads from: eth_call → slot0/getReserves
NOT from:                   request body, query params, headers
Reasoning: prevents frontend from spoofing price to bypass slippage check
```

### 4. Replay prevention: 3-layer defense
```
Layer 1: nonce       (monotonic per-signer, on-chain)
Layer 2: deadline    (proposal auto-expires, Redis TTL)
Layer 3: nullifier   (reasoningHash → permanent Redis key, never deleted)
```

### 5. Telegram whitelist: silent drop
```typescript
if (ctx.chat?.id !== TARGET_CHAT_ID) return  // no reply
// Reasoning: replying reveals bot existence to attackers
```

### 6. Anti-double-execution (frontend)
```typescript
executionLockRef.current = true  // set once, never reset
// useRef (not useState) — synchronous, no re-render race
```

### 7. Optimistic lock: auto-revert (BFF)
```
SETNX proposal:{id}:lock "1" EX 60
If TMA crashes after lock but before /consume:
  → lock expires after 60s
  → proposal status rolls back to "pending" (or TTL expires)
  → user can retry (new WebApp click)
```

### 8. TEE key isolation (agent-tee)
```typescript
const wallet = Wallet.createRandom()  // HDNodeWallet
// wallet.privateKey is NEVER:
//   - logged (console.log, debug output)
//   - persisted (Redis, filesystem, env)
//   - sent over network (RPC call, WebSocket)
//   - included in any log object spread
```

---

## 10. Environment Variables

### `bff/.env`
```bash
HMAC_SECRET=<32+ random bytes, hex>   # shared with devops bot
REDIS_URL=redis://localhost:6379
PRIMARY_RPC_URL=https://rpc.ankr.com/mantle/<key>
FALLBACK_RPC_URL_1=https://rpc.mantle.xyz
FALLBACK_RPC_URL_2=https://mantle.publicnode.com
PORT=3001
```

### `devops/.env`
```bash
BOT_TOKEN=<Telegram BotFather token>
TARGET_CHAT_ID=<your Telegram chat/user ID>
HMAC_SECRET=<same as BFF>             # must match exactly
REDIS_URL=redis://localhost:6379
TMA_URL=https://t.me/AlphaFlowBot/app
BOT_USERNAME=AlphaFlowBot
```

### `agent-tee/.env`
```bash
REDIS_URL=redis://localhost:6379
NANSEN_API_KEY=<Nansen API key>
MANTLE_RPC_URL=https://rpc.mantle.xyz
SENTINEL_CONTRACT=<deployed ActiveSentinel address>
CHAIN_ID=5000
PORT=8080
```

### `frontend/.env`
```bash
VITE_BFF_URL=https://api.alphaflow.xyz
VITE_ZERODEV_PROJECT_ID=<ZeroDev project ID>
VITE_BUNDLER_URL=https://rpc.zerodev.app/api/v2/bundler/<id>
VITE_PAYMASTER_URL=https://rpc.zerodev.app/api/v2/paymaster/<id>
VITE_SENTINEL_ADDRESS=<deployed ActiveSentinel address>
```

---

## 11. Running Locally

### Prerequisites
- Node.js ≥ 20
- Docker + Docker Compose
- Foundry (`curl -L https://foundry.paradigm.xyz | bash`)

### 1. Clone and install
```bash
git clone https://github.com/rocknrolla77/alphaflow-suite
cd alphaflow-suite

# Install all modules
(cd agent-tee && npm install)
(cd bff        && npm install)
(cd frontend   && npm install --legacy-peer-deps)
(cd devops     && npm install)
```

### 2. Start infrastructure
```bash
docker compose up -d redis
# Redis available at localhost:6379 (AOF persistence enabled)
```

### 3. Run BFF
```bash
cd bff
cp .env.example .env   # fill in HMAC_SECRET + RPC URLs
npm run dev            # tsx watch src/index.ts → port 3001
```

### 4. Run TG Bot
```bash
cd devops
cp .env.example .env   # fill in BOT_TOKEN + TARGET_CHAT_ID + HMAC_SECRET
npm run dev            # tsx watch src/tg-bot/index.ts
```

### 5. Run TEE Agent (dev mode, no Phala)
```bash
cd agent-tee
cp .env.example .env
npm run dev            # tsx watch src/main.ts → port 8080
```

### 6. Run Frontend
```bash
cd frontend
cp .env.example .env   # fill in VITE_BFF_URL + VITE_ZERODEV_PROJECT_ID
npm run dev            # vite dev server → port 5173
```

### 7. Build contracts
```bash
cd contracts
forge build
forge test -vvv       # run Foundry tests including fuzz
```

### Type-check all modules
```bash
(cd agent-tee && npx tsc --noEmit)   # 0 errors
(cd bff        && npx tsc --noEmit)  # 0 errors
(cd devops     && npx tsc --noEmit)  # 0 errors
(cd frontend   && npx tsc --noEmit)  # 0 errors
```

### Vite production build
```bash
cd frontend
node node_modules/vite/bin/vite.js build
# ✓ 1469 modules transformed
# dist/ ready (~1.09 MB total, ~281 KB gzip)
```

---

## Addresses (Mantle Mainnet)

| Contract | Address |
|----------|---------|
| INIT Capital Core | `0xa0CBDe3C3e99A6E232Ce90E68c2B27e60A2fC5b8` |
| Merchant Moe Router | `0xeaEE7EE68874218c3558b40063c42B82D3E7232a` |
| Agni Finance Router | `0x319B69888b0d11cEC22caA5034e25FfFBDc88421` |
| ZeroDev EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| WMNT | `0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8` |
| USDC (Mantle) | `0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9` |

---

*AlphaFlow Suite — Winner, DoraHacks Mantle Hackathon*
*Built on: Mantle Network × Phala TEE × ZeroDev × Nansen MCP*
*Repo: github.com/rocknrolla77/alphaflow-suite*
