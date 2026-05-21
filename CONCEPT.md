# AlphaFlow Suite

## Agentic Commerce Infrastructure on Mantle Network

---

## 1. Концепция

AlphaFlow Suite — инфраструктура автономной торговли (Agentic Commerce),
объединяющая три технологических столпа:

- **Аппаратная конфиденциальность AI** — Phala Network TEE (Trusted Execution Environment)
- **Абстракция аккаунтов** — ZeroDev ERC-4337 (Kernel v3 + Session Keys + Passkeys)
- **Аналитика институционального уровня** — Nansen MCP (Model Context Protocol)

Проект решает фундаментальную проблему: как предоставить розничному инвестору
стратегии институционального уровня, сохраняя при этом полный контроль над
средствами и криптографическую верифицируемость каждого решения AI-агента.

---

## 2. Проблема

### 2.1 Для пользователя

Розничные инвесторы не имеют доступа к:
- Данным о движении "умных денег" (фонды, VC, Smart Traders)
- Скорости исполнения flash-арбитража (требует < 1 блока)
- Инструментам risk-нормализации (адаптация объёма под свой портфель)

### 2.2 Для индустрии

Существующие решения (торговые боты, copy-trading) имеют критические недостатки:
- **Непрозрачность** — невозможно доказать, что AI принял решение на основе данных, а не произвольно
- **Кастодиальность** — пользователь передаёт приватный ключ боту
- **MEV-уязвимость** — транзакции видны в публичном мемпуле

---

## 3. Решение: Архитектура AlphaFlow Suite

```
┌─────────────────────────────────────────────────────────────────────┐
│  PHALA TEE (Confidential Virtual Machine)                           │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  agent-tee/                                                   │  │
│  │                                                               │  │
│  │  ┌─────────────┐   ┌────────────────┐   ┌────────────────┐   │  │
│  │  │ Nansen MCP  │──▸│ YieldArchitect │──▸│ EIP-712 Signer │   │  │
│  │  │  (Fetcher)  │   │  (Strategy)    │   │  (Proof-of-    │   │  │
│  │  └─────────────┘   └────────────────┘   │   Reasoning)   │   │  │
│  │                                          └───────┬────────┘   │  │
│  │                                                  │            │  │
│  │  ┌──────────────────┐   ┌────────────────────┐  │            │  │
│  │  │ Remote           │   │ SentinelExecutor   │◂─┘            │  │
│  │  │ Attestation      │   │ (2D Nonces + MEV)  │               │  │
│  │  │ (SGX/TDX Quote)  │   └────────────────────┘               │  │
│  │  └──────────────────┘                                         │  │
│  └───────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ Redis Pub/Sub
┌──────────────────────────────▼──────────────────────────────────────┐
│  GCP Instance (BFF + Services)                                      │
│                                                                     │
│  ┌──────────┐   ┌──────────────────────┐   ┌──────────────────┐    │
│  │ TG Bot   │   │ BFF (Hono)           │   │ Redis (AOF)      │    │
│  │ (HITL)   │   │ - HMAC verify        │   │ - Proposal store │    │
│  │          │   │ - Staleness check    │   │ - Nullifier      │    │
│  │          │   │ - On-chain simulate  │   │ - Rate limiter   │    │
│  └────┬─────┘   │ - Optimistic lock    │   └──────────────────┘    │
│       │         └──────────┬───────────┘                            │
│       │                    │ OnChainWatcher (event polling)          │
└───────┼────────────────────┼────────────────────────────────────────┘
        │                    │
        ▼                    ▼
┌──────────────┐   ┌────────────────────────────────────────────────┐
│ Telegram     │   │  Telegram Mini App (TMA)                       │
│ User Chat    │   │                                                │
│              │   │  ┌──────────────┐  ┌─────────────────────────┐ │
│ "Proposal    │   │  │ WebAuthn     │  │ ZeroDev SDK             │ │
│  received"   │   │  │ Detection +  │  │ Passkey → Kernel v3     │ │
│              │   │  │ Fallback     │  │ → Gasless UserOp        │ │
│ [Approve]    │   │  └──────────────┘  └─────────────────────────┘ │
└──────────────┘   └────────────────────────────────────────────────┘
                                    │
                                    ▼
                   ┌────────────────────────────────────┐
                   │  Mantle Network (Chain ID: 5000)   │
                   │                                    │
                   │  ┌──────────────────────────────┐  │
                   │  │ ActiveSentinel.sol            │  │
                   │  │ - EIP-1153 TSTORE reentrancy │  │
                   │  │ - INIT Capital flash borrow  │  │
                   │  │ - Merchant Moe + Agni swap   │  │
                   │  │ - Invariant profit check     │  │
                   │  └──────────────────────────────┘  │
                   │                                    │
                   │  ┌──────────────────────────────┐  │
                   │  │ ZeroDev Kernel v3            │  │
                   │  │ - Session Key Validator      │  │
                   │  │ - Passkey (WebAuthn) Owner   │  │
                   │  │ - EntryPoint v0.7            │  │
                   │  └──────────────────────────────┘  │
                   └────────────────────────────────────┘
```

---

## 4. Модули системы

### 4.1 Smart Contracts (contracts/)

**Файл:** `ActiveSentinel.sol`

Ядро исполнения — атомарный flash-арбитраж на Mantle Network.

**Механика:**
1. TEE-агент рассчитывает арбитражную возможность off-chain
2. Вызывает `executeFlashArbitrage(params)` через Session Key
3. Контракт берёт flash borrow у INIT Capital (0% fee)
4. Выполняет swap A→B на Merchant Moe
5. Выполняет swap B→A на Agni Finance
6. Возвращает долг INIT Capital
7. Проверяет инвариант: `actualProfit >= minProfitTokenA`

**Защиты:**
- Reentrancy: EIP-1153 `TSTORE`/`TLOAD` (transient storage, 100 gas vs 20,000 SSTORE)
- Profit invariant: revert если profit < threshold (рассчитан TEE)
- Auth: только owner (ZeroDev Kernel account)
- Slippage: `amountOutMinRoute1` / `amountOutMinRoute2` per-route

**Gas:** ~268,000 (median, full arbitrage cycle)

---

### 4.2 Account Abstraction (ZeroDev + Session Keys)

**Архитектура кошелька:**
```
Owner (Passkey/WebAuthn)
    └── ZeroDev Kernel v3 (Smart Account)
            └── Session Key Validator
                    └── TEE Agent Signer (scoped)
```

**Session Key Policies (защита от компрометации TEE):**

| Policy | Ограничение | Назначение |
|--------|-------------|------------|
| Target | Только ActiveSentinel address | Нельзя вызвать другие контракты |
| Selector | Только `executeFlashArbitrage` | rescue/rescueNative заблокированы |
| Value | 0 MNT | Нельзя вывести нативный токен |
| Gas | maxFeePerGas ≤ 50 gwei, limit 500k | Защита Gas Vault от drain |
| Time | 24h validity + pre-rotation | Автоматическое истечение |

**2D Nonces:**
- Ключ: `uint192(keccak256(tokenA, tokenB, dexPayloadRoute1))`
- Позволяет параллельные UserOps для разных торговых пар
- Устраняет коллизию: USDC→WMNT и USDC→FBTC имеют разные nonce lanes

---

### 4.3 TEE Agent — Yield Architect (agent-tee/)

AI-агент, работающий исключительно внутри аппаратного анклава (Phala Network CVM).

**Компоненты:**

#### Nansen MCP Client
- Подключение к Nansen API через Model Context Protocol
- Фильтрация кошельков: теги "Fund", "VC", "90D Smart Trader"
- Rate limiting: 10 req/min, exponential backoff
- Кэширование: Redis с TTL

#### Strategy Engine (YieldArchitect)
Формула расчёта объёма:
```
W = S_smart / V_smart
S_user = V_user × W × K_risk
```

Где:
- `S_smart` — объём сделки Smart Money кошелька
- `V_smart` — общий капитал этого кошелька
- `V_user` — баланс пользователя
- `K_risk` — коэффициент консерватизма (0.1 = conservative, 1.0 = aggressive)

#### EIP-712 Proof-of-Reasoning
Каждый Proposal подписывается изолированным ключом анклава:
```
struct Proposal {
    address asset;
    string action;       // "BUY" | "SELL"
    uint256 recommendedAmount;
    uint256 timestamp;
    uint256 nonce;       // Monotonic, replay protection
    uint256 deadline;    // Auto-expire
    bytes32 reasoningHash;
}
```

`reasoningHash` = keccak256(signal_data + profile + computation_steps)
Доказывает: решение принято алгоритмом на основе конкретных данных.

#### Remote Attestation (SGX/TDX)
- Генерация Quote через Phala DStack API
- `reportData` привязан к Proposal (hash + signer + nonce)
- Верификация: DCAP on-chain или Intel IAS
- Доказывает: код не модифицирован администратором сервера

#### SentinelExecutor
- Rate Limiter: 5 ops/min, 30 ops/hour, lockout после 3 reverts
- MEV Protection: маршрутизация через приватный bundler (Pimlico)
- Gas price validation: отклоняет аномалии до отправки
- Pre-emptive key rotation: за 1 час до expiry Session Key

---

### 4.4 Backend-for-Frontend — BFF (bff/)

Легковесный API-сервер (Hono/Node.js) между TMA и блокчейном.

**Принцип:** BFF не хранит приватных ключей. Он только верифицирует и проксирует.

**Эндпоинты:**

| Method | Path | Назначение |
|--------|------|------------|
| GET | /api/proposal/:id | HMAC verify → staleness check → return EIP-712 payload |
| POST | /api/proposal/:id/simulate | eth_call dry-run (off-chain simulation) |
| POST | /api/proposal/:id/consume | Burn nullifier after execution |
| GET | /api/health | Redis + RPC status |

**Ключевые механизмы:**

1. **HMAC Verification** — timing-safe comparison, secret только на сервере
2. **Staleness Check** — цена из on-chain oracle (не от frontend!)
3. **Optimistic Lock** — status="dispensed" с TTL 60s до выдачи payload
4. **RPC Fallback** — viem `fallback()` transport с auto-ranking
5. **OnChainWatcher** — отслеживает events, синхронизирует state при TMA crash

---

### 4.5 Telegram HITL Bot (devops/src/tg-bot/)

Human-in-the-Loop через Telegram — транспортный уровень.

**Поток:**
1. TEE публикует Proposal в Redis Pub/Sub
2. Bot получает событие, форматирует сообщение
3. Отправляет inline keyboard с WebApp кнопкой
4. Пользователь нажимает → открывается TMA

**Защиты:**
- Owner-only middleware (whitelist chat_id)
- HMAC-подписанный proposalId в deep-link
- Nullifier: каждый reasoningHash — одноразовый
- TTL: proposal auto-expires (5 мин по умолчанию)

**Команды:**
- `/status` — pending proposals + system health
- `/unblock` — force-unblock rate limiter
- `/pause` / `/resume` — остановка/возобновление агента

---

### 4.6 Telegram Mini App — Frontend (frontend/)

React-приложение внутри Telegram WebView.

**Архитектура:** TMA = read-only UI + Passkey signer. Логика на BFF.

**WebAuthn Fallback:**
```
if (WebView supports WebAuthn) → Passkey signing in-app
else → "Open in External Browser" (Safari/Chrome)
```

**Поток исполнения:**
1. Parse `startapp` parameter (base64url: {pid, sig})
2. Request BFF `/api/proposal/:id` с HMAC header
3. BFF verifies HMAC → checks staleness → returns EIP-712 payload
4. TMA calls ZeroDev SDK → Passkey prompt (FaceID/TouchID)
5. Signed UserOp → Bundler → Mantle Network
6. TMA calls BFF `/consume` → nullifier burned

**Anti-double-click:** `executionLockRef` — кнопка disabled после первого клика.

---

## 5. Security Model

### 5.1 Уровни защиты (Defense in Depth)

```
Layer 1: Smart Contract (on-chain)
  ├── EIP-1153 reentrancy guard
  ├── Profit invariant (revert if unprofitable)
  └── Slippage protection per route

Layer 2: Account Abstraction
  ├── Session Key scoping (target + selector + gas + time)
  ├── Passkey owner (hardware-bound, non-exportable)
  └── 2D Nonces (collision-free parallelism)

Layer 3: TEE (Phala Network)
  ├── Code isolation (MRENCLAVE attestation)
  ├── Key isolation (private key never leaves enclave)
  └── Remote Attestation (SGX Quote → verifiable on-chain)

Layer 4: Application Logic
  ├── Rate Limiter (5 ops/min, lockout on revert spam)
  ├── Session Key Rotator (pre-emptive, T-1h)
  ├── HMAC-signed deep links (no secret on client)
  └── Optimistic lock (state desync prevention)

Layer 5: Infrastructure
  ├── RPC fallback (multi-provider, auto-ranking)
  ├── Redis AOF (FSM state recovery on crash)
  ├── On-chain watcher (event-driven state sync)
  └── MEV protection (private bundler routing)
```

### 5.2 Threat Model

| Угроза | Митигация |
|--------|-----------|
| TEE компрометация | Session Key scope: только 1 функция, 50 gwei cap |
| Replay attack | nonce + deadline + nullifier в Redis |
| Gas drain (revert spam) | Rate limiter + 3-strike lockout |
| Nonce collision | Route-based 2D nonce key (full path hash) |
| Session Key expiry race | Pre-emptive rotation (T-1h), dead zone halt |
| Frontend oracle spoofing | BFF fetches price on-chain, not from client |
| Telegram session hijack | Bot = transport only, signing via Passkey |
| HMAC leak in client | Secret only on BFF server, one-time sig in URL |
| TMA crash after signing | OnChainWatcher + optimistic lock + auto-revert |
| RPC single point of failure | viem fallback() with rank:true |
| WebView WebAuthn blocked | Progressive detection + external browser fallback |
| Server disk overflow | Logrotate 50M + daily cron cleanup |
| Admin modifies TEE code | Remote Attestation (MRENCLAVE immutable hash) |
| Sandwich attack (MEV) | Private bundler (Pimlico), not public mempool |

---

## 6. Математическая модель

### 6.1 Flash Arbitrage (ActiveSentinel)

Условие прибыльности:
```
P_route1 × P_route2 > 1 + fee_INIT + fee_gas
```

Где:
- `P_route1` = price ratio на Merchant Moe (tokenA → tokenB)
- `P_route2` = price ratio на Agni Finance (tokenB → tokenA)
- `fee_INIT` = flash borrow fee (0% на INIT Capital)
- `fee_gas` = gas cost в единицах tokenA

Атомарность: если условие нарушено → `revert InvariantViolated()`

### 6.2 Smart Money Tracking (YieldArchitect)

```
Signal: Smart Money wallet W purchases asset A
  S_smart = trade volume ($)
  V_smart = total portfolio value ($)

Weight: W = S_smart / V_smart
  (Conviction: какая доля портфеля направлена в сделку)

User sizing: S_user = V_user × W × K_risk
  V_user = user's available balance
  K_risk ∈ [0.1, 1.0] = risk tolerance factor

Confidence: aggregated across N wallets
  C = (Σ W_i × reputation_i) / N
```

### 6.3 Gas Economics (Mantle)

Mantle использует dual-fee model:
- L2 execution gas: ~268,000 gas per arbitrage
- L1 data posting: минимальный (rollup compression)

При maxFeePerGas = 50 gwei:
```
Max cost per op = 268,000 × 50 × 10^-9 = 0.0134 MNT
Daily cap (30 ops/hour × 24h) = 720 ops × 0.0134 = 9.648 MNT
```

---

## 7. Tech Stack

| Layer | Technology | Версия |
|-------|-----------|--------|
| Smart Contracts | Solidity, Foundry | 0.8.24, cancun EVM |
| Chain | Mantle Network | Chain ID 5000 |
| Flash Loans | INIT Capital | Liquidity Hooks |
| DEX 1 | Merchant Moe | LB AMM (Liquidity Book) |
| DEX 2 | Agni Finance | Concentrated Liquidity (Uni V3) |
| Account Abstraction | ZeroDev Kernel v3 | ERC-4337 v0.7 |
| Session Keys | @zerodev/session-key | Scoped permissions |
| Owner Auth | Passkeys (WebAuthn) | FIDO2, P-256 |
| TEE | Phala Network DStack | Intel TDX/SGX CVM |
| Attestation | DCAP / Intel IAS | SGX Quote v3 |
| Smart Money Data | Nansen | MCP Protocol |
| Backend | Hono (Node.js) | TypeScript |
| State Store | Redis | AOF persistence |
| Frontend | React + Vite | TypeScript, TMA SDK |
| Bot | Telegraf.js | Telegram Bot API |
| DevOps | Docker Compose | Multi-service |
| CI/CD | GitHub Actions | forge + vitest + docker |
| RPC | Alchemy + Ankr + Public | viem fallback |
| MEV Protection | Pimlico Private Bundler | ERC-4337 native |

---

## 8. Монорепозиторий

```
alphaflow-suite/
├── contracts/
│   ├── foundry.toml
│   ├── src/
│   │   ├── ActiveSentinel.sol
│   │   ├── interfaces/
│   │   │   ├── IINITCore.sol
│   │   │   ├── IFlashBorrower.sol
│   │   │   └── IDexRouter.sol
│   │   └── libraries/
│   │       └── TransientReentrancyGuard.sol
│   ├── test/
│   │   └── ActiveSentinel.t.sol
│   ├── script/
│   │   └── Deploy.s.sol
│   └── lib/ (git submodules)
│       ├── forge-std/
│       └── openzeppelin-contracts/
│
├── agent-tee/
│   ├── Dockerfile (Phala CVM compatible)
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── main.ts (entry point + health server)
│       ├── executor.ts (SentinelExecutor + 2D Nonces)
│       ├── types/index.ts
│       ├── strategies/
│       │   └── yieldArchitect.ts (Strategy Engine + EIP-712)
│       ├── services/
│       │   ├── nansenClient.ts (Nansen MCP)
│       │   ├── rateLimiter.ts (Gas drain protection)
│       │   ├── sessionKeyRotator.ts (Pre-emptive rotation)
│       │   ├── remoteAttestation.ts (SGX/TDX Quote)
│       │   ├── mevProtection.ts (Private bundler)
│       │   └── proposalPublisher.ts (Redis Pub/Sub)
│       └── test/
│           └── yieldArchitect.test.ts
│
├── bff/
│   ├── Dockerfile
│   ├── package.json
│   ├── .env.example
│   └── src/
│       ├── index.ts (Hono API + HMAC + staleness + simulate)
│       ├── rpcFallback.ts (Multi-RPC viem fallback)
│       ├── onChainWatcher.ts (Event-driven state sync)
│       └── test/
│           └── api.test.ts
│
├── frontend/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── components/
│       │   └── InvestFlowApp.tsx (Main TMA UI)
│       ├── hooks/
│       │   └── useWebAuthnSupport.ts (Detection + fallback)
│       ├── utils/
│       │   ├── bffClient.ts (API client + startapp parser)
│       │   └── sessionKeySetup.ts (ZeroDev Session Key creation)
│       ├── config/
│       │   ├── constants.ts
│       │   └── mantle.ts (Chain definition)
│       └── test/
│           └── sessionKey.test.ts
│
├── devops/
│   ├── Dockerfile
│   ├── package.json
│   ├── .env.example
│   ├── setup-debian.sh (Server hardening)
│   └── src/tg-bot/
│       ├── index.ts (Telegraf bot + Redis Pub/Sub)
│       ├── config.ts (Zod-validated env)
│       ├── proposalStore.ts (Redis + nullifier + HMAC)
│       └── test/
│           └── proposalStore.test.ts
│
├── docker-compose.yml (Full stack: Redis + BFF + Bot + Agent-Dev + Anvil)
├── .github/workflows/ci.yml (Forge + Vitest + Docker + Integration)
└── README.md
```

---

## 9. Data Flow (End-to-End)

### 9.1 Flash Arbitrage (автоматический)

```
1. TEE Agent: Nansen MCP → обнаружена ценовая дислокация
2. TEE Agent: симуляция прибыли off-chain (ethers staticCall)
3. TEE Agent: если profit > threshold →
4.   RateLimiter: проверка лимита (5 ops/min)
5.   SessionKeyRotator: проверка validity (не в dead zone)
6.   MevProtection: выбор приватного bundler
7.   SentinelExecutor: кодирование calldata + 2D nonce key
8.   ZeroDev SDK: подпись UserOp session key
9.   Bundler: submit → EntryPoint → Kernel → ActiveSentinel
10.  On-chain: flashBorrow → swap A→B → swap B→A → repay → invariant check
11.  Result: profit остаётся на Kernel account
```

### 9.2 Yield Architect Proposal (с участием пользователя)

```
1. TEE Agent: Nansen MCP → Smart Money (Fund/VC) купил Asset X
2. YieldArchitect: W = S_smart / V_smart
3. YieldArchitect: S_user = V_user × W × K_risk
4. EIP-712: sign Proposal (asset, amount, nonce, deadline, reasoningHash)
5. RemoteAttestation: генерация SGX Quote (reportData = hash(proposal))
6. ProposalPublisher: Redis PUBLISH "tee_proposals" (JSON + signature + quote)
7. TG Bot: получает event → формирует сообщение → inline keyboard [Approve]
8. User: нажимает [Approve] → Telegram открывает TMA WebView
9. TMA: parse startapp → request BFF /api/proposal/:id (HMAC header)
10. BFF: verify HMAC → check deadline → staleness (on-chain price) → optimistic lock
11. BFF: return EIP-712 payload + execution calldata
12. TMA: ZeroDev SDK → Passkey prompt → sign UserOp
13. Bundler: submit → Kernel executes → on-chain result
14. TMA: BFF /consume → nullifier burned
15. (Fallback): OnChainWatcher → event detected → mark executed
```

---

## 10. Deployment

### 10.1 Контракты (Mantle Mainnet)

```bash
cd contracts/
export PRIVATE_KEY=...
export MANTLE_RPC_URL=https://rpc.mantle.xyz

forge script script/Deploy.s.sol \
    --rpc-url $MANTLE_RPC_URL \
    --broadcast \
    --verify \
    --etherscan-api-key $MANTLESCAN_API_KEY
```

### 10.2 TEE Agent (Phala DStack)

```bash
cd agent-tee/
docker build -t alphaflow-agent-tee .

# Deploy to Phala CVM
dstack deploy \
    --image alphaflow-agent-tee \
    --env-file .env.production \
    --attestation-mode dcap
```

### 10.3 Infrastructure (Docker Compose)

```bash
# Development
docker compose up -d

# With test anvil fork
docker compose --profile test up -d

# Production (without dev agent)
docker compose up -d redis bff tg-bot
```

---

## 11. Конкурентные преимущества

| Аспект | Конкуренты (3Commas, Maestro) | AlphaFlow Suite |
|--------|-------------------------------|-----------------|
| Кастодиальность | Пользователь даёт API key / PK | Non-custodial (Passkey owner) |
| Прозрачность AI | Black box | Proof-of-Reasoning (EIP-712 + Attestation) |
| MEV защита | Нет (публичный мемпул) | Private bundler (Pimlico) |
| Данные | Публичные индикаторы | Институциональные (Nansen Smart Money) |
| Безопасность | Централизованный сервер | TEE (аппаратная изоляция кода и ключей) |
| Gas efficiency | EOA транзакции | ERC-4337 (batching, session keys, gasless) |
| Сеть | Ethereum mainnet (дорого) | Mantle L2 ($0.01 per tx) |
| Human control | Полная автоматика | HITL (Telegram approval для крупных сделок) |

---

## 12. Roadmap

### Phase 1 — MVP (Завершено)
- [x] ActiveSentinel.sol (EIP-1153, flash arbitrage)
- [x] ZeroDev Session Keys (5 policies)
- [x] TEE Agent (YieldArchitect + executor)
- [x] Telegram HITL Bot
- [x] TMA Frontend (WebAuthn + fallback)
- [x] BFF (HMAC + staleness + simulation)
- [x] DevOps (Docker, CI, server hardening)

### Phase 2 — Hardening
- [ ] Circuit Breaker (flash crash detection, anomaly halt)
- [ ] Formal verification (Certora/Halmos для ActiveSentinel)
- [ ] Multi-path arbitrage (3+ DEX routing)
- [ ] Prometheus + Grafana monitoring
- [ ] Telegram alerts (disk, OOM, rate limiter lockout)

### Phase 3 — Scale
- [ ] Multi-chain (Mantle → Base → Arbitrum)
- [ ] Portfolio rebalancing module
- [ ] DAO governance for risk parameters
- [ ] Mobile app (React Native + Passkey)
- [ ] Institutional API (white-label)

---

## 13. Заключение

AlphaFlow Suite демонстрирует, что Agentic Commerce может быть одновременно:
- **Автономным** — AI-агент принимает решения и исполняет без задержки
- **Верифицируемым** — каждое решение подписано и аттестовано аппаратно
- **Безопасным** — пользователь никогда не теряет контроль над средствами
- **Доступным** — институциональные стратегии через Telegram Mini App

Ключевая инновация: **Proof-of-Reasoning** — криптографическое доказательство того,
что AI-решение принято на основе конкретных данных, в немодифицированном коде,
внутри аппаратного анклава. Это создаёт новый стандарт доверия для AI-агентов
в финансах.

---

*AlphaFlow Suite — Winner, DoraHacks Mantle Hackathon*
*Built on: Mantle Network × Phala TEE × ZeroDev × Nansen MCP*
