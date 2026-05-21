# AlphaFlow Suite — Полное Описание Проекта

> **Agentic Commerce Infrastructure on Mantle Network**
> 🏆 Победитель DoraHacks Mantle Hackathon
> Flash-арбитраж с AI-агентом в TEE + Human-in-the-Loop UX

---

## Содержание

1. [Обзор](#1-обзор)
2. [Проблема и Решение](#2-проблема-и-решение)
3. [Архитектура системы](#3-архитектура-системы)
4. [Модуль 1: Smart Contracts](#4-модуль-1-smart-contracts)
5. [Модуль 2: TEE Agent](#5-модуль-2-tee-agent)
6. [Модуль 3: BFF API Server](#6-модуль-3-bff-api-server)
7. [Модуль 4: Telegram Mini App (Frontend)](#7-модуль-4-telegram-mini-app-frontend)
8. [Модуль 5: HITL Telegram Bot](#8-модуль-5-hitl-telegram-bot)
9. [Сквозной поток данных](#9-сквозной-поток-данных)
10. [Безопасность](#10-безопасность)
11. [Инфраструктура и DevOps](#11-инфраструктура-и-devops)
12. [Технологический стек](#12-технологический-стек)
13. [Переменные окружения](#13-переменные-окружения)
14. [Roadmap](#14-roadmap)

---

## 1. Обзор

AlphaFlow Suite — монорепозиторий, реализующий инфраструктуру автономной торговли (Agentic Commerce) на Mantle Network (L2). Система объединяет:

- **AI-агент в TEE** (Trusted Execution Environment) — стратегия YieldArchitect анализирует сигналы Smart Money через Nansen MCP
- **Flash Arbitrage** — атомарные flash-займы через INIT Capital с арбитражем между Merchant Moe и Agni Finance
- **Account Abstraction** — ZeroDev ERC-4337 (Kernel v3.1, Session Keys, Passkeys) для gasless UX
- **Human-in-the-Loop** — каждое решение AI требует явного одобрения пользователя через Telegram

Ключевой принцип: **розничный инвестор получает стратегии институционального уровня, сохраняя полный контроль над средствами**.

---

## 2. Проблема и Решение

### Проблемы розничных инвесторов:
- Нет доступа к данным о движении Smart Money (VC, фонды, Smart Traders)
- Flash-арбитраж требует < 1 блока — недоступен вручную
- Нет инструментов risk-нормализации (адаптация объёма под портфель)

### Проблемы существующих решений (торговые боты, copy-trading):
- **Непрозрачность** — невозможно доказать, что AI принял решение на основе данных
- **Кастодиальность** — пользователь передаёт приватный ключ боту
- **MEV-уязвимость** — транзакции видны в публичном мемпуле

### Решение AlphaFlow:
- **Proof-of-Reasoning** — EIP-712 подпись каждого решения AI с Remote Attestation (SGX/TDX)
- **Non-custodial** — приватный ключ генерируется in-memory внутри TEE, никогда не покидает анклав
- **MEV Protection** — приватный мемпул (Flashbots Protect / Merkle) + 2D nonces для replay protection

---

## 3. Архитектура системы

```
┌─────────────────────────────────────────────────────────────────────┐
│                        MANTLE NETWORK (L2)                          │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  ActiveSentinel.sol (EIP-1153 Transient Reentrancy Guard)   │   │
│  │  Flash Borrow (INIT Capital) → Swap A (Merchant Moe)       │   │
│  │                               → Swap B (Agni Finance)       │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
        ▲ EIP-712 signed tx (gasless via ZeroDev Paymaster)
        │
┌───────┴────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Frontend TMA  │◄───►│    BFF (Hono)    │◄───►│   Redis 7       │
│  React + Vite  │     │  HMAC · Staleness │     │  Pub/Sub + State│
│  Passkeys/AA   │     │  Optimistic Lock  │     │                 │
└────────────────┘     └──────────────────┘     └───────┬──────────┘
        ▲                                               │
        │ Telegram WebApp                               │ Subscribe
        │                                               ▼
┌───────┴────────┐                              ┌──────────────────┐
│  Telegram Bot  │◄────── Pub/Sub ──────────────│   TEE Agent      │
│  HITL Approval │                              │   Phala CVM      │
│  Whitelist     │                              │   Nansen MCP     │
└────────────────┘                              │   EIP-712 Sign   │
                                                └──────────────────┘
```

### Потоки:
1. **TEE Agent** → Redis Pub/Sub (`tee_proposals`) → **Telegram Bot**
2. **Telegram Bot** → Inline Button → **TMA** (с HMAC в startapp)
3. **TMA** → REST API → **BFF** (проверяет HMAC, staleness, lock)
4. **BFF** → UserOperation → **Mantle** (через ZeroDev Bundler + Paymaster)

---

## 4. Модуль 1: Smart Contracts

**Путь:** `contracts/`
**Стек:** Solidity 0.8.24, Foundry, OpenZeppelin

### ActiveSentinel.sol — Основной контракт

Атомарный flash-арбитраж контракт, выполняющий:
1. Flash borrow через INIT Capital (`IINITCore.flashBorrow`)
2. Swap tokenA → tokenB на Merchant Moe (DEX Router A)
3. Swap tokenB → tokenA на Agni Finance (DEX Router B)
4. Возврат займа + fee → чистый профит

**Ключевые особенности:**
- **EIP-1153 TSTORE reentrancy guard** — gas-эффективная защита (transient storage, auto-clear после tx)
- **CEI паттерн** (Checks-Effects-Interactions)
- **Slippage protection** — `amountOutMinRoute1` / `amountOutMinRoute2` рассчитываются off-chain TEE-агентом
- **Profit invariant** — `actualProfit >= minProfitTokenA` (revert если нарушен)
- **Immutable addresses** — owner, initCore, dexRouterA, dexRouterB (set once at deploy)

### TransientReentrancyGuard.sol

Кастомная реализация reentrancy guard на базе EIP-1153:
```solidity
modifier nonReentrant() {
    assembly {
        if tload(_LOCK_SLOT) { revert(...) }
        tstore(_LOCK_SLOT, 1)
    }
    _;
    assembly {
        tstore(_LOCK_SLOT, 0)
    }
}
```
- Газ: ~100 gas vs ~5000 для SSTORE-based guard
- Слот: `keccak256("alphaflow.sentinel.reentrancy.lock") - 1`
- Автоматическая очистка после транзакции (transient storage spec)

### Интерфейсы:
- `IINITCore.sol` — INIT Capital flash borrow interface
- `IFlashBorrower.sol` — callback interface (`onFlashBorrow`)
- `IDexRouter.sol` — unified DEX router (Merchant Moe / Agni Finance)

### Тесты:
- `ActiveSentinel.t.sol` — Foundry fuzz tests, mock DEX routers, reentrancy attack simulation

### Deploy:
- `script/Deploy.s.sol` — Foundry deployment script

---

## 5. Модуль 2: TEE Agent

**Путь:** `agent-tee/`
**Стек:** TypeScript, ethers v6, ioredis, Phala DStack, vitest

### Общая логика

AI-агент работает внутри Phala Network CVM (Confidential Virtual Machine). При запуске:
1. Генерирует приватный ключ in-memory (`Wallet.createRandom()` → `HDNodeWallet`)
2. Экспортирует только публичный адрес через health endpoint (`:8080`)
3. Запускает цикл стратегии

### main.ts — Entry Point

- Загрузка конфигурации из ENV
- Генерация эфемерного ключа (живёт до перезапуска контейнера)
- HTTP health server на порту 8080 (отдаёт `teeSignerAddress`)
- Инициализация Redis client + подключение к Nansen MCP

### strategies/yieldArchitect.ts — Стратегия

**YieldArchitect** — основная стратегия агента:
1. **Сбор данных** — через NansenMCPClient получает сигналы Smart Money
2. **Conviction Weight** — алгоритм взвешивания сигналов (по тегам, объёмам, частоте)
3. **Risk Normalization** — адаптация размера позиции под UserRiskProfile
4. **Proposal Generation** — формирует ArbParams для ActiveSentinel
5. **EIP-712 Signing** — подписывает proposal структурированным форматом (Proof-of-Reasoning)

**EIP-712 Domain:**
```typescript
{
  name: "AlphaFlow",
  version: "1",
  chainId: 5000, // Mantle
  verifyingContract: ACTIVE_SENTINEL_ADDRESS
}
```

### services/nansenClient.ts — Nansen MCP Client

Взаимодействие с Nansen API через Model Context Protocol:
- `getSmartMoneyWallets(tags, minBalanceUsd)` — список кошельков Smart Money
- `getRecentTransactions(wallets, sinceTimestamp, minAmountUsd)` — последние транзакции
- `getTokenFlows(tokenAddress, timeframeHours)` — потоки капитала
- Rate limiting: 25 req/min, exponential backoff

### services/mevProtection.ts — MEV Protection

Защита от front-running и sandwich attacks:
- **Private mempool submission** — Flashbots Protect / Merkle
- **2D Nonces** — (sessionId, sequenceNumber) для replay protection
- **Deadline enforcement** — отклонение устаревших proposals
- Автоматическое переключение между private relay endpoints

### services/sessionKeyRotator.ts — Session Key Rotation

Ротация ZeroDev Session Keys:
- Периодическое обновление session keys (TTL-based)
- Graceful handoff — старый ключ валиден до expiry нового
- Интеграция с ZeroDev Kernel v3.1

### services/proposalPublisher.ts — Redis Publisher

Публикация подписанных proposals в Redis:
- Channel: `tee_proposals`
- Monotonic nonce (невозможно reset извне TEE)
- Deadline = timestamp + configurable offset
- Включает `priceAtGeneration` для staleness detection

### services/rateLimiter.ts — Paymaster Rate Limiter

Защита Gas Vault (10 MNT) от drain через revert-спам:
- `maxOpsPerMinute: 5` — жёсткий лимит
- `maxOpsPerHour: 30` — burst protection
- `consecutiveRevertLimit: 3` → блокировка на 15 минут
- Sliding window подсчёт

### services/remoteAttestation.ts — Remote Attestation

Интеграция с Phala DStack для генерации SGX/TDX Remote Attestation:
- Endpoint: `http://localhost:8090/prpc/Phala.GetRemoteAttestation`
- Report Data: `keccak256(proposalHash || teeSignerAddress)` (64 bytes)
- Возвращает: MRENCLAVE, MRSIGNER, raw SGX Quote
- Позволяет on-chain верификацию того, что proposal создан настоящим TEE

### types/index.ts — Типы

```typescript
interface SmartMoneySignal {
  wallet: `0x${string}`;
  tags: NansenTag[];
  action: "buy" | "sell" | "lp_add" | "lp_remove";
  tokenAddress: `0x${string}`;
  amountUsd: number;
  timestamp: number;
}

interface UserRiskProfile {
  maxPositionSizeUsd: number;
  maxSlippagePct: number;
  allowedTokens: `0x${string}`[];
  riskTolerance: "conservative" | "moderate" | "aggressive";
}

interface Proposal {
  id: string;
  strategy: "flash_arb";
  arbParams: ArbParams;
  convictionScore: number;
  signals: SmartMoneySignal[];
  timestamp: number;
}
```

---

## 6. Модуль 3: BFF API Server

**Путь:** `bff/`
**Стек:** Hono (Node.js), ioredis, viem, zod

### Роль

Backend-for-Frontend — промежуточный API между TMA и блокчейном. Обеспечивает:
- HMAC-SHA256 верификацию (timing-safe)
- Staleness check (eth_call: slot0/getReserves)
- Optimistic locking через Redis SETNX (60s TTL)
- Nullifier burn (предотвращение double-execution)

### index.ts — Server + Routes

**Endpoints:**
- `GET /api/health` — healthcheck
- `GET /api/proposal/:id` — получить proposal (проверяет HMAC из header `x-hmac-signature`)
- `POST /api/proposal/:id/approve` — одобрить + lock + staleness check
- `POST /api/proposal/:id/reject` — отклонить proposal

**Middleware:**
- CORS (origin: TMA_ORIGIN)
- Zod validation
- HMAC verification (timing-safe compare via `crypto.timingSafeEqual`)

### services/proposalService.ts — Proposal CRUD

Redis операции:
- `proposal:{id}` — JSON данные proposal
- `proposal:{id}:status` — статус (pending | approved | rejected | executed | expired)
- `proposal_lock:{id}` — SETNX optimistic lock (60s TTL, предотвращение race condition)
- `nullifier:{hash}` — одноразовый nullifier (предотвращение повторной отправки)

**Optimistic Lock Flow:**
1. SETNX `proposal_lock:{id}` (TTL 60s)
2. Если ключ уже существует → 409 Conflict
3. Проверка staleness → если stale → DEL lock + 422
4. Подтверждение → SET status = approved

### services/onChainOracle.ts — On-Chain Staleness

Проверка актуальности цены перед execution:
- viem client с fallback transport: `[primary, fallback1, fallback2]`
- `eth_call` к DEX pool (slot0 для concentrated liquidity / getReserves для AMM)
- Порог: `|currentPrice - priceAtGeneration| / priceAtGeneration < MAX_STALENESS_PCT`

---

## 7. Модуль 4: Telegram Mini App (Frontend)

**Путь:** `frontend/`
**Стек:** React 18, Vite 5, @zerodev/sdk v5.5, TypeScript

### Общее

Telegram Mini App (TMA) — интерфейс для одобрения и исполнения proposals. Открывается из inline button в Telegram боте.

### App.tsx — Root Component

- Парсит `startapp` параметр: `{proposalId}_{hmacBase64url}`
- Инициализирует ZeroDev Account Abstraction
- Рендерит InvestFlowApp

### components/InvestFlowApp.tsx — Основной UI

Пошаговый flow:
1. **Loading** — загрузка proposal из BFF (с HMAC header)
2. **Review** — отображение деталей (токены, суммы, conviction score, signals)
3. **Approve** — WebAuthn биометрия (FaceID/TouchID) → подпись UserOperation
4. **Execute** — отправка через ZeroDev Bundler + Paymaster (gasless)
5. **Result** — показ transaction hash и профита

### hooks/useWebAuthn.ts — WebAuthn/Passkeys

Интеграция с ZeroDev Passkeys:
- `toPasskeyValidator` (NOT `signerToPasskeyValidator` — deprecated)
- `PasskeyValidatorContractVersion.V0_0_3_PATCHED`
- `constants.KERNEL_V3_1`
- `events` polyfill для browser EventEmitter (required by SDK)

### utils/bffClient.ts — API Client

- Формирует `x-hmac-signature` header из startapp параметра
- Fetch wrapper с error handling
- Base URL из VITE env

### Startapp Parameter Format:
```
{proposalId}_{hmacBase64url}
```
- Bot вычисляет: `HMAC-SHA256(proposalId, HMAC_SECRET)` → Base64url
- Frontend передаёт как header → BFF верифицирует timing-safe

---

## 8. Модуль 5: HITL Telegram Bot

**Путь:** `devops/src/tg-bot/`
**Стек:** Telegraf v4, ioredis, TypeScript

### Роль

Human-in-the-Loop транспорт: получает proposals от TEE и доставляет пользователю для одобрения.

### index.ts — Bot Entry

- Redis Subscriber (отдельный client — subscriber не может делать CRUD)
- Подписка на channel `tee_proposals`
- При получении proposal → форматирует сообщение + inline keyboard (Approve / Reject)
- Inline button содержит URL на TMA с HMAC

### config.ts — Конфигурация

- `TARGET_CHAT_ID` — whitelist (единственный разрешённый chat)
- `MINI_APP_URL` — URL Telegram Mini App
- `PROPOSAL_HMAC_SECRET` — shared secret с BFF
- `MAX_SLIPPAGE_PCT` — порог отображения предупреждения
- `PROPOSAL_TTL_SEC` — TTL proposal (после — auto-expire)

### proposalStore.ts — Proposal State

Redis CRUD для бота:
- Дублирует ключи из BFF для cross-service compat
- Статус трекинг (pending → approved/rejected → executed/expired)
- TTL-based auto-expiry

### Middleware:
- **Whitelist** — silent drop всех сообщений НЕ из TARGET_CHAT_ID
- **Rate limit** — защита от flood

### Команды:
- `/status` — текущее состояние агента и последние proposals
- `/pause` — приостановить обработку proposals
- `/resume` — возобновить обработку

---

## 9. Сквозной поток данных

```
1. [TEE Agent] Nansen MCP → Smart Money сигналы
2. [TEE Agent] YieldArchitect → conviction scoring → ArbParams
3. [TEE Agent] EIP-712 подпись → Proof-of-Reasoning
4. [TEE Agent] Remote Attestation → SGX Quote привязан к proposal
5. [TEE Agent] Redis PUBLISH → channel "tee_proposals"
6. [TG Bot]   Redis SUBSCRIBE → получает proposal
7. [TG Bot]   Форматирует сообщение → Inline Button (TMA URL + HMAC)
8. [User]     Видит в Telegram → нажимает "Review & Approve"
9. [TMA]      Парсит startapp → загружает proposal из BFF (с HMAC header)
10. [BFF]     Верифицирует HMAC (timing-safe) → возвращает proposal
11. [TMA]     Показывает детали → User нажимает Approve
12. [TMA]     WebAuthn/Passkey биометрия → FaceID/TouchID
13. [TMA]     Формирует UserOperation → ZeroDev Kernel v3.1
14. [BFF]     POST /approve → SETNX lock → staleness check (eth_call)
15. [BFF]     Если OK → nullifier burn → forward UserOp
16. [ZeroDev] Bundler submits → Paymaster sponsors gas
17. [Mantle]  ActiveSentinel.executeArbitrage() → flash borrow → swap → swap → repay
18. [Mantle]  Profit → owner wallet
19. [TMA]     Shows tx hash + profit amount
```

---

## 10. Безопасность

### Криптографические гарантии:

| Вектор атаки | Защита |
|---|---|
| Компрометация TEE-ключа | Ключ IN-MEMORY, Remote Attestation доказывает целостность кода |
| Front-running / Sandwich | Private mempool (Flashbots Protect), deadline enforcement |
| Replay attack | 2D Nonces (sessionId, sequenceNumber) + nullifier burn |
| Reentrancy | EIP-1153 TSTORE guard (TransientReentrancyGuard) |
| Price manipulation | On-chain staleness check (slot0/getReserves) перед execution |
| HMAC forgery | HMAC-SHA256 + timing-safe comparison (no timing oracle) |
| Double execution | Optimistic lock (SETNX 60s) + nullifier |
| Gas vault drain | PaymasterRateLimiter (5 ops/min, 3 reverts → 15min block) |
| Unauthorized bot access | Whitelist middleware (silent drop non-TARGET_CHAT_ID) |
| Stale price execution | MAX_STALENESS_PCT check via eth_call before approve |

### Инварианты:

1. **Приватный ключ НИКОГДА не покидает TEE-анклав** — not logged, not persisted, not transmitted
2. **Каждый proposal подписан EIP-712** — верифицируемость on-chain
3. **Каждая транзакция требует biometric confirmation** — FaceID/TouchID через WebAuthn
4. **Nullifier одноразовый** — proposal нельзя исполнить дважды
5. **Profit invariant** — контракт revert если `actualProfit < minProfitTokenA`

---

## 11. Инфраструктура и DevOps

### Docker Compose

```yaml
services:
  redis:        # Redis 7 (Pub/Sub + State)
  agent-tee:    # TEE Agent (Phala CVM image)
  bff:          # Hono API Server
  tg-bot:       # Telegraf HITL Bot
  frontend:     # Vite dev server (dev only)
```

Все сервисы — `restart: unless-stopped`, healthchecks на каждый.

### CI/CD (.github/workflows/ci.yml)

**Jobs:**
1. `contracts` — Forge build + test + fmt check + gas report
2. `typescript` — Matrix [bff, agent-tee, devops] → npm install + vitest
3. `docker` — Docker build verification (all 3 images)
4. `integration` — Anvil fork Mantle → deploy → e2e flash arb test

### Dockerfiles:

- `agent-tee/Dockerfile` — Phala DStack compatible (базовый образ для CVM)
- `bff/Dockerfile` — Node.js 20 multi-stage
- `devops/Dockerfile` — Node.js 20 (Telegraf bot)

---

## 12. Технологический стек

### Blockchain / Smart Contracts:
- **Network:** Mantle (Chain ID 5000, L2)
- **Language:** Solidity 0.8.24
- **Framework:** Foundry (forge, cast, anvil)
- **Libraries:** OpenZeppelin Contracts
- **EIPs:** EIP-1153 (Transient Storage), EIP-712 (Typed Structured Data), EIP-4337 (Account Abstraction)

### TEE / Confidential Computing:
- **Platform:** Phala Network DStack (CVM — Confidential Virtual Machine)
- **Hardware:** Intel SGX / TDX
- **Attestation:** Remote Attestation (MRENCLAVE/MRSIGNER + custom reportData)

### Account Abstraction:
- **SDK:** @zerodev/sdk v5.5
- **Kernel:** v3.1 (`constants.KERNEL_V3_1`)
- **Validators:** Passkey (`toPasskeyValidator`, V0_0_3_PATCHED)
- **Features:** Session Keys, Paymaster (gas sponsorship), Bundler

### Backend:
- **Framework:** Hono (lightweight, edge-compatible)
- **Runtime:** Node.js 20
- **Database:** Redis 7 (state + Pub/Sub)
- **RPC Client:** viem (fallback transport, multicall)
- **Crypto:** ethers v6 (signing), Node.js crypto (HMAC)

### Frontend:
- **Framework:** React 18
- **Build:** Vite 5
- **Auth:** WebAuthn/Passkeys (biometric)
- **Platform:** Telegram Mini App (TMA)

### Bot:
- **Framework:** Telegraf v4
- **Transport:** Redis Pub/Sub
- **Pattern:** Dual Redis clients (subscriber + CRUD)

### Data / Analytics:
- **Provider:** Nansen
- **Protocol:** MCP (Model Context Protocol)
- **Data:** Smart Money wallets, transactions, token flows

### Testing:
- **Contracts:** Foundry (forge test, fuzz testing)
- **TypeScript:** Vitest
- **Integration:** Anvil fork (Mantle mainnet state)

---

## 13. Переменные окружения

### Shared:
| Variable | Service | Description |
|---|---|---|
| `REDIS_URL` | all | Redis connection string |
| `REDIS_PASSWORD` | docker | Redis auth password |
| `PROPOSAL_HMAC_SECRET` | bff, tg-bot | Shared HMAC secret |

### TEE Agent:
| Variable | Description |
|---|---|
| `REDIS_URL` | Redis for Pub/Sub |
| `NANSEN_API_KEY` | Nansen API credentials |
| `NANSEN_API_URL` | Nansen endpoint |
| `MANTLE_RPC_URL` | Mantle RPC (primary) |
| `ACTIVE_SENTINEL_ADDRESS` | Deployed contract |

### BFF:
| Variable | Description |
|---|---|
| `MANTLE_RPC_PRIMARY` | Primary RPC |
| `MANTLE_RPC_FALLBACKS` | Comma-separated fallback RPCs |
| `ACTIVE_SENTINEL_ADDRESS` | Contract address |
| `MAX_STALENESS_PCT` | Price staleness threshold (default: 2%) |
| `TMA_ORIGIN` | CORS allowed origin |
| `PORT` | Server port (default: 3001) |

### Telegram Bot:
| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot API token |
| `TARGET_CHAT_ID` | Whitelisted chat ID |
| `MINI_APP_URL` | TMA URL for inline buttons |
| `MAX_SLIPPAGE_PCT` | Slippage warning threshold |
| `PROPOSAL_TTL_SEC` | Proposal time-to-live |

### Frontend (Vite):
| Variable | Description |
|---|---|
| `VITE_BFF_URL` | BFF API base URL |
| `VITE_ZERODEV_PROJECT_ID` | ZeroDev project ID |
| `VITE_CHAIN_ID` | Target chain (5000) |

---

## 14. Roadmap

### ✅ Выполнено (Modules 1–5):
- [x] ActiveSentinel.sol + TransientReentrancyGuard + fuzz tests
- [x] TEE Agent: YieldArchitect, EIP-712, Remote Attestation, MEV Protection
- [x] BFF: HMAC, staleness, optimistic lock, nullifier burn
- [x] Frontend TMA: Passkeys, ZeroDev AA, biometric approval
- [x] Telegram Bot: HITL, whitelist, Pub/Sub, inline TMA links
- [x] Docker Compose + CI/CD pipeline

### 🔲 Следующие шаги:
- [ ] **Circuit Breaker** — автоматическая остановка при аномальных условиях
- [ ] **Formal Verification** — математическое доказательство инвариантов контракта
- [ ] **Multi-Path Arbitrage** — поддержка 3+ DEX pools в одной транзакции
- [ ] **Portfolio Dashboard** — историческая аналитика профитов
- [ ] **Multi-chain** — расширение на Arbitrum, Base (через bridged proposals)

---

## Локальный запуск

```bash
# 1. Клонировать
git clone git@github.com:rocknrolla77/alphaflow-suite.git
cd alphaflow-suite

# 2. Установить зависимости
cd contracts && forge install && cd ..
cd agent-tee && npm install && cd ..
cd bff && npm install && cd ..
cd devops && npm install && cd ..
cd frontend && npm install && cd ..

# 3. Настроить ENV
cp .env.example .env  # заполнить переменные

# 4. Запустить всё
docker compose up -d

# 5. Тесты
cd contracts && forge test -vvv
cd ../bff && npm test
cd ../agent-tee && npm test
```

---

*Последнее обновление: май 2025*
*Автор: @rocknrolla77*
