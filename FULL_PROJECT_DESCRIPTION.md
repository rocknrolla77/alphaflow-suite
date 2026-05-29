# AlphaFlow Suite — Полное описание проекта

> AI-powered flash arbitrage система на Mantle Network с TEE-защитой, Human-in-the-Loop подтверждением и ERC-8004 идентификацией агента.

**Победитель DoraHacks Mantle Hackathon**

---

## Оглавление

1. [Обзор архитектуры](#обзор-архитектуры)
2. [Модуль 1: Smart Contracts (contracts/)](#модуль-1-smart-contracts)
3. [Модуль 2: TEE Agent (agent-tee/)](#модуль-2-tee-agent)
4. [Модуль 3: BFF Server (bff/)](#модуль-3-bff-server)
5. [Модуль 4: Telegram Mini App (frontend/)](#модуль-4-telegram-mini-app)
6. [Модуль 5: DevOps / Telegram Bot (devops/)](#модуль-5-devops--telegram-bot)
7. [Инфраструктура и деплой](#инфраструктура-и-деплой)
8. [Безопасность](#безопасность)
9. [Потоки данных (End-to-End)](#потоки-данных-end-to-end)
10. [Переменные окружения](#переменные-окружения)
11. [Статус и roadmap](#статус-и-roadmap)

---

## Обзор архитектуры

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          AlphaFlow Suite                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌──────────────┐    Redis Pub/Sub    ┌──────────────┐                   │
│  │  agent-tee   │ ──────────────────► │   devops/    │                   │
│  │  (Phala TEE) │                     │   tg-bot     │                   │
│  └──────┬───────┘                     └──────┬───────┘                   │
│         │                                    │                            │
│         │ EIP-712 signed proposals           │ Inline keyboard            │
│         ▼                                    ▼ (Approve/Reject)           │
│  ┌──────────────┐    HMAC + Lock      ┌──────────────┐                   │
│  │    Redis     │ ◄────────────────── │   frontend/  │                   │
│  │   (store)    │                     │  TMA (React) │                   │
│  └──────┬───────┘                     └──────┬───────┘                   │
│         │                                    │                            │
│         │ Proposal data                      │ WebAuthn Passkeys          │
│         ▼                                    ▼                            │
│  ┌──────────────┐    Simulate + Exec  ┌──────────────────┐               │
│  │  bff/ (Hono) │ ──────────────────► │  Mantle Network  │               │
│  │  Port 3001   │                     │  (Smart Contracts)│               │
│  └──────────────┘                     └──────────────────┘               │
│                                                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

### Технологический стек

| Слой | Технологии |
|------|-----------|
| Blockchain | Mantle Network (L2 Ethereum), Solidity 0.8.24, EVM Cancun (EIP-1153) |
| Smart Contracts | Foundry, OpenZeppelin, ERC-8004 (AI Agent Identity) |
| TEE Agent | TypeScript, Phala DStack SDK, OpenAI GPT-4, viem |
| Account Abstraction | ZeroDev SDK, Kernel v3.1, Passkey Validator, Session Keys |
| BFF Server | Hono ^4.4, Node.js ≥20, ioredis, viem, Zod |
| Frontend | React 18, Vite, @telegram-apps/sdk, @tonconnect/ui-react, WebAuthn |
| Bot | Grammy (Telegram), ioredis |
| Infra | Redis 7 (AOF), GCP VM, Cloudflare Quick Tunnel |
| Data | Nansen API (smart money), Pyth Network (oracles) |
| DEXs | INIT Capital (flash loans), Merchant Moe, Agni Finance |

---

## Модуль 1: Smart Contracts

**Путь:** `contracts/`  
**Язык:** Solidity 0.8.24  
**Фреймворк:** Foundry (forge)  
**Тесты:** 57/57 passing (4 test suites)

### 1.1 ActiveSentinel.sol (371 строк) — Ядро исполнения

Основной контракт для flash-арбитража:

- **Flash Borrow** от INIT Capital (бесплатный займ в одной транзакции)
- **2-ноги арбитраж:** Route1 (Merchant Moe: TokenA→TokenB) + Route2 (Agni: TokenB→TokenA)
- **Гибридная защита от reentrancy:** TSTORE (EIP-1153, 100 gas) + SSTORE (fallback)
- **EIP-712 верификация подписи** от авторизованного TEE агента
- **Token whitelist** — только одобренные токены
- **Nonce replay protection** — предотвращение повторного исполнения
- **ERC-8004 интеграция** — связь с IdentityRegistry (agentId)
- **Admin функции:** rescue tokens, update TEE agent address, manage whitelist

**Ключевые функции:**
```solidity
function executeFlashArbitrage(ArbParams calldata params, bytes calldata signature) external
function onFlashBorrow(address token, uint256 amount, bytes calldata data) external  // callback
function rescueToken(address token, uint256 amount) external onlyOwner
function setTeeAgent(address newAgent) external onlyOwner
```

**Структура ArbParams (EIP-712 typed):**
```solidity
struct ArbParams {
    address tokenBorrow;      // Какой токен занимаем
    uint256 amountBorrow;     // Сколько
    address route1Adapter;    // Merchant Moe adapter
    bytes route1Payload;      // Параметры свапа
    address route2Adapter;    // Agni adapter
    bytes route2Payload;      // Параметры свапа
    uint256 minProfit;        // Минимальная прибыль (иначе revert)
    uint256 deadline;         // Unix timestamp дедлайн
    uint256 nonce;            // Replay protection
    bytes32 reasoningHash;    // keccak256 от LLM reasoning (прозрачность)
}
```

### 1.2 SentinelIdentity.sol (118 строк) — Agent NFT Registry

ERC-721 NFT для идентификации AI-агента:

- Одна подписка = один агент (soulbound-like, нетрансферабельный)
- Хранит Agent Card URI (ipfs://)
- `registerAgent()` — минт NFT
- `updateAgentCard()` — ротация URI метаданных
- Обратный маппинг `agentOf[address]` для поиска

### 1.3 AlphaAuditor.sol (90 строк) — Proof-of-Alpha

Gas-оптимизированный реестр инсайтов:

- Хранит `keccak256(insight)` только как event (не в storage — экономия газа)
- Только зарегистрированные агенты могут коммитить
- Счётчик коммитов на агента
- CEI (Checks-Effects-Interactions) паттерн

### 1.4 ReputationRegistry.sol (213 строк) — On-chain Репутация

Пакетная система репутации:

- Oracle (BFF Relayer) присылает агрегированные голоса пользователей
- `int128` кумулятивный скор (поддерживает отрицательные значения)
- `postFeedbackBatch(agentId, scoreDelta, votersCount, metadata)` — один агент
- `postFeedbackBatchMulti(agentIds[], scoreDeltas[], votersCounts[], metadata)` — массовый
- Overflow detection + ротация oracle

### 1.5 ERC-8004 IdentityRegistry.sol (175 строк)

Полная реализация стандарта ERC-8004 для AI-агентов:

- ERC-721 + URIStorage (JSON metadata on IPFS)
- **Soulbound** (трансферы заблокированы через `_update` override)
- `registerAgent(owner, agentCardURI)` — кто угодно может зарегистрировать
- Agent Card JSON спецификация: name, description, capabilities[], endpoints{}, paymentAddresses{}

### 1.6 ERC-8004 ValidationRegistry.sol (309 строк)

Криптографическая валидация агентов TEE-оракулами:

- `requestValidation` — запрос аудита агента
- `submitValidation` — валидатор отправляет результат + SGX attestation
- Один валидатор = один ответ на запрос
- Трекинг approval rate
- Off-chain flow: request → TEE oracle аудит → submit on-chain

### 1.7 Адаптеры DEX

**MerchantMoeAdapter.sol (125 строк):**
- UniV2-style bin liquidity (Merchant Moe)
- `swapExactTokensForTokens` wrapper
- Pull/push pattern (токены через адаптер)

**AgniAdapter.sol (130 строк):**
- UniV3-style concentrated liquidity (Agni Finance)
- `exactInputSingle` wrapper
- Параметры: fee tier, deadline, sqrtPriceLimitX96

### 1.8 Библиотеки и интерфейсы

- `TransientReentrancyGuard.sol` — EIP-1153 transient storage guard (100 gas vs 5000)
- `IDexRouter.sol` — унифицированный DEX swap interface
- `IFlashBorrower.sol` — INIT Capital callback interface
- `IINITCore.sol` — INIT Capital flash borrow initiation

### 1.9 Deploy Script (script/Deploy.s.sol, 160 строк)

- Деплоит все 6 контрактов в правильном порядке зависимостей
- Post-deploy: регистрация TEE агента, добавление валидатора, инъекция адресов
- Выводит deployment summary со всеми адресами

### 1.10 Тесты

| Файл | Тесты | Описание |
|------|-------|----------|
| ActiveSentinel.t.sol | Unit tests | Flash arb execution |
| ActiveSentinelSecurity.t.sol | Security (885 строк) | Reentrancy, signature replay, unauthorized access |
| DexAdapters.t.sol | Integration | Adapter swap tests с моками |
| SentinelModule1.t.sol | Unit tests | Identity + AlphaAuditor |

---

## Модуль 2: TEE Agent

**Путь:** `agent-tee/`  
**Язык:** TypeScript  
**Runtime:** Phala DStack (TEE — Trusted Execution Environment)  
**Файлов:** 19 .ts  
**Тесты:** 22 (сломаны — нужен рефакторинг yieldArchitect)

### 2.1 main.ts — Главный оркестратор

Polling-based pipeline, работающий внутри TEE:

```
1. Nansen API → Свежие транзакции smart money кошельков
2. Bloom Filter → Дедупликация (O(1), false positive rate настраиваемый)
3. txEnrichment → Обогащение (symbols, USD values, labels)
4. clusteringEngine → Группировка похожих транзакций
5. llmEngine → GPT-4 анализ, conviction scoring
6. proposalPublisher → Публикация в Telegram (через Redis pub/sub)
7. executor → On-chain исполнение одобренных предложений
```

Включает:
- Health check HTTP server
- Graceful shutdown (SIGTERM/SIGINT)
- Session key rotation schedule
- Error recovery и retry

### 2.2 executor.ts — On-chain исполнение

- viem + ZeroDev (ERC-4337 Account Abstraction)
- Построение EIP-712 signed ArbParams
- Flash arbitrage транзакции в ActiveSentinel
- Session keys для gasless execution
- Retry logic, nonce management
- MEV protection (Flashbots-style bundle submission)

### 2.3 types/index.ts — Типы

```typescript
interface EnrichedTransaction {
  hash: string;
  from: string;
  to: string;
  walletLabel: string;        // e.g. "Paradigm", "Jump Trading"
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  usdValue: number;
  txType: 'swap' | 'stake' | 'unstake' | 'bridge';
  rwaClassification?: string;
  timestamp: number;
}

interface Cluster {
  id: string;
  transactions: EnrichedTransaction[];
  similarity: number;
  dominantToken: string;
  dominantDirection: 'buy' | 'sell';
}

interface LLMInsight {
  convictionScore: number;    // 0-1
  reasoning: string;
  proposedAction: 'long' | 'short' | 'yield' | 'skip';
  targetAsset: string;
  suggestedSize: number;
  reasoningHash: string;      // keccak256 для on-chain
}

interface Proposal {
  id: string;
  insight: LLMInsight;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'executed';
  createdAt: number;
  deadline: number;
  arbParams?: ArbParams;
}
```

### 2.4 Стратегии

**clusteringEngine.ts:**
- Группировка по token-pair similarity
- Temporal proximity (в пределах time windows)
- Wallet label correlation (один label = выше вес)
- Настраиваемые thresholds
- Выход: ranked clusters для LLM

**yieldArchitect.ts:**
- RWA (Real World Asset) yield стратегия
- Анализ mETH, cmETH, USDY позиций на Mantle
- Оптимальная аллокация: staking / restaking / T-bill yield
- Risk scoring по типу актива
- Генерация yield proposals с APY estimates

**llmEngine.ts:**
- OpenAI GPT-4 с structured prompts
- Вход: clustered transactions + wallet labels
- Выход: conviction scores (0-1), directional signals, reasoning
- Chain-of-thought prompt engineering
- Хеширование reasoning для on-chain прозрачности

### 2.5 Сервисы

| Сервис | Описание |
|--------|----------|
| `nansenClient.ts` | Nansen API — smart money транзакции, pagination, rate limiting |
| `dynamicWatchlist.ts` | Автоматическое управление watchlist кошельков (add/remove по performance) |
| `proposalPublisher.ts` | Redis pub/sub → Telegram bot, tracking статуса proposals |
| `rateLimiter.ts` | Token bucket rate limiter (per-wallet, per-API), Redis-backed |
| `sessionKeyRotator.ts` | ZeroDev session key lifecycle (generate, rotate, register) |
| `mevProtection.ts` | Flashbots bundle submission, private mempool, MEV-aware slippage |
| `remoteAttestation.ts` | TEE attestation quotes (SGX), verify peers, publish on-chain |
| `bloomFilter.ts` | Probabilistic dedup (O(1)), auto-rotation per epoch, Redis-persisted |
| `byrealClient.ts` | Alternative data: on-chain activity metrics, whale alerts |
| `txEnrichment.ts` | Token resolution, USD values, RWA matching, tx type labeling |

### 2.6 Конфигурация

**rwaRegistry.ts** — Статический реестр RWA на Mantle:

| Актив | Протокол | APY | Описание |
|-------|----------|-----|----------|
| USDY | Ondo Finance | ~5% | Tokenized T-bills |
| mETH | Mantle Staked Ether | ~3.5% | Liquid staking |
| cmETH | Mantle Liquid Restaking | ~6% | Restaking token |

### 2.7 Скрипты

**generateAgentCard.ts:**
- Генерирует ERC-8004 Agent Card JSON
- Загружает на IPFS (Pinata/web3.storage)
- Возвращает CID для on-chain регистрации

---

## Модуль 3: BFF Server

**Путь:** `bff/`  
**Фреймворк:** Hono ^4.4  
**Порт:** 3001  
**Тесты:** 16/16 passing

### 3.1 index.ts — API сервер

**Endpoints:**

| Метод | Путь | Описание | Auth |
|-------|------|----------|------|
| GET | `/api/proposal/:id` | Получить proposal + EIP-712 payload | HMAC |
| POST | `/api/proposal/:id/consume` | Сжечь nullifier (double-spend protection) | HMAC |
| POST | `/api/proposal/:id/simulate` | Dry-run eth_call симуляция | HMAC |
| GET | `/api/health` | Redis + RPC health check | Public |

**Middleware:**
- CORS (ограничен Telegram origins)
- Logger
- HMAC verification на всех `/api/proposal/*` маршрутах

**Ключевой принцип:** BFF НЕ хранит приватных ключей (кроме relayer для reputation batching).

### 3.2 proposalService.ts — Redis-backed proposal store

**Функции:**

| Функция | Описание |
|---------|----------|
| `verifyHmac(proposalId, signature)` | Timing-safe HMAC-SHA256 проверка |
| `computeHmac(data)` | Генерация HMAC подписи |
| `getAndLockProposal(proposalId)` | Fetch + deadline check + SETNX lock (60s TTL) + nullifier check |
| `consumeProposal(proposalId)` | Atomic pipeline: set nullifier → update status → remove lock → set 7d TTL |
| `redisHealthCheck()` | Ping |
| `shutdownRedis()` | Graceful close |

**Redis Key Schema:**
```
proposal:{id}              — JSON данные proposal
proposal_status:{id}       — FSM статус (pending/approved/consumed/expired)
proposal_lock:{id}         — Optimistic lock (SETNX, TTL 60s)
nullifier:{reasoningHash}  — Double-spend protection (permanent)
```

**StoredProposal model:**
```typescript
interface StoredProposal {
  asset: string;
  assetSymbol: string;
  action: string;
  recommendedAmount: string;
  nonce: number;
  deadline: number;
  reasoningHash: string;
  signature: string;
  signerAddress: string;
  generatedAt: number;
  maxSlippageBps: number;
  priceAtGeneration: string;
}
```

### 3.3 onChainOracle.ts — On-chain ценовой оракул

**Multi-RPC стратегия:** 3-endpoint fallback с auto-ranking по latency:
1. Primary RPC (rpc.mantle.xyz)
2. Blast RPC (mantle-mainnet.blastapi.io)
3. DRPC (mantle.drpc.org)

**Функции:**

| Функция | Описание |
|---------|----------|
| `checkPriceStaleness(...)` | Full price check: UniV3 slot0 / UniV2 getReserves + TWAP + Pyth cross-validation |
| `calculateTWAP(pairAddress)` | UniV3 observe() TWAP с настраиваемыми observation points |
| `getPythPrice(feedId, maxAge)` | Pyth Network oracle с fallback на getPriceUnsafe |
| `simulateTransaction(to, data)` | eth_call dry-run |
| `rpcHealthCheck()` | Block number + Pyth availability |

**Pyth Price Feeds:**
- ETH/USD
- USDC/USD
- USDT/USD
- MNT/USD
- WETH/USD

**Детекция манипуляций:** spot vs TWAP отклонение > 500bps (5%) → `isManipulated: true`

### 3.4 reputationBatcher.ts — Reputation batch daemon

Фоновый процесс (каждые 5 минут):

1. SCAN Redis по паттерну `agent_feedback_*`
2. Atomic GETDEL через Lua скрипт (предотвращение потери голосов)
3. Chunk по MAX_AGENTS_PER_BATCH=50 (gas limit safety)
4. Submit `postFeedbackBatch` / `postFeedbackBatchMulti` в ReputationRegistry
5. Retry: exponential backoff 1s→2s→4s, max 3 attempts

**Lazy-init:** не крашится без RELAYER_PRIVATE_KEY (просто не запускается).

### 3.5 Тесты (api.test.ts)

| Suite | Проверки |
|-------|----------|
| HMAC Verification | Valid passes, tampered fails, empty rejected, timing-safe |
| Staleness Detection | Within tolerance, beyond tolerance, zero price skip |
| Deadline Enforcement | Expired → 410, valid → allow |
| Status FSM | pending-only fetch, consumable states |
| Double-Spend Prevention | Consume changes state, second consume rejected |
| Input Sanitization | UUID format, HMAC hex format |
| Frontend Oracle Spoofing | Price comes from server, NOT client |

---

## Модуль 4: Telegram Mini App

**Путь:** `frontend/`  
**Фреймворк:** React 18 + Vite  
**Деплой:** Vercel (frontend-alphaflow-app.vercel.app)  
**Файлов:** 7 .ts/.tsx

### 4.1 main.tsx + App.tsx — Entry point

- Telegram WebApp инициализация (тема, viewport, кнопка "Назад")
- Authentication flow (Telegram initData verification)
- TonConnectUIProvider wrapping
- Error boundaries + loading states

### 4.2 InvestFlowApp.tsx — Основной UI

Полный инвестиционный интерфейс:

- **Portfolio dashboard** — балансы, PnL
- **Proposal cards** — approve/reject кнопки
- **Real-time updates** через WebSocket
- **Deposit/Withdraw flows** — подпись через WebAuthn
- **Agent reputation** — визуализация скора
- **Strategy selection** — conservative / balanced / aggressive

### 4.3 bffClient.ts — API клиент

```typescript
// REST API calls к BFF backend
GET  /proposals      — список активных proposals
GET  /portfolio      — текущий портфель
POST /approve/:id    — одобрить proposal
POST /reject/:id     — отклонить proposal
POST /deposit        — пополнить
POST /withdraw       — вывести

// WebSocket для real-time notifications
WS   /ws/proposals   — новые proposals в реальном времени
```

- Telegram initData в auth headers
- Retry с exponential backoff

### 4.4 useWebAuthn.ts — WebAuthn hook

React hook для работы с Passkeys:

- **Registration flow** — создание credential (navigator.credentials.create)
- **Authentication flow** — подпись challenge (navigator.credentials.get)
- **Связь с ZeroDev Kernel** — on-chain validation через Passkey Validator
- Транзакции без приватного ключа в браузере

### 4.5 vite.config.ts

- React plugin
- HTTPS dev server (для Telegram WebApp тестирования)
- Proxy к BFF backend

---

## Модуль 5: DevOps / Telegram Bot

**Путь:** `devops/`  
**Фреймворк:** Grammy (Telegram Bot API)  
**Файлов:** 3 .ts

### 5.1 index.ts — Bot logic

Telegram bot для HITL (Human-in-the-Loop) workflow:

- Подписка на Redis pub/sub (канал proposals)
- Форматирование и отправка proposals в admin чат
- Inline keyboard: [✅ Approve] [❌ Reject]
- Callback query handlers для кнопок
- Уведомление agent-tee о решении

**Admin команды:**
- `/status` — текущее состояние системы
- `/portfolio` — портфель
- `/pause` — приостановить агента
- `/resume` — возобновить

### 5.2 proposalStore.ts — Redis proposal storage

- CRUD для proposals
- TTL-based expiry (автоматическое истечение)
- Pub/sub listener для новых proposals
- Status tracking: pending → approved/rejected/expired

### 5.3 config.ts — Конфигурация

- BOT_TOKEN, REDIS_URL, ADMIN_CHAT_IDS, RPC_URL
- Валидация на старте
- Type-safe config export

---

## Инфраструктура и деплой

### docker-compose.yml

```yaml
services:
  redis:        # Redis 7 Alpine, AOF persistence, port 6379
  bff:          # Hono API, port 3001, depends on redis
  tg-bot:       # Telegraf/Grammy bot, depends on redis
  agent-tee-dev: # Dev profile only (TEE agent)
  anvil:        # Test profile only (Mantle fork for local testing)
```

### Текущий деплой (Production)

| Компонент | Где | Статус |
|-----------|-----|--------|
| Redis | GCP VM (нативно) | ✅ Running |
| BFF | GCP VM + Cloudflare Tunnel | ✅ Running |
| Telegram Bot | GCP VM (нативно) | ✅ Configured |
| Frontend (TMA) | Vercel | ✅ Deployed |
| Smart Contracts | Mantle Network | ✅ Deployed |
| Agent TEE | Phala DStack (будет) | ⏳ Pending |
| Docker | Не установлен на хосте | ❌ N/A |

### GCP Instance

- Name: instance-20260330-115005
- IP: 146.148.57.175
- Project: aeroport-491811
- OS: Debian (Linux 6.1.0-44-cloud-amd64)

---

## Безопасность

### Модель угроз и защита

| Угроза | Защита |
|--------|--------|
| Replay attack | Nonce в ArbParams + on-chain tracking |
| Reentrancy | Hybrid guard (TSTORE + SSTORE) |
| Price manipulation | TWAP + Pyth cross-validation + 5% deviation flag |
| Double-spend proposal | Nullifier-based protection (permanent Redis key) |
| Unauthorized execution | EIP-712 signature от TEE agent only |
| Frontend spoofing | Price ALWAYS from server oracle, not client |
| HMAC tampering | Timing-safe comparison (crypto.timingSafeEqual) |
| Session key compromise | Auto-rotation, scoped permissions (only executeFlashArbitrage) |
| Bot spam | Rate limiting per user/wallet/API |
| TEE code tampering | Remote attestation (SGX quotes) + on-chain ValidationRegistry |
| Token whitelist bypass | On-chain whitelist check in ActiveSentinel |
| Optimistic lock race | Redis SETNX with TTL (atomic) |

### Ключевые инварианты

1. **BFF не хранит приватных ключей** (кроме relayer для reputation)
2. **Только TEE agent может подписывать ArbParams** (EIP-712 ecrecover)
3. **Каждый proposal может быть использован ровно один раз** (nullifier)
4. **Цена ВСЕГДА проверяется server-side** (frontend не может подменить)
5. **Deadline enforcement** — просроченные proposals = 410 Gone

---

## Потоки данных (End-to-End)

### Flow 1: Обнаружение альфы → Исполнение

```
Nansen API
    │
    ▼
[agent-tee] Fetch smart money txs (polling every 30s)
    │
    ▼
[Bloom Filter] Dedup (O(1) check, Redis-persisted)
    │
    ▼
[txEnrichment] Resolve tokens, USD values, classify
    │
    ▼
[clusteringEngine] Group by similarity, temporal proximity
    │
    ▼
[llmEngine] GPT-4 analysis → conviction score + reasoning
    │
    ▼
[proposalPublisher] → Redis pub/sub → channel "proposals"
    │
    ├──────────────────────────────────┐
    ▼                                  ▼
[devops/tg-bot]                   [frontend/TMA]
    │ Inline keyboard                  │ Real-time WebSocket
    │ [Approve] [Reject]               │ [Approve] [Reject]
    │                                  │
    └──────────────┬───────────────────┘
                   │ Decision
                   ▼
[Redis] proposal_status → "approved"
    │
    ▼
[agent-tee/executor]
    │ Build EIP-712 ArbParams
    │ Sign with TEE private key
    ▼
[bff] simulateTransaction (dry-run)
    │
    ▼ (if simulation OK)
[ActiveSentinel.sol] executeFlashArbitrage
    │ Flash borrow (INIT Capital)
    │ Swap Route1 (Merchant Moe)
    │ Swap Route2 (Agni)
    │ Repay + profit
    ▼
[Result] Profit → ActiveSentinel contract balance
```

### Flow 2: HITL подтверждение через TMA

```
[TMA Frontend] User taps "Approve"
    │
    ▼
[useWebAuthn] navigator.credentials.get() → signed challenge
    │
    ▼
[bffClient] POST /api/proposal/:id/consume
    │ Headers: { X-HMAC-Signature, X-Telegram-InitData }
    ▼
[BFF] verifyHmac → getAndLockProposal → checkPriceStaleness
    │ SETNX lock (60s) + deadline check + nullifier check
    │ Pyth + TWAP price validation
    ▼
[BFF] consumeProposal → atomic Redis pipeline
    │ SET nullifier (permanent)
    │ UPDATE status → "consumed"
    │ DEL lock
    │ EXPIRE data (7 days)
    ▼
[Response] { eip712Payload, signature } → TMA
    │
    ▼
[ZeroDev Kernel] Submit UserOperation (gasless via Paymaster)
    │ Passkey Validator verifies WebAuthn signature
    ▼
[Mantle Network] Transaction executed
```

### Flow 3: Reputation feedback loop

```
[TMA] User votes 👍/👎 on executed proposal
    │
    ▼
[Redis] INCR/DECR agent_feedback_{agentId}
    │
    ▼ (every 5 minutes)
[reputationBatcher] SCAN + Lua atomic GETDEL
    │ Chunk by 50 agents max
    ▼
[ReputationRegistry.sol] postFeedbackBatchMulti(...)
    │
    ▼
[On-chain] Cumulative score updated (int128)
```

---

## Переменные окружения

### bff/.env

| Переменная | Описание |
|-----------|----------|
| PORT | Порт сервера (3001) |
| REDIS_URL | Redis connection string |
| HMAC_SECRET | Shared secret для HMAC подписей |
| MANTLE_RPC_PRIMARY | Основной RPC endpoint |
| MANTLE_RPC_BLAST | Fallback RPC (Blast) |
| MANTLE_RPC_DRPC | Fallback RPC (DRPC) |
| PYTH_CONTRACT_ADDRESS | Pyth oracle contract на Mantle |
| RELAYER_PRIVATE_KEY | (optional) Ключ для reputation batching |

### devops/.env

| Переменная | Описание |
|-----------|----------|
| BOT_TOKEN | Telegram Bot API token |
| TARGET_CHAT_ID | Admin chat ID для уведомлений |
| BOT_USERNAME | @alphaflow_agent_bot |
| TMA_URL | https://frontend-alphaflow-app.vercel.app |
| REDIS_URL | Redis connection string |
| HMAC_SECRET | Shared secret |

### agent-tee/.env (требуется создать)

| Переменная | Описание |
|-----------|----------|
| NANSEN_API_KEY | Ключ Nansen API |
| OPENAI_API_KEY | GPT-4 для LLM engine |
| ZERODEV_PROJECT_ID | ZeroDev dashboard ID |
| PRIVATE_KEY | TEE agent signing key |
| REDIS_URL | Redis connection string |
| MANTLE_RPC_URL | RPC endpoint |
| HMAC_SECRET | Shared secret |

### frontend/.env (требуется создать)

| Переменная | Описание |
|-----------|----------|
| VITE_BFF_URL | URL BFF сервера |
| VITE_WS_URL | WebSocket URL |
| VITE_TELEGRAM_BOT_USERNAME | Для deep linking |

---

## Статус и roadmap

### Текущий статус (Май 2025)

| Компонент | Статус | Покрытие |
|-----------|--------|----------|
| Smart Contracts | ✅ Complete | 57 tests, security audit-ready |
| BFF Server | ✅ Complete | 16 tests, HMAC + oracle + batcher |
| Frontend TMA | ✅ Complete | Deployed on Vercel |
| Telegram Bot (HITL) | ✅ Complete | Redis pub/sub proven |
| Agent TEE (core) | ⚠️ Partial | Pipeline works, tests broken |
| ZeroDev Integration | ⏳ Pending | Waiting for credentials |
| Phala DStack Deploy | ⏳ Pending | Code ready, needs attestation setup |
| Circuit Breaker | ⏳ Planned | Emergency stop mechanism |
| Formal Verification | ⏳ Planned | Certora/Halmos for contracts |

### Следующие шаги

1. **ZeroDev credentials** — dashboard.zerodev.app, Mantle chain
2. **Real Passkey transactions** — end-to-end WebAuthn → on-chain
3. **Fix agent-tee tests** — generateAggregatedProposal рефакторинг
4. **Circuit Breaker** — emergency pause для всей системы
5. **Formal verification** — математическое доказательство корректности контрактов
6. **Phala DStack production deploy** — remote attestation в mainnet

---

## Структура репозитория

```
alphaflow-suite/
├── ARCHITECTURE.md          # Техническая архитектура (English)
├── CONCEPT.md               # Концепция продукта (Russian)
├── PROJECT.md               # Описание проекта (Russian)
├── README.md                # Quick start (English)
├── FULL_PROJECT_DESCRIPTION.md  # ЭТО ФАЙЛ
├── docker-compose.yml       # Docker orchestration
├── .env.example             # Шаблон переменных окружения
│
├── contracts/               # Solidity smart contracts (Foundry)
│   ├── foundry.toml
│   ├── src/
│   │   ├── ActiveSentinel.sol
│   │   ├── SentinelIdentity.sol
│   │   ├── AlphaAuditor.sol
│   │   ├── ReputationRegistry.sol
│   │   ├── erc8004/
│   │   │   ├── IdentityRegistry.sol
│   │   │   └── ValidationRegistry.sol
│   │   ├── adapters/
│   │   │   ├── MerchantMoeAdapter.sol
│   │   │   └── AgniAdapter.sol
│   │   ├── libraries/
│   │   │   └── TransientReentrancyGuard.sol
│   │   └── interfaces/
│   │       ├── IDexRouter.sol
│   │       ├── IFlashBorrower.sol
│   │       └── IINITCore.sol
│   ├── script/
│   │   └── Deploy.s.sol
│   ├── test/
│   │   ├── ActiveSentinel.t.sol
│   │   ├── ActiveSentinelSecurity.t.sol
│   │   ├── DexAdapters.t.sol
│   │   └── SentinelModule1.t.sol
│   └── lib/ (OpenZeppelin, forge-std)
│
├── agent-tee/               # TEE Agent (TypeScript)
│   ├── package.json
│   ├── src/
│   │   ├── main.ts
│   │   ├── executor.ts
│   │   ├── types/index.ts
│   │   ├── strategies/
│   │   │   ├── clusteringEngine.ts
│   │   │   ├── yieldArchitect.ts
│   │   │   └── llmEngine.ts
│   │   ├── services/
│   │   │   ├── nansenClient.ts
│   │   │   ├── dynamicWatchlist.ts
│   │   │   ├── proposalPublisher.ts
│   │   │   ├── rateLimiter.ts
│   │   │   ├── sessionKeyRotator.ts
│   │   │   ├── mevProtection.ts
│   │   │   ├── remoteAttestation.ts
│   │   │   ├── bloomFilter.ts
│   │   │   ├── byrealClient.ts
│   │   │   └── txEnrichment.ts
│   │   ├── config/
│   │   │   └── rwaRegistry.ts
│   │   └── test/
│   │       └── yieldArchitect.test.ts
│   └── scripts/
│       └── generateAgentCard.ts
│
├── bff/                     # BFF Server (Hono)
│   ├── package.json
│   ├── tsconfig.json
│   ├── .env
│   └── src/
│       ├── index.ts
│       ├── services/
│       │   ├── proposalService.ts
│       │   ├── onChainOracle.ts
│       │   └── reputationBatcher.ts
│       └── test/
│           └── api.test.ts
│
├── frontend/                # Telegram Mini App (React)
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── vite-env.d.ts
│       ├── components/
│       │   └── InvestFlowApp.tsx
│       ├── hooks/
│       │   └── useWebAuthn.ts
│       └── utils/
│           └── bffClient.ts
│
├── devops/                  # Telegram Bot + Infra
│   ├── package.json
│   ├── .env
│   └── src/
│       └── tg-bot/
│           ├── index.ts
│           ├── proposalStore.ts
│           └── config.ts
│
├── docs/                    # Дополнительная документация
├── tests/                   # E2E тесты
└── .github/                 # CI/CD workflows
```

---

*Документ сгенерирован автоматически на основе анализа исходного кода.*  
*Последнее обновление: Май 2025*
