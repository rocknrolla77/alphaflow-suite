# AlphaFlow Suite — Полная Техническая Документация

> **Agentic Commerce Infrastructure on Mantle Network**
> 🏆 Победитель DoraHacks Mantle Hackathon
> Flash-арбитраж с AI-агентом в TEE + Human-in-the-Loop UX

**Версия документа:** 2026-05-21
**Репозиторий:** github.com/rocknrolla77/alphaflow-suite
**Лицензия:** MIT

---

## Оглавление

1. [Миссия и Проблема](#1-миссия-и-проблема)
2. [Архитектура высокого уровня](#2-архитектура-высокого-уровня)
3. [Модуль 1: Smart Contracts (contracts/)](#3-модуль-1-smart-contracts)
4. [Модуль 2: TEE Agent (agent-tee/)](#4-модуль-2-tee-agent)
5. [Модуль 3: Backend-for-Frontend (bff/)](#5-модуль-3-backend-for-frontend)
6. [Модуль 4: Telegram Mini App (frontend/)](#6-модуль-4-telegram-mini-app)
7. [Модуль 5: HITL Telegram Bot (devops/src/tg-bot/)](#7-модуль-5-hitl-telegram-bot)
8. [Сквозной поток данных (End-to-End)](#8-сквозной-поток-данных)
9. [Безопасность: модель угроз и защита](#9-безопасность)
10. [Redis — схема ключей и FSM](#10-redis-схема-ключей)
11. [Account Abstraction (ZeroDev)](#11-account-abstraction)
12. [Инфраструктура и DevOps](#12-инфраструктура-и-devops)
13. [CI/CD Pipeline](#13-cicd-pipeline)
14. [Конфигурация и переменные окружения](#14-конфигурация)
15. [Структура монорепозитория](#15-структура-монорепозитория)
16. [Технологический стек (полный)](#16-технологический-стек)
17. [Конкурентные преимущества](#17-конкурентные-преимущества)
18. [Roadmap](#18-roadmap)

---

## 1. Миссия и Проблема

### Проблемы розничных инвесторов в DeFi

1. **Информационная асимметрия** — Smart Money (VC-фонды, институциональные трейдеры, "90D Smart Traders") видят возможности раньше розницы. У обычного пользователя нет доступа к данным Nansen/Arkham в реальном времени.

2. **Скорость исполнения** — Flash-арбитраж требует атомарного исполнения в пределах одного блока (~2 секунды на Mantle). Ручная торговля невозможна на таких скоростях.

3. **MEV-уязвимость** — Публичный мемпул позволяет MEV-ботам строить sandwich attacks. Каждая pending-транзакция розничного трейдера — потенциальная жертва.

4. **Кастодиальность** — Существующие торговые боты (3Commas, Maestro, Banana Gun) требуют передачи приватного ключа или API-key. Это создаёт единую точку отказа.

### Решение AlphaFlow Suite

| Проблема | Решение AlphaFlow | Механизм |
|----------|-------------------|-----------|
| Информационная асимметрия | Nansen MCP в TEE | AI-агент анализирует Smart Money в реальном времени |
| Скорость | Атомарный flash-арбитраж | ActiveSentinel.sol: borrow→swap→swap→repay в 1 tx |
| MEV | Приватный мемпул | Pimlico Private Bundler (ERC-4337) |
| Кастодиальность | Non-custodial | Ключ в TEE (in-memory), Passkeys для владельца |
| Доверие к AI | Proof-of-Reasoning | EIP-712 подпись + SGX Remote Attestation |
| Контроль | Human-in-the-Loop | Telegram Mini App для approve/reject |

**Ключевой принцип:** розничный инвестор получает стратегии институционального уровня, сохраняя полный контроль над средствами через Telegram.

---

## 2. Архитектура высокого уровня

```
┌─────────────────────────────────────────────────────────────────────┐
│                        MANTLE NETWORK (L2, Chain ID 5000)           │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  ActiveSentinel.sol                                          │   │
│  │  ┌──────────────────────────────────────────────────────┐   │   │
│  │  │ TransientReentrancyGuard (EIP-1153 TSTORE/TLOAD)     │   │   │
│  │  └──────────────────────────────────────────────────────┘   │   │
│  │  executeFlashArbitrage(ArbParams) → nonReentrant            │   │
│  │    1. flashBorrow(INIT Capital) ─────────────────────┐      │   │
│  │    2. onFlashBorrow callback:                         │      │   │
│  │       ├── Swap A→B (Merchant Moe / dexRouterA)       │      │   │
│  │       ├── Swap B→A (Agni Finance / dexRouterB)       │      │   │
│  │       └── repay(amount + fee) → INIT Capital ────────┘      │   │
│  │    3. INVARIANT: balanceAfter - balanceBefore >= minProfit   │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
        ▲ UserOperation (EIP-4337, gasless via ZeroDev Paymaster)
        │
┌───────┴────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Frontend TMA  │◄───►│    BFF (Hono)    │◄───►│   Redis 7        │
│  React 18      │     │                  │     │                  │
│  Vite 5        │     │  • HMAC verify   │     │  • Pub/Sub       │
│  ZeroDev v5.5  │     │  • Staleness     │     │  • State store   │
│  Passkeys      │     │  • Opt. lock     │     │  • Nullifiers    │
│  WebAuthn      │     │  • Nullifier     │     │  • TTL-based     │
└────────────────┘     └──────────────────┘     └───────┬──────────┘
        ▲                                               │
        │ Telegram WebApp SDK                           │ SUBSCRIBE
        │ startapp={proposalId}_{hmacBase64url}         │ channel: tee_proposals
        │                                               ▼
┌───────┴────────┐                              ┌──────────────────┐
│  Telegram Bot  │◄─── Redis Pub/Sub ───────────│   TEE Agent      │
│  (Telegraf v4) │                              │  (Phala CVM)     │
│                │                              │                  │
│  • Whitelist   │                              │  • YieldArchitect│
│  • HMAC gen    │                              │  • Nansen MCP    │
│  • Inline KB   │                              │  • EIP-712 sign  │
│  • /status     │                              │  • Attestation   │
│  • /pause      │                              │  • 2D Nonces     │
│  • /resume     │                              │  • MEV protect   │
└────────────────┘                              └──────────────────┘
```

### Потоки данных (4 основных):

1. **TEE → Bot:** Redis PUBLISH `tee_proposals` — подписанный proposal с attestation
2. **Bot → TMA:** Inline Button с deep link `t.me/bot?startapp={id}_{hmac}`
3. **TMA → BFF:** REST API с header `x-hmac-signature` (HMAC из deep link)
4. **BFF → Mantle:** UserOperation через ZeroDev Bundler + Paymaster

---

## 3. Модуль 1: Smart Contracts

**Путь:** `contracts/`
**Solidity:** 0.8.24 (требуется Cancun EVM для EIP-1153)
**Framework:** Foundry (forge, cast, anvil)
**Библиотеки:** OpenZeppelin Contracts (git submodule)

### 3.1 ActiveSentinel.sol — Основной контракт

```solidity
contract ActiveSentinel is TransientReentrancyGuard, IFlashBorrower {
    address public immutable owner;       // ZeroDev Kernel account или EOA
    address public immutable initCore;    // INIT Capital flash loan provider
    address public immutable dexRouterA;  // Merchant Moe router
    address public immutable dexRouterB;  // Agni Finance router
}
```

**Функции:**

| Функция | Видимость | Модификаторы | Описание |
|---------|-----------|--------------|----------|
| `executeFlashArbitrage(ArbParams)` | external | nonReentrant | Точка входа: инициирует flash borrow |
| `onFlashBorrow(initiator, token, amount, fee, data)` | external | — | Callback от INIT Capital: swap A→B→A, repay |
| `rescue(token, amount)` | external | onlyOwner | Извлечение застрявших токенов (dust) |
| `rescueNative()` | external | onlyOwner | Извлечение нативного MNT |

**ArbParams структура:**

```solidity
struct ArbParams {
    address tokenA;              // Базовый токен (borrow + profit)
    address tokenB;              // Промежуточный токен
    uint256 borrowAmount;        // Flash borrow amount
    uint256 minProfitTokenA;     // Min profit (revert если не достигнут)
    uint256 amountOutMinRoute1;  // Slippage: swap A→B
    uint256 amountOutMinRoute2;  // Slippage: swap B→A
    bytes dexPayloadRoute1;      // Encoded swap data (Merchant Moe)
    bytes dexPayloadRoute2;      // Encoded swap data (Agni Finance)
}
```

**Инварианты безопасности:**

1. `msg.sender == owner` — только владелец (ZeroDev Kernel)
2. `borrowAmount > 0` — защита от zero-amount griefing
3. `balanceAfter - balanceBefore >= minProfitTokenA` — profit invariant (atomic revert)
4. `initiator == address(this)` — в callback: только self-initiated borrow
5. `msg.sender == initCore` — в callback: только INIT Capital вызывает

**Паттерн CEI (Checks-Effects-Interactions):**
- Checks: auth + zero amount
- Effects: balance snapshot (balanceBefore)
- Interactions: flashBorrow → callback → swaps → repay
- Post-checks: profit invariant (после возврата управления)

### 3.2 TransientReentrancyGuard.sol

Кастомная реализация reentrancy guard на базе EIP-1153 (Transient Storage, Cancun EVM):

```solidity
abstract contract TransientReentrancyGuard {
    // Slot: keccak256("alphaflow.sentinel.reentrancy.lock") - 1
    bytes32 private constant _LOCK_SLOT = 0x8b1a944cf13a9a1c08facb1f3de33a0e0c40e06ee15c5e8a12ef28645c0d69a5;

    modifier nonReentrant() {
        assembly {
            if tload(_LOCK_SLOT) {
                mstore(0x00, 0x01336cea...)  // ReentrancyAttempt()
                revert(0x00, 0x04)
            }
            tstore(_LOCK_SLOT, 1)
        }
        _;
        assembly {
            tstore(_LOCK_SLOT, 0)
        }
    }
}
```

**Преимущества перед OpenZeppelin ReentrancyGuard:**

| Аспект | OZ (SSTORE) | AlphaFlow (TSTORE) |
|--------|-------------|---------------------|
| Gas (set) | ~5,000 (cold) / ~100 (warm) | ~100 (всегда) |
| Gas (reset) | ~100 (refund) | ~100 |
| Персистентность | Между tx | Только текущий tx |
| Auto-cleanup | Нет (ручной reset) | Да (EVM гарантия) |
| Mantle support | Да | Да (Cancun EVM) |

### 3.3 Интерфейсы

- **IINITCore.sol** — INIT Capital flash borrow: `flashBorrow(token, amount, data)`
- **IFlashBorrower.sol** — Callback: `onFlashBorrow(initiator, token, amount, fee, data) → bytes32`
- **IDexRouter.sol** — Unified DEX: `swap(tokenIn, tokenOut, amountIn, amountOutMin, payload) → uint256`

### 3.4 Deployment Script

```solidity
// script/Deploy.s.sol
contract DeployActiveSentinel is Script {
    function run() external {
        vm.broadcast();
        new ActiveSentinel(INIT_CORE, DEX_ROUTER_A, DEX_ROUTER_B);
    }
}
```

### 3.5 Тесты

**`test/ActiveSentinel.t.sol`:**
- Fuzz testing параметров арбитража
- Mock DEX routers (контролируемые exchange rates)
- Mock INIT Core (flash borrow simulation)
- Reentrancy attack simulation (MaliciousDexRouter)
- Edge cases: zero amounts, insufficient profit, callback auth

---

## 4. Модуль 2: TEE Agent

**Путь:** `agent-tee/`
**Runtime:** Node.js 20 в Phala Network CVM (Confidential Virtual Machine)
**Стек:** TypeScript, ethers v6, ioredis

### 4.1 main.ts — Entry Point

При запуске TEE-агент:

1. **Генерация ключа:**
   ```typescript
   const wallet: HDNodeWallet = Wallet.createRandom();
   // ВАЖНО: ethers v6 возвращает HDNodeWallet, НЕ Wallet
   // wallet.privateKey — NEVER logged, persisted, or transmitted
   ```

2. **Health server** (порт 8080):
   ```json
   GET /health → { "teeSignerAddress": "0x...", "uptime": 12345 }
   ```
   Экспортирует ТОЛЬКО публичный адрес. Приватный ключ существует только в RAM.

3. **Инициализация сервисов:**
   - Redis client (ioredis)
   - NansenMCPClient
   - MevProtectionService
   - PaymasterRateLimiter
   - SessionKeyRotator
   - PhalaAttestationService
   - ProposalPublisher

4. **Цикл стратегии** (polling interval: configurable)

### 4.2 strategies/yieldArchitect.ts — Стратегия

**YieldArchitect** — алгоритм формирования торговых рекомендаций:

**Формула Conviction Weight:**
```
W = S_smart / V_smart
```
Где:
- `S_smart` — объём сделки Smart Money (в USD)
- `V_smart` — общий портфель Smart Money (в USD)

**Risk Normalization:**
```
S_user = V_user × W × K_risk
```
Где:
- `V_user` — доступный баланс пользователя
- `K_risk` — коэффициент риска [0.1 .. 1.0]
- `S_user` — рекомендуемый объём для пользователя

**Reasoning Hash (Proof-of-Reasoning):**
```typescript
reasoningHash = keccak256(
    abi.encode(signal.sourceTxHash, signal.asset, signal.tradeVolume,
               profile.accountAddress, profile.riskCoefficient, timestamp)
)
```
Этот хэш встраивается в EIP-712 подпись — криптографическое доказательство, что
рекомендация вычислена на основе конкретных входных данных.

**EIP-712 Domain Separator:**
```typescript
{
    name: "AlphaFlow",
    version: "1",
    chainId: 5000,  // Mantle mainnet
    verifyingContract: ACTIVE_SENTINEL_ADDRESS
}
```

**EIP-712 Types:**
```typescript
{
    Proposal: [
        { name: "asset", type: "address" },
        { name: "action", type: "string" },
        { name: "recommendedAmount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "reasoningHash", type: "bytes32" }
    ]
}
```

### 4.3 services/nansenClient.ts — Nansen MCP

Взаимодействие с Nansen через Model Context Protocol:

**Методы:**
- `getSmartMoneyWallets(tags, minBalanceUsd)` — Smart Money wallets по фильтру
- `getRecentTransactions(wallets, sinceTimestamp, minAmountUsd)` — последние tx
- `getTokenFlows(tokenAddress, timeframeHours)` — потоки капитала

**Rate Limiting:** 25 req/min, exponential backoff (1s, 2s, 4s, 8s, max 16s)

**Nansen Tags используемые:**
- `"Fund"` — институциональные фонды
- `"VC"` — венчурные фонды
- `"90D Smart Trader"` — прибыльные трейдеры (90-дневная метрика)

### 4.4 services/mevProtection.ts

Маршрутизация UserOps через приватные bundler endpoints:

**Приоритет:**
1. Pimlico Private Bundler (ERC-4337 native, primary)
2. Alchemy Private Bundler (fallback)
3. Public bundler (last resort, vulnerable to MEV)

**Health check:** `eth_supportedEntryPoints` с 3s timeout
**Gas validation:** `maxPriorityFeePerGas <= configMaxPriorityFeeGwei` (защита от gas price manipulation)

### 4.5 services/rateLimiter.ts — PaymasterRateLimiter

Защита Gas Vault (10 MNT) от drain:

| Политика | Значение | Описание |
|----------|----------|----------|
| maxOpsPerMinute | 5 | Жёсткий лимит частоты |
| maxOpsPerHour | 30 | Burst protection |
| revertCooldownSec | 30 | Пауза после revert |
| consecutiveRevertLimit | 3 | N reverts подряд → блокировка |
| blockDurationMs | 900,000 | 15 минут блокировки |

**Sliding window:** массив `OpRecord[]` с pruning записей старше 1 часа.

### 4.6 services/remoteAttestation.ts — SGX/TDX Attestation

Интеграция с Phala DStack для генерации Remote Attestation:

```typescript
// Endpoint внутри CVM:
POST http://localhost:8090/prpc/Phala.GetRemoteAttestation
Body: { "report_data": "<128 hex chars>" }
```

**Report Data:** `keccak256(proposalHash || teeSignerAddress)` (64 bytes)

**Возвращает:**
- `rawQuote` — SGX Quote v3 (hex)
- `mrenclave` — хэш кода анклава
- `mrsigner` — хэш подписанта анклава
- `platform` — "sgx" | "tdx" | "sev"

**Назначение:** on-chain/off-chain верификация того, что proposal создан внутри
настоящего TEE-анклава с немодифицированным кодом.

### 4.7 services/sessionKeyRotator.ts

Упреждающая ротация ZeroDev Session Keys:

**Алгоритм:**
1. Каждые `checkIntervalMs` (default: 60s) проверяет: `now > validUntil - preRotationBufferSec`?
2. Если да → вызывает `onRotationNeeded` (запрос подписи от владельца)
3. Новый ключ активируется, старый работает до `validUntil` (grace period)
4. При `now > validUntil - 60s` → **DEAD ZONE** — все операции приостановлены

**Fail-safe:** до 3 попыток ротации, после — логирование ошибки, агент работает
со старым ключом до полного истечения.

### 4.8 services/proposalPublisher.ts

Публикация в Redis:
- Channel: `tee_proposals`
- Формат: JSON с полями proposal + nonce + deadline + proofOfReasoning + priceAtGeneration
- Nonce: монотонный счётчик (невозможно reset извне TEE)
- Deadline: `timestamp + defaultDeadlineOffsetSec` (default: 300s)

### 4.9 executor.ts — SentinelExecutor

Кодирование calldata для ActiveSentinel + 2D Nonces:

**2D Nonce Format (ERC-4337):**
```typescript
// key: sessionId (192 bits) | sequence: (64 bits)
nonceKey = BigInt(sessionId) << 64n | sequenceNumber
```

Предотвращает replay: даже если UserOp перехвачен, он привязан к конкретному
(sessionId, sequence) и не может быть повторно отправлен.

### 4.10 types/index.ts — Domain Types

```typescript
interface SmartMoneySignal {
    walletAddress: string;        // Checksummed 0x...
    walletTag: string;            // "Fund", "VC", "90D Smart Trader"
    reputationScore: number;      // [0.0 - 1.0]
    asset: string;                // ERC-20 address
    assetSymbol: string;          // "WMNT", "USDC", "FBTC"
    action: "BUY" | "SELL";
    tradeVolume: bigint;          // In token decimals
    totalPortfolioValue: bigint;  // USD-normalized
    detectedAt: number;           // Unix timestamp
    sourceTxHash: string;
}

interface UserRiskProfile {
    accountAddress: string;       // ZeroDev Kernel address
    availableBalance: bigint;
    riskCoefficient: number;      // [0.1 - 1.0]
    maxSlippageBps: number;       // 100 = 1%
    minProfitThreshold: bigint;
}

interface Proposal {
    asset: string;
    action: string;
    recommendedAmount: bigint;
    nonce: number;                // Monotonic (TEE-internal)
    deadline: number;             // Unix timestamp expiry
    reasoningHash: string;        // keccak256(inputs)
}

interface SignedProposal extends Proposal {
    signature: string;            // EIP-712 (r + s + v, 65 bytes hex)
    teeSignerAddress: string;
    attestationQuote?: string;    // SGX Quote (optional, for high-value)
}

interface AgentConfig {
    redisUrl: string;
    nansenApiKey: string;
    nansenApiUrl: string;
    mantleRpcUrl: string;
    activeSentinelAddress: string;
    dstackEndpoint: string;
}

interface RateLimitConfig {
    maxOpsPerMinute: number;
    maxOpsPerHour: number;
    revertCooldownSec: number;
}
```

---

## 5. Модуль 3: Backend-for-Frontend

**Путь:** `bff/`
**Framework:** Hono (lightweight, ~14KB, edge-compatible)
**Runtime:** Node.js 20
**Порт:** 3001

### 5.1 index.ts — API Server

**Endpoints:**

| Method | Path | Auth | Описание |
|--------|------|------|----------|
| GET | `/api/health` | — | Healthcheck (Redis ping + uptime) |
| GET | `/api/proposal/:id` | HMAC | Получить proposal (JSON) |
| POST | `/api/proposal/:id/approve` | HMAC | Lock + staleness check |
| POST | `/api/proposal/:id/reject` | HMAC | Отклонить proposal |
| POST | `/api/proposal/:id/consume` | HMAC | Burn nullifier (после execution) |

**Middleware stack:**
1. CORS (origin: `TMA_ORIGIN` env, default: `http://localhost:5173`)
2. Request ID injection
3. HMAC verification (timing-safe)
4. Zod request validation

### 5.2 services/proposalService.ts — HMAC + Optimistic Lock

**HMAC Verification:**
```typescript
function verifyHmac(proposalId: string, clientSignature: string): boolean {
    const serverHmac = createHmac("sha256", HMAC_SECRET)
        .update(proposalId, "utf8")
        .digest("hex");

    // Timing-safe comparison (prevents timing oracle attack)
    const a = Buffer.from(serverHmac, "hex");
    const b = Buffer.from(clientSignature, "hex");

    if (a.length !== b.length) return false;  // Length check = no throw = no timing diff
    return timingSafeEqual(a, b);
}
```

**Optimistic Lock Flow:**
```
1. SETNX proposal:{id}:lock "1" EX 60     → if exists → 409 Conflict
2. Staleness check (on-chain price)         → if stale → DEL lock + 422
3. Nullifier check (not already consumed)   → if consumed → 409
4. Return proposal + EIP-712 payload        → 200 OK
5. (TMA executes UserOp)
6. POST /consume → SET nullifier:{hash} "consumed" + DEL lock
```

**Fallback:** если TMA crashes после lock но до /consume:
- Lock expires (60s TTL)
- Proposal возвращается в `pending`
- Пользователь может retry (новый клик по кнопке)

### 5.3 services/onChainOracle.ts — Staleness Detection

**Viem Client с Multi-RPC Fallback:**
```typescript
const client = createPublicClient({
    chain: mantle,
    transport: fallback([
        http(RPC_PRIMARY, { timeout: 10_000, retryCount: 2 }),
        http(RPC_FALLBACK_1, { timeout: 15_000, retryCount: 2 }),
        http(RPC_FALLBACK_2, { timeout: 15_000, retryCount: 1 }),
    ], { rank: true })  // Auto-reranking by latency
});
```

**Проверка актуальности цены:**
```typescript
async function checkStaleness(
    poolAddress: Address,
    priceAtGeneration: number,
    maxStalePct: number
): Promise<PriceCheckResult> {
    // Читаем on-chain: slot0 (concentrated) или getReserves (AMM)
    const currentPrice = await readPoolPrice(poolAddress);
    const deviationBps = Math.abs(currentPrice - priceAtGeneration)
        / priceAtGeneration * 10000;
    return {
        currentPrice,
        deviationBps,
        isStale: deviationBps > maxStalePct * 100,
        checkedAt: Date.now()
    };
}
```

**КРИТИЧНО:** цена ВСЕГДА берётся on-chain (eth_call), НИКОГДА из request body.
Предотвращает Frontend Oracle Spoofing.

---

## 6. Модуль 4: Telegram Mini App

**Путь:** `frontend/`
**Framework:** React 18 + Vite 5
**Deploy:** Static hosting (Telegram WebApp)
**Bundle:** Code-split (vendor, web3, p256, native — раздельные chunks)

### 6.1 App.tsx — Root

Парсинг Telegram `startapp` параметра:
```typescript
// Format: {proposalId}_{hmacBase64url}
const [proposalId, hmacBase64url] = window.Telegram.WebApp.initDataUnsafe
    .start_param.split("_");
const hmacHex = base64urlToHex(hmacBase64url);
```

### 6.2 components/InvestFlowApp.tsx — Основной UI

Пошаговый flow (state machine):

```
LOADING → REVIEW → APPROVE → EXECUTING → RESULT
    ↓         ↓        ↓          ↓          ↓
  fetch    display  biometric   userOp    txHash
 proposal  details  prompt     submit    + profit
```

**Шаги:**
1. **LOADING** — `bffClient.getProposal(id, hmacHex)` — загрузка из BFF
2. **REVIEW** — отображение: актив, объём, conviction score, signals, deadline
3. **APPROVE** — WebAuthn биометрия → FaceID/TouchID/PIN
4. **EXECUTING** — формирование UserOperation → ZeroDev Bundler
5. **RESULT** — transaction hash, profit amount, статус

**Anti-double-execution:**
```typescript
const executionLockRef = useRef(false);
// useRef (не useState) — синхронный, нет race condition от re-render
if (executionLockRef.current) return;
executionLockRef.current = true;  // Set once, NEVER reset
```

### 6.3 hooks/useWebAuthn.ts — Passkeys Integration

```typescript
import { toPasskeyValidator } from "@zerodev/passkey-validator";
import { constants } from "@zerodev/sdk";

const validator = await toPasskeyValidator(publicClient, {
    passkeyServerUrl: PASSKEY_SERVER_URL,
    entryPoint: ENTRY_POINT_ADDRESS,
    kernelVersion: constants.KERNEL_V3_1,
    validatorContractVersion: PasskeyValidatorContractVersion.V0_0_3_PATCHED,
});
```

**ВАЖНО (pitfalls):**
- `toPasskeyValidator` — НЕ `signerToPasskeyValidator` (deprecated в SDK v5.5)
- `KERNEL_V3_1` — НЕ `KERNEL_V3_0` (v3.1 фикс для Passkey flow)
- `V0_0_3_PATCHED` — НЕ `V0_0_3` (patch для replay protection)
- `events` polyfill ОБЯЗАТЕЛЕН (SDK использует EventEmitter в browser)

### 6.4 utils/bffClient.ts — API Client

```typescript
async function getProposal(id: string, hmacHex: string): Promise<ProposalResponse> {
    const res = await fetch(`${BFF_BASE_URL}/api/proposal/${id}`, {
        headers: {
            "x-hmac-signature": hmacHex,
            "Content-Type": "application/json"
        }
    });
    if (!res.ok) throw new BffApiError(res.status, await res.text());
    return res.json();
}
```

**Безопасность:** фронтенд НЕ содержит HMAC_SECRET. Подпись приходит из Telegram
deep link (генерируется ботом) и просто передаётся в header.

---

## 7. Модуль 5: HITL Telegram Bot

**Путь:** `devops/src/tg-bot/`
**Framework:** Telegraf v4
**Pattern:** Dual Redis clients (subscriber + CRUD)

### 7.1 index.ts — Bot Entry

**Архитектура Redis:**
```typescript
// Клиент 1: Subscriber (ТОЛЬКО подписка, НЕ может делать CRUD)
const subscriberRedis = new Redis(REDIS_URL);
subscriberRedis.subscribe("tee_proposals");

// Клиент 2: CRUD (GET, SET, SETNX, DEL, PUBLISH)
const crudRedis = new Redis(REDIS_URL);
```

**Reason:** Redis subscriber в "subscription mode" не может выполнять команды типа GET/SET.
Нужны два отдельных подключения.

**Message Handler:**
```typescript
subscriberRedis.on("message", async (channel, message) => {
    const proposal = JSON.parse(message);

    // 1. Проверка deadline
    if (proposal.deadline < Date.now() / 1000) return;

    // 2. Проверка nullifier (не дубликат)
    const existing = await crudRedis.get(`nullifier:${proposal.reasoningHash}`);
    if (existing) return;

    // 3. Сохранение в Redis
    await crudRedis.pipeline()
        .set(`proposal:${proposal.id}`, JSON.stringify(proposal), "EX", PROPOSAL_TTL_SEC)
        .set(`proposal:${proposal.id}:status`, "pending", "EX", PROPOSAL_TTL_SEC + 120)
        .set(`nullifier:${proposal.reasoningHash}`, "1")
        .exec();

    // 4. Генерация HMAC для deep link
    const hmac = createHmac("sha256", PROPOSAL_HMAC_SECRET)
        .update(proposal.id)
        .digest("base64url");

    // 5. Отправка в Telegram
    await bot.telegram.sendMessage(TARGET_CHAT_ID, formatProposalMessage(proposal), {
        reply_markup: {
            inline_keyboard: [[{
                text: "🔍 Review & Approve",
                web_app: { url: `${MINI_APP_URL}?startapp=${proposal.id}_${hmac}` }
            }]]
        }
    });
});
```

### 7.2 config.ts — Zod-Validated Environment

```typescript
const ConfigSchema = z.object({
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    REDIS_URL: z.string().url(),
    TARGET_CHAT_ID: z.coerce.number(),
    MINI_APP_URL: z.string().url(),
    PROPOSAL_HMAC_SECRET: z.string().min(32),
    MAX_SLIPPAGE_PCT: z.coerce.number().default(2),
    PROPOSAL_TTL_SEC: z.coerce.number().default(300),
});
```

### 7.3 Middleware: Whitelist

```typescript
bot.use(async (ctx, next) => {
    if (ctx.chat?.id !== TARGET_CHAT_ID) return;  // Silent drop
    // НЕ отвечаем неавторизованным — это раскрыло бы существование бота
    await next();
});
```

### 7.4 Команды

| Команда | Описание | Реализация |
|---------|----------|------------|
| `/status` | Состояние агента, последние proposals, uptime | Redis GET + формат |
| `/pause` | Приостановить обработку proposals | SET `bot:paused` "1" |
| `/resume` | Возобновить обработку | DEL `bot:paused` |

---

## 8. Сквозной поток данных

### 8.1 YieldArchitect Proposal (HITL flow)

```
┌──────────────────────────────────────────────────────────────────────┐
│ STEP 1: Signal Detection                                              │
│ TEE Agent → Nansen MCP → "Fund wallet 0xABC bought 500K WMNT"       │
└───────────────────────────────────────┬──────────────────────────────┘
                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│ STEP 2: Strategy Computation                                          │
│ YieldArchitect:                                                       │
│   W = 500,000 / 50,000,000 = 0.01 (1% of fund's portfolio)          │
│   S_user = 10,000 × 0.01 × 0.5 = 50 WMNT (conservative K=0.5)      │
│   reasoningHash = keccak256(signal + profile + params)                 │
└───────────────────────────────────────┬──────────────────────────────┘
                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│ STEP 3: EIP-712 Sign + Attestation                                    │
│ wallet.signTypedData(domain, types, proposal) → 0x signature         │
│ PhalaAttestation.generateQuote(keccak256(proposal || signer))        │
└───────────────────────────────────────┬──────────────────────────────┘
                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│ STEP 4: Publish to Redis                                              │
│ PUBLISH "tee_proposals" { proposal, signature, attestation,           │
│   nonce: 42, deadline: 1716300000, priceAtGeneration: "1.05" }       │
└───────────────────────────────────────┬──────────────────────────────┘
                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│ STEP 5: Bot receives + stores + notifies                              │
│ SET proposal:{id} → Redis (TTL 300s)                                  │
│ SET nullifier:{reasoningHash} "1" → permanent                         │
│ HMAC = hmac-sha256(id, SECRET).base64url()                            │
│ Send Telegram message with inline keyboard → deep link to TMA         │
└───────────────────────────────────────┬──────────────────────────────┘
                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│ STEP 6: User clicks "Review & Approve" in Telegram                    │
│ Telegram opens WebApp: https://tma.alphaflow.suite?startapp={id}_{h} │
└───────────────────────────────────────┬──────────────────────────────┘
                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│ STEP 7: TMA loads proposal from BFF                                   │
│ GET /api/proposal/{id}  [header: x-hmac-signature: {hmacHex}]        │
│ BFF: verify HMAC → check deadline → not consumed → SETNX lock → OK  │
└───────────────────────────────────────┬──────────────────────────────┘
                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│ STEP 8: Staleness check (BFF, on-chain)                               │
│ eth_call → pool.slot0() or pool.getReserves()                        │
│ |currentPrice - priceAtGeneration| / priceAtGeneration < MAX_STALE%  │
│ If stale → DEL lock → 422 "Price moved too much"                     │
└───────────────────────────────────────┬──────────────────────────────┘
                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│ STEP 9: User approves with biometrics                                 │
│ WebAuthn prompt → FaceID / TouchID / PIN                              │
│ Passkey signs UserOperation for ZeroDev Kernel v3.1                   │
└───────────────────────────────────────┬──────────────────────────────┘
                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│ STEP 10: UserOp submission                                            │
│ ZeroDev SDK → Private Bundler (Pimlico) → EntryPoint v0.7            │
│ Paymaster sponsors gas (user pays $0)                                 │
│ Kernel v3.1 → calls ActiveSentinel.executeFlashArbitrage(params)      │
└───────────────────────────────────────┬──────────────────────────────┘
                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│ STEP 11: On-chain execution (atomic, 1 transaction)                   │
│ INIT Capital flashBorrow → Merchant Moe swap A→B →                    │
│ Agni Finance swap B→A → repay INIT → profit invariant check          │
└───────────────────────────────────────┬──────────────────────────────┘
                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│ STEP 12: Post-execution                                               │
│ TMA: POST /api/proposal/{id}/consume                                  │
│ BFF: SET nullifier:{hash} "consumed" + DEL lock + update status       │
│ TMA: display txHash + profit to user                                  │
└──────────────────────────────────────────────────────────────────────┘
```

### 8.2 Flash Arbitrage (автоматический, без HITL)

Для операций ниже порога (автоматическое исполнение через Session Key):
```
1. TEE Agent → обнаружение ценовой дислокации (spread > threshold)
2. Simulation: ethers.staticCall → estimated profit
3. RateLimiter.canSend() → allowed?
4. SessionKeyRotator → not in dead zone?
5. MevProtection → select private bundler
6. Executor → encode calldata + 2D nonce
7. ZeroDev SDK → sign UserOp (session key)
8. Private Bundler → EntryPoint → Kernel → ActiveSentinel
9. On-chain: flashBorrow → swap → swap → repay → profit
```

---

## 9. Безопасность

### 9.1 Модель угроз

| # | Вектор атаки | Severity | Защита |
|---|---|---|---|
| 1 | Компрометация TEE-ключа | Critical | Ключ IN-MEMORY, RA доказывает целостность кода |
| 2 | Front-running / Sandwich | High | Private bundler (Pimlico), NOT public mempool |
| 3 | Replay attack | High | 2D Nonces + nullifier burn (permanent Redis key) |
| 4 | Reentrancy | High | EIP-1153 TSTORE guard |
| 5 | Price manipulation | High | On-chain staleness check (slot0/getReserves) |
| 6 | HMAC forgery | Medium | HMAC-SHA256 + timing-safe comparison |
| 7 | Double execution | Medium | Optimistic lock (SETNX 60s) + nullifier |
| 8 | Gas vault drain | Medium | PaymasterRateLimiter (5/min, 3 reverts → block) |
| 9 | Unauthorized bot access | Low | Whitelist + silent drop |
| 10 | Stale price execution | Medium | MAX_STALENESS_PCT check via eth_call |
| 11 | Timing oracle on HMAC | Low | timingSafeEqual (constant-time compare) |
| 12 | Frontend oracle spoofing | Medium | Price source: on-chain ONLY (not request body) |

### 9.2 Криптографические инварианты

1. **Приватный ключ TEE:**
   - Генерируется `Wallet.createRandom()` (HDNodeWallet)
   - NEVER: logged, persisted, transmitted, included in object spread
   - Живёт ТОЛЬКО в RAM процесса внутри CVM

2. **EIP-712 подпись:**
   - Каждый proposal подписан → верифицируемость on-chain
   - Domain separator привязан к chainId + contract address

3. **Remote Attestation:**
   - SGX Quote привязан к `keccak256(proposal || signer)`
   - MRENCLAVE доказывает: код не модифицирован
   - Любое изменение кода agent-tee → другой MRENCLAVE → attestation невалиден

4. **Биометрия (WebAuthn):**
   - Каждая транзакция требует FaceID/TouchID
   - Passkey hardware-bound (Secure Enclave / TPM)
   - Невозможно исполнить без физического присутствия пользователя

5. **Nullifier (one-time use):**
   - `nullifier:{reasoningHash}` — permanent Redis key (no TTL)
   - Proposal невозможно исполнить дважды

6. **Profit invariant:**
   - Контракт revert если `actualProfit < minProfitTokenA`
   - Невозможно исполнить убыточную сделку

### 9.3 Defense in Depth (3 уровня replay protection)

```
Layer 1: On-chain nonce     — ERC-4337 2D nonce (sessionId × sequence)
Layer 2: Deadline           — proposal auto-expires (Redis TTL + on-chain check)
Layer 3: Nullifier          — permanent Redis key (never deleted)
```

---

## 10. Redis — Схема ключей

### 10.1 Key Patterns

| Key | Type | TTL | Owner | Purpose |
|-----|------|-----|-------|---------|
| `proposal:{id}` | String (JSON) | PROPOSAL_TTL_SEC | Bot write, BFF read | StoredProposal data |
| `proposal:{id}:status` | String | TTL+120s | Bot write, BFF update | FSM state |
| `proposal:{id}:lock` | String | 60s | BFF | Optimistic lock |
| `nullifier:{reasoningHash}` | String | **permanent** | Bot write, BFF write | Anti-replay |
| `bot:paused` | String | **permanent** | Bot | Pause flag |
| `bot:signal_count` | String | **permanent** | Bot | Counter for /status |

### 10.2 Proposal Status FSM

```
                 ┌────────────────────────────────────────┐
                 │                                        │
                 ▼                                        │
    [pending] ──────► [dispensed] ──────► [consumed]      │
        │                                                 │
        └── (TTL expiry: auto-deleted = "expired") ───────┘
```

- `pending` — proposal получен, ожидает действия пользователя
- `dispensed` — proposal выдан frontend (lock активен)
- `consumed` — UserOp исполнен, nullifier burned
- (expired) — TTL истёк, ключ удалён из Redis

### 10.3 Cross-Service Compatibility

Bot и BFF используют ОДИНАКОВЫЕ ключи Redis. Это позволяет:
- Bot: пишет proposal + status + nullifier
- BFF: читает proposal, обновляет status, ставит lock, burns nullifier
- Нет дублирования, нет рассинхронизации

---

## 11. Account Abstraction (ZeroDev)

### 11.1 Стек

| Компонент | Версия | Роль |
|-----------|--------|------|
| @zerodev/sdk | v5.5 | Core SDK |
| Kernel | v3.1 | Smart Account (ERC-4337) |
| EntryPoint | v0.7 | ERC-4337 singleton |
| Passkey Validator | V0_0_3_PATCHED | WebAuthn owner auth |
| Session Key Validator | — | TEE agent auth |
| Paymaster | ZeroDev Paymaster | Gas sponsorship |
| Bundler | Pimlico Private | UserOp submission |

### 11.2 Session Key Policies (5 штук)

TEE-агент работает через Session Key с ограниченными правами:

1. **Contract Whitelist** — может вызывать ТОЛЬКО ActiveSentinel
2. **Function Whitelist** — только `executeFlashArbitrage()`
3. **Value Limit** — максимальный msg.value = 0 (no ETH transfer)
4. **Rate Limit** — max N ops per time window
5. **Validity Period** — validAfter / validUntil (time-bounded)

### 11.3 UserOperation Flow

```
┌──────────────────────────────────────────────────────────────────┐
│ UserOp {                                                          │
│   sender: Kernel address (Smart Account)                         │
│   nonce: 2D nonce (sessionId << 64 | sequence)                   │
│   callData: Kernel.execute(ActiveSentinel, 0, arbCalldata)       │
│   signature: Passkey signature (for owner) or SessionKey sig     │
│   paymasterAndData: ZeroDev Paymaster (sponsors gas)             │
│ }                                                                 │
│                                                                   │
│   ──► Private Bundler (Pimlico)                                  │
│       ──► EntryPoint.handleOps([userOp])                         │
│           ──► Kernel.validateUserOp() → check signature          │
│           ──► Kernel.execute() → ActiveSentinel.executeFlash...  │
│           ──► Paymaster.postOp() → debit gas from Gas Vault      │
└──────────────────────────────────────────────────────────────────┘
```

---

## 12. Инфраструктура и DevOps

### 12.1 Docker Compose

```yaml
services:
  redis:          # Redis 7 Alpine (Pub/Sub + State + Nullifiers)
  bff:            # Hono API Server (port 3001)
  tg-bot:         # Telegraf HITL Bot
  agent-tee-dev:  # TEE Agent (dev mode, profile: dev)
  # Production TEE: deployed via Phala DStack (not in compose)
```

**Все сервисы:**
- `restart: unless-stopped`
- Healthchecks с interval/timeout/retries
- Зависимости через `depends_on: condition: service_healthy`
- Redis password через env

### 12.2 Dockerfiles

**agent-tee/Dockerfile:** Phala DStack compatible
```dockerfile
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 8080
CMD ["node", "dist/main.js"]
```

**bff/Dockerfile:** Node.js 20 multi-stage (аналогично)
**devops/Dockerfile:** Node.js 20 для Telegraf bot

### 12.3 Server Hardening (devops/setup-debian.sh)

- UFW firewall (allow 22, 80, 443 only)
- Fail2ban
- Unattended upgrades
- Swap disabled
- Docker rootless mode

---

## 13. CI/CD Pipeline

**Файл:** `.github/workflows/ci.yml`

### Jobs:

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  contracts  │     │  typescript  │     │   docker    │
│ (Forge test)│     │  (Vitest)    │     │  (build)    │
└──────┬──────┘     └──────┬───────┘     └─────────────┘
       │                   │
       └─────────┬─────────┘
                 ▼
         ┌──────────────┐
         │ integration  │
         │ (Anvil fork) │
         └──────────────┘
```

1. **contracts** — `forge build --sizes` + `forge test -vvv --gas-report` + `forge fmt --check`
2. **typescript** — Matrix [bff, agent-tee, devops] → `npm install` + `npm test` (vitest)
3. **docker** — Build verification (all 3 images)
4. **integration** — Anvil fork Mantle mainnet → deploy → e2e flash arb test

**Triggers:** push to `main`, pull requests to `main`

---

## 14. Конфигурация

### 14.1 Shared (все сервисы)

| Variable | Сервисы | Описание |
|----------|---------|----------|
| `REDIS_URL` | all | Redis connection (redis://:password@host:port) |
| `PROPOSAL_HMAC_SECRET` | bff, tg-bot | Shared HMAC secret (min 32 chars) |

### 14.2 TEE Agent

| Variable | Описание | Default |
|----------|----------|---------|
| `REDIS_URL` | Redis for Pub/Sub | redis://localhost:6379 |
| `NANSEN_API_KEY` | Nansen API credentials | — |
| `NANSEN_API_URL` | Nansen endpoint | — |
| `MANTLE_RPC_URL` | Mantle RPC (primary) | https://rpc.mantle.xyz |
| `ACTIVE_SENTINEL_ADDRESS` | Deployed contract | — |
| `DSTACK_SIMULATOR_ENDPOINT` | Phala DStack (dev) | http://localhost:8090 |

### 14.3 BFF

| Variable | Описание | Default |
|----------|----------|---------|
| `MANTLE_RPC_PRIMARY` | Primary RPC | https://rpc.mantle.xyz |
| `MANTLE_RPC_FALLBACK_1` | Fallback RPC 1 | blastapi.io |
| `MANTLE_RPC_FALLBACK_2` | Fallback RPC 2 | drpc.org |
| `ACTIVE_SENTINEL_ADDRESS` | Contract address | — |
| `MAX_STALENESS_PCT` | Max price deviation % | 2 |
| `TMA_ORIGIN` | CORS origin | http://localhost:5173 |
| `PORT` | Server port | 3001 |

### 14.4 Telegram Bot

| Variable | Описание | Default |
|----------|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot API token | — |
| `TARGET_CHAT_ID` | Whitelist chat ID | — |
| `MINI_APP_URL` | TMA URL for deep links | — |
| `MAX_SLIPPAGE_PCT` | Warning threshold | 2 |
| `PROPOSAL_TTL_SEC` | Proposal lifetime | 300 |

### 14.5 Frontend (.env)

| Variable | Описание | Default |
|----------|----------|---------|
| `VITE_BFF_URL` | BFF API base URL | https://bff.alphaflow.suite |
| `VITE_ZERODEV_PROJECT_ID` | ZeroDev project | — |
| `VITE_BUNDLER_URL` | Pimlico bundler | — |
| `VITE_PAYMASTER_URL` | ZeroDev paymaster | — |
| `VITE_PASSKEY_SERVER_URL` | Passkey server | — |
| `VITE_CHAIN_ID` | Target chain | 5000 |

---

## 15. Структура монорепозитория

```
alphaflow-suite/
├── contracts/                          # Solidity (Foundry)
│   ├── foundry.toml                    # Foundry config (solc 0.8.24, evm cancun)
│   ├── remappings.txt                  # Import remappings
│   ├── src/
│   │   ├── ActiveSentinel.sol          # Core execution engine (193 lines)
│   │   ├── interfaces/
│   │   │   ├── IINITCore.sol           # INIT Capital flash borrow
│   │   │   ├── IFlashBorrower.sol      # Callback interface
│   │   │   └── IDexRouter.sol          # Unified DEX router
│   │   └── libraries/
│   │       └── TransientReentrancyGuard.sol  # EIP-1153 guard (27 lines)
│   ├── test/
│   │   └── ActiveSentinel.t.sol        # Fuzz tests + attack simulations
│   ├── script/
│   │   └── Deploy.s.sol                # Deployment script
│   └── lib/                            # Git submodules
│       ├── forge-std/
│       └── openzeppelin-contracts/
│
├── agent-tee/                          # TEE Agent (Phala CVM)
│   ├── Dockerfile                      # DStack-compatible image
│   ├── package.json                    # ethers v6, ioredis
│   ├── tsconfig.json
│   └── src/
│       ├── main.ts                     # Entry point + health server (8080)
│       ├── executor.ts                 # Calldata encoding + 2D nonces
│       ├── types/index.ts              # Domain types (138 lines)
│       ├── strategies/
│       │   └── yieldArchitect.ts       # Strategy: conviction + risk-norm + EIP-712
│       ├── services/
│       │   ├── nansenClient.ts         # Nansen MCP (rate-limited)
│       │   ├── mevProtection.ts        # Private bundler selection (111 lines)
│       │   ├── rateLimiter.ts          # Gas drain protection (159 lines)
│       │   ├── sessionKeyRotator.ts    # Pre-emptive rotation (172 lines)
│       │   ├── remoteAttestation.ts    # SGX/TDX Quote gen (229 lines)
│       │   └── proposalPublisher.ts    # Redis Pub/Sub (75 lines)
│       └── test/
│           └── yieldArchitect.test.ts  # Vitest
│
├── bff/                                # Backend-for-Frontend (Hono)
│   ├── Dockerfile                      # Multi-stage Node.js 20
│   ├── .env.example
│   ├── package.json                    # hono, ioredis, viem, zod
│   └── src/
│       ├── index.ts                    # API routes + middleware
│       ├── services/
│       │   ├── proposalService.ts      # HMAC + lock + nullifier (297 lines)
│       │   └── onChainOracle.ts        # Staleness detection (271 lines)
│       └── test/
│           └── api.test.ts             # Vitest
│
├── frontend/                           # Telegram Mini App
│   ├── package.json                    # react 18, vite 5, @zerodev/sdk
│   ├── vite.config.ts                  # Code splitting config
│   ├── index.html
│   └── src/
│       ├── App.tsx                     # Root (startapp parser)
│       ├── main.tsx                    # React entry
│       ├── components/
│       │   └── InvestFlowApp.tsx       # Main UI (state machine)
│       ├── hooks/
│       │   └── useWebAuthn.ts          # Passkey integration
│       └── utils/
│           └── bffClient.ts            # API client (249 lines)
│
├── devops/                             # Telegram Bot + Infra
│   ├── Dockerfile
│   ├── .env.example
│   ├── setup-debian.sh                 # Server hardening script
│   ├── package.json                    # telegraf v4, ioredis
│   └── src/tg-bot/
│       ├── index.ts                    # Bot entry + Redis subscriber
│       ├── config.ts                   # Zod-validated env
│       └── proposalStore.ts            # Redis CRUD + nullifier
│
├── docker-compose.yml                  # Full stack (118 lines)
├── .github/workflows/ci.yml           # CI: Forge + Vitest + Docker + Integration
├── .env.example                        # Root env template
├── .gitignore
├── README.md                           # Quick overview + architecture diagram
├── PROJECT.md                          # Extended project description
├── ARCHITECTURE.md                     # Architecture deep-dive
└── CONCEPT.md                          # Concept document
```

---

## 16. Технологический стек

### Blockchain & Smart Contracts

| Технология | Версия | Роль |
|------------|--------|------|
| Mantle Network | L2, Chain ID 5000 | Target chain ($0.01/tx) |
| Solidity | 0.8.24 | Contract language |
| Foundry | latest | Build, test, deploy |
| OpenZeppelin | latest | Safe libraries |
| EIP-1153 | Cancun | Transient storage (reentrancy) |
| EIP-712 | — | Typed structured data signing |
| EIP-4337 | v0.7 | Account abstraction |

### DeFi Protocols (Mantle)

| Protocol | Роль |
|----------|------|
| INIT Capital | Flash loan provider |
| Merchant Moe | DEX (Liquidity Book, TraderJoe fork) |
| Agni Finance | DEX (Uniswap V3 fork, concentrated liquidity) |

### TEE & Confidential Computing

| Технология | Роль |
|------------|------|
| Phala Network DStack | CVM hosting platform |
| Intel SGX/TDX | Hardware security (enclave) |
| DCAP Attestation | Quote generation/verification |

### Account Abstraction

| Компонент | Версия | Детали |
|-----------|--------|--------|
| @zerodev/sdk | v5.5 | Core SDK |
| Kernel | v3.1 | Smart account |
| Passkey Validator | V0_0_3_PATCHED | WebAuthn |
| Pimlico | — | Private bundler |
| ZeroDev Paymaster | — | Gas sponsorship |

### Backend

| Технология | Версия | Роль |
|------------|--------|------|
| Hono | latest | HTTP framework (14KB) |
| Node.js | 20 | Runtime |
| ioredis | latest | Redis client |
| viem | latest | EVM client (multicall, fallback) |
| ethers | v6 | Signing (TEE agent) |
| zod | latest | Validation |

### Frontend

| Технология | Версия | Роль |
|------------|--------|------|
| React | 18 | UI framework |
| Vite | 5 | Build tool |
| TypeScript | 5.x | Language |
| Telegram WebApp SDK | — | TMA integration |
| WebAuthn | — | Biometric auth (Passkeys) |

### Bot & Transport

| Технология | Версия | Роль |
|------------|--------|------|
| Telegraf | v4 | Telegram Bot framework |
| Redis | 7 | Pub/Sub + State + Nullifiers |

### Data & Analytics

| Технология | Роль |
|------------|------|
| Nansen | Smart Money data provider |
| MCP (Model Context Protocol) | Data access protocol |

### Testing

| Tool | Scope |
|------|-------|
| Foundry (forge test) | Contracts: fuzz, invariant |
| Vitest | TypeScript: unit + integration |
| Anvil | Fork testing (Mantle mainnet state) |

### DevOps

| Tool | Роль |
|------|------|
| Docker / Docker Compose | Containerization |
| GitHub Actions | CI/CD |
| GCP (instance-20260330-115005) | Hosting |

---

## 17. Конкурентные преимущества

| Аспект | Конкуренты (3Commas, Maestro, Banana Gun) | AlphaFlow Suite |
|--------|-------------------------------------------|-----------------|
| Кастодиальность | Пользователь даёт PK/API key | **Non-custodial** (Passkey owner, TEE signer) |
| Прозрачность AI | Black box (нет доказательств) | **Proof-of-Reasoning** (EIP-712 + RA) |
| MEV защита | Нет (публичный мемпул) | **Private bundler** (Pimlico) |
| Данные | Публичные индикаторы (RSI, MA) | **Институциональные** (Nansen Smart Money) |
| Безопасность | Централизованный сервер | **TEE** (аппаратная изоляция) |
| Gas | EOA tx (пользователь платит) | **ERC-4337** (gasless, paymaster) |
| Сеть | Ethereum mainnet ($5-50/tx) | **Mantle L2** ($0.01/tx) |
| Контроль | Полная автоматика (нет override) | **HITL** (Telegram approval) |
| Атомарность | Multi-tx (может partial fail) | **Flash loan** (atomic: all or nothing) |
| Верификация | Trust-based | **On-chain verifiable** (signature, attestation) |

---

## 18. Roadmap

### Phase 1 — MVP ✅ (Завершено)

- [x] ActiveSentinel.sol (EIP-1153, flash arbitrage, CEI, profit invariant)
- [x] TransientReentrancyGuard (custom EIP-1153 implementation)
- [x] TEE Agent — YieldArchitect strategy + EIP-712 signing
- [x] TEE Agent — Nansen MCP client + rate limiting
- [x] TEE Agent — MEV Protection (private bundler selection)
- [x] TEE Agent — Paymaster Rate Limiter (gas drain protection)
- [x] TEE Agent — Remote Attestation (Phala DStack)
- [x] TEE Agent — Session Key Rotator (pre-emptive)
- [x] TEE Agent — Proposal Publisher (Redis Pub/Sub)
- [x] TEE Agent — 2D Nonces (ERC-4337 replay protection)
- [x] BFF — Hono API (HMAC verify, staleness, optimistic lock, nullifier)
- [x] BFF — On-chain Oracle (viem fallback, slot0/getReserves)
- [x] Frontend TMA — React 18 + Vite 5 + ZeroDev v5.5
- [x] Frontend TMA — Passkeys (WebAuthn, biometric)
- [x] Frontend TMA — InvestFlow state machine (load → review → approve → execute)
- [x] Telegram Bot — HITL (Telegraf v4, Pub/Sub, whitelist, /status /pause /resume)
- [x] HMAC flow — Bot generates, TMA passes, BFF verifies (timing-safe)
- [x] Docker Compose — full stack (Redis, BFF, Bot, Agent-dev)
- [x] CI/CD — GitHub Actions (Forge + Vitest + Docker + Anvil integration)

### Phase 2 — Hardening (Next)

- [ ] Circuit Breaker — flash crash detection, anomaly halt, auto-pause
- [ ] Formal Verification — Certora/Halmos для ActiveSentinel invariants
- [ ] Multi-path Arbitrage — 3+ DEX routing (Merchant Moe + Agni + FusionX)
- [ ] Prometheus + Grafana — monitoring dashboard
- [ ] Telegram Alerts — disk, OOM, rate limiter lockout, revert streaks
- [ ] Audit — external smart contract audit

### Phase 3 — Scale

- [ ] Multi-chain — Mantle → Base → Arbitrum (chain-agnostic ActiveSentinel)
- [ ] Portfolio Rebalancing — automated rebalancing based on Smart Money flows
- [ ] DAO Governance — risk parameters voting (K_risk, maxSlippage, policies)
- [ ] Mobile App — React Native + Passkey (standalone, not Telegram-dependent)
- [ ] Institutional API — white-label (B2B offering)
- [ ] Cross-chain arbitrage — bridge + flash loan + swap (LayerZero/Axelar)

---

## Заключение

AlphaFlow Suite демонстрирует, что **Agentic Commerce** может быть одновременно:

- **Автономным** — AI-агент принимает решения и исполняет в пределах блока
- **Верифицируемым** — EIP-712 подпись + SGX Remote Attestation = Proof-of-Reasoning
- **Безопасным** — non-custodial, TEE-isolated keys, multi-layer replay protection
- **Доступным** — институциональные стратегии через Telegram, gasless ($0 для пользователя)
- **Контролируемым** — Human-in-the-Loop для крупных сделок (biometric approval)

**Ключевая инновация:** криптографическое доказательство того, что AI-решение
принято на основе конкретных данных, в немодифицированном коде, внутри аппаратного
анклава. Это создаёт новый стандарт доверия для AI-агентов в DeFi.

---

*AlphaFlow Suite — Winner, DoraHacks Mantle Hackathon*
*Built on: Mantle Network × Phala TEE × ZeroDev × Nansen MCP*
*Author: @rocknrolla77*
