# AlphaFlow Suite — Детальное Описание Проекта

> **Версия документа:** 2026-05-24  
> **Статус:** Production-Ready MVP + ERC-8004 Identity  
> **Сеть:** Mantle Network (Chain ID: 5000)  
> **Победитель:** DoraHacks Mantle Hackathon  

---

## 1. Назначение и Миссия

AlphaFlow Suite — это инфраструктура автономной торговли (Agentic Commerce), которая предоставляет розничным инвесторам доступ к стратегиям институционального уровня через AI-агента, работающего в Trusted Execution Environment (TEE). Система реализует flash-арбитраж на Mantle Network с полным контролем пользователя через Human-in-the-Loop механику в Telegram.

**Ключевые принципы:**
- Non-custodial — приватный ключ агента генерируется in-memory внутри TEE, никогда не покидает анклав
- Proof-of-Reasoning — каждое решение AI подписывается EIP-712 с Remote Attestation
- MEV Protection — приватный мемпул + 2D nonces для replay protection
- Gasless UX — ZeroDev Paymaster спонсирует все UserOperations

---

## 2. Монорепозиторий — Структура

```
alphaflow-suite/
├── contracts/           Solidity smart contracts (Foundry)
│   └── src/erc8004/     ERC-8004 Identity & Validation Registry
├── agent-tee/           AI-агент в TEE (TypeScript, Phala DStack)
│   └── scripts/         Утилиты (generateAgentCard.ts)
├── bff/                 Backend-for-Frontend API (Hono, ioredis, viem)
├── frontend/            Telegram Mini App (React 18, Vite 5, ZeroDev SDK)
├── devops/              Telegram Bot + инфраструктура (Telegraf v4)
├── docs/                Документация
├── docker-compose.yml   Оркестрация всех сервисов
├── README.md            Обзор проекта
├── ARCHITECTURE.md      Техническая архитектура
├── PROJECT.md           Описание на русском
└── CONCEPT.md           Концепция продукта
```

---

## 3. Модуль: Smart Contracts (`contracts/`)

### 3.1 Технологический стек
- **Solidity** 0.8.24 (Cancun EVM)
- **Foundry** — сборка, тесты, деплой
- **OpenZeppelin Contracts** — SafeERC20, ERC721, AccessControl
- **EIP-1153** TSTORE/TLOAD — transient storage для reentrancy guard
- **Optimizer:** 1000 runs, via_ir: false

### 3.2 Контракты

#### ActiveSentinel.sol — Ядро Арбитража
**Путь:** `contracts/src/ActiveSentinel.sol`

Атомарный flash-арбитраж контракт, реализующий цикл:
1. Flash Borrow tokenA через INIT Capital (`IINITCore.flashBorrow`)
2. Swap tokenA → tokenB на Merchant Moe (DEX Router A)
3. Swap tokenB → tokenA на Agni Finance (DEX Router B)
4. Возврат займа + profit capture

**Ключевые характеристики:**
- `TransientReentrancyGuard` — EIP-1153 transient storage guard (дешевле обычного на ~5000 gas)
- `IFlashBorrower` callback pattern — `onFlashBorrow` с магическим return value
- Immutable архитектура: owner, initCore, dexRouterA, dexRouterB задаются при деплое
- CEI (Checks-Effects-Interactions) pattern
- Slippage protection: `amountOutMinRoute1`, `amountOutMinRoute2`
- Custom errors: `Unauthorized()`, `InvariantViolated(expected, actual)`, `SwapFailed(routeIndex)`, `ZeroAmount()`
- Event: `ArbitrageExecuted(tokenA, tokenB, borrowAmount, profit)`

**Структуры данных:**
```solidity
struct ArbParams {
    address tokenA;           // Базовый токен (borrow & profit)
    address tokenB;           // Промежуточный токен
    uint256 borrowAmount;     // Flash borrow amount
    uint256 minProfitTokenA;  // Min profit (рассчитан TEE off-chain)
    uint256 amountOutMinRoute1; // Slippage: A→B
    uint256 amountOutMinRoute2; // Slippage: B→A
}
```

**Поток выполнения:**
```
owner → executeArbitrage(params) → initCore.flashBorrow()
  └→ onFlashBorrow callback:
       1. CHECKS: msg.sender == initCore, amount > 0
       2. EFFECTS: update transient lock
       3. INTERACTIONS:
          - approve tokenA → dexRouterA
          - dexRouterA.swap(tokenA → tokenB)
          - approve tokenB → dexRouterB
          - dexRouterB.swap(tokenB → tokenA)
       4. VERIFY: profit >= minProfitTokenA
       5. REPAY: transfer borrowAmount + fee back to initCore
       6. EMIT: ArbitrageExecuted event
```

#### SentinelIdentity.sol — Реестр Идентичности Агентов
**Путь:** `contracts/src/SentinelIdentity.sol`

ERC-721 NFT-коллекция, где каждый токен = идентичность одного AI-агента:
- Soulbound (non-transferable) — агент привязан к конкретному владельцу
- Метаданные (tokenURI) содержат: адрес TEE, публичный ключ агента, Remote Attestation hash
- Используется как авторизация в AlphaAuditor и ReputationRegistry

#### AlphaAuditor.sol — Proof-of-Alpha Registry
**Путь:** `contracts/src/AlphaAuditor.sol`

Фиксация хэшей инсайтов (Proof-of-Alpha) от зарегистрированных агентов:
- **Газ-оптимизация:** хэш НЕ записывается в storage, только emit event
- Storage: только `agentCommitCount` (счётчик коммитов по agentId)
- Авторизация: только владелец NFT из SentinelIdentity может коммитить
- Event: `InsightCommitted(agentId, insightHash, timestamp)`
- Custom errors: `UnauthorizedAgent()`, `ZeroInsightHash()`

#### ReputationRegistry.sol — On-chain Репутация
**Путь:** `contracts/src/ReputationRegistry.sol`

On-chain реестр репутации агентов:
- Oracle-based: только авторизованный relayer (BFF) может записывать
- Batch update: массовое обновление скоров за один tx
- Данные: net score, total votes, last update timestamp
- Используется для ранжирования стратегий в UI

#### Вспомогательные контракты:
- `TransientReentrancyGuard.sol` — EIP-1153 guard библиотека
- `interfaces/IINITCore.sol` — интерфейс INIT Capital flash borrow
- `interfaces/IFlashBorrower.sol` — callback интерфейс
- `interfaces/IDexRouter.sol` — унифицированный интерфейс Merchant Moe + Agni Finance

#### ERC-8004 контракты (`contracts/src/erc8004/`):
- `IdentityRegistry.sol` — ERC-721 реестр идентичности AI-агентов (AgentCard URI → IPFS/Arweave)
- `ValidationRegistry.sol` — криптографическая верификация через TEE-оракулы (SGX/TDX attestation)

### 3.3 Тесты
- `test/ActiveSentinel.t.sol` — Foundry fuzz tests (1000 runs)
  - Mock контракты: MockDexRouter, MockINITCore, MockERC20, MaliciousDexRouter
  - Фазз: случайные borrowAmount, slippage, ценовые ratio
  - Reentrancy tests: MaliciousDexRouter пытается re-enter
- `test/SentinelModule1.t.sol` — тесты модуля идентичности
- Invariant tests: 256 runs, depth 50

### 3.4 Деплой
- `script/Deploy.s.sol` — Foundry script для деплоя ActiveSentinel
- Mantle Mainnet RPC: `https://rpc.mantle.xyz`
- Верификация: MantleScan API (`https://api.mantlescan.xyz/api`)

---

## 4. Модуль: TEE Agent (`agent-tee/`)

### 4.1 Технологический стек
- **TypeScript** (strict mode, Node16 modules)
- **ethers v6** — криптография, подписи, контракт-интеракции
- **viem** — дополнительный клиент для read-операций
- **ioredis** — Redis клиент (Pub/Sub + state)
- **@zerodev/sdk v5.5** — Kernel v3.1, Session Keys
- **@zerodev/session-key v5.5** — ротация сессионных ключей
- **permissionless v0.3** — ERC-4337 bundler client
- **zod v4** — runtime validation
- **Phala DStack** — TEE runtime (SGX/TDX)
- **vitest** — тестирование
- **tsx** — dev runtime

### 4.2 Архитектура

```
main.ts (entry point)
├── Генерация ключей in-memory (ethers.Wallet.createRandom())
├── Health endpoint (:8080)
├── Clustering tick (setInterval)
│   ├── DynamicWatchlist → SMEMBERS watched_wallets
│   ├── NansenClient → fetch signals per wallet
│   ├── TxEnrichment → обогащение контекстом
│   ├── ClusteringEngine → группировка кошельков
│   ├── LLM Engine → анализ и генерация стратегий
│   ├── YieldArchitect → risk-нормализация + EIP-712 подпись
│   └── ProposalPublisher → Redis PUBLISH
└── SessionKeyRotator (periodic)
```

### 4.3 Сервисы (детально)

#### main.ts — Точка входа
- Генерация приватного ключа `ethers.Wallet.createRandom()` — ключ живёт ТОЛЬКО в памяти TEE
- Health-check HTTP сервер на порту 8080
- Основной polling loop с конфигурируемым интервалом
- Graceful shutdown (SIGTERM/SIGINT)

#### services/dynamicWatchlist.ts — Динамический Watchlist
**Redis структуры:**
- `watched_wallets` — Redis SET с адресами для мониторинга
- `cluster:{parentAddress}` — Redis SET с child-адресами кластера
- `wallet_meta:{address}` — Redis HASH с метаданными кошелька

**Характеристики:**
- SEED_WALLETS из env — начальные адреса для мониторинга
- Capacity cap: 10,000 адресов максимум
- Rate limit: 50 запросов за epoch
- Auto-add: recipient при transfer >$50k
- Auto-cluster: gas funding при nonce ≤ 1

#### services/nansenClient.ts — Nansen MCP Клиент
- Интеграция с Nansen Model Context Protocol (MCP)
- Получение Smart Money signals: flows, token accumulation, entity labels
- Rate limiting + retry с exponential backoff
- Парсинг в `SmartMoneySignal` тип

#### services/txEnrichment.ts — Обогащение Транзакций
- Контекстуализация raw signals: добавление price data, protocol context
- Маппинг адресов на known entities (CEX, protocols, VCs)
- RWA asset detection через rwaRegistry

#### services/mevProtection.ts — MEV Protection
- Интеграция с приватными мемпулами (Flashbots Protect / Merkle)
- 2D Nonces — (channel, sequence) для replay protection
- Transaction bundling для атомарности

#### services/sessionKeyRotator.ts — Ротация Session Keys
- Автоматическая ротация ZeroDev session keys
- Интервал: конфигурируемый (default 24h)
- Старые ключи инвалидируются через ZeroDev SDK
- Безшовный переход: новый ключ активируется до удаления старого

#### services/remoteAttestation.ts — Remote Attestation
- Phala DStack Remote Attestation (SGX/TDX quotes)
- Генерация attestation report для верификации TEE среды
- Включается в EIP-712 подпись как proof-of-environment
- Верификация: клиент может проверить, что решение принято в TEE

#### services/proposalPublisher.ts — Публикация Proposal
- Redis PUBLISH на канал `proposals`
- Формат: SignedProposal (EIP-712 подпись + attestation + strategy data)
- TTL: proposal имеет ограниченное время жизни
- Idempotency: dedup по proposalId

#### services/rateLimiter.ts — Rate Limiter
- Token bucket + sliding window
- Конфигурация: 50 requests per epoch
- Per-wallet и global rate limits
- Graceful degradation: при лимите — skip, не crash

### 4.4 Стратегии

#### strategies/clusteringEngine.ts — Кластеризация Кошельков
**Правила кластеризации:**
1. **Rule 1 — Transfer Link:** Transfer >$50k → auto-add recipient в watchlist
2. **Rule 2 — Gas Funding:** Если получатель имеет nonce ≤ 1 и получает gas → sub-cluster
3. **Rule 3 — Temporal Proximity:** Транзакции в одном блоке от разных адресов → potential cluster

**Выход:** обновление Redis SET `cluster:{parent}`, enriched metadata

#### strategies/llmEngine.ts — LLM Анализ
- Обработка обогащённых сигналов через LLM
- Генерация structured output: стратегия, confidence, risk score
- Prompt engineering для DeFi контекста
- Fallback: при ошибке LLM — conservative default strategy

#### strategies/yieldArchitect.ts — Yield Architect
**Ядро стратегического движка:**
- Conviction weighting: взвешивание сигналов по надёжности источника
- Risk-нормализация: адаптация объёма позиции под портфель пользователя
- EIP-712 подпись каждого proposal:
  ```
  EIP712Domain {
    name: "AlphaFlow",
    version: "1",
    chainId: 5000,
    verifyingContract: <ActiveSentinel address>
  }
  ```
- Включает: strategy type, params, confidence, risk score, attestation hash

### 4.5 Типы (`types/index.ts`)

```typescript
interface SmartMoneySignal {
  wallet: Address;
  action: "accumulate" | "distribute" | "swap" | "provide_liquidity";
  token: Address;
  amount: bigint;
  timestamp: number;
  confidence: number; // 0-100
  source: "nansen" | "on_chain" | "cluster_inference";
}

interface UserRiskProfile {
  maxPositionSizePct: number;  // % от портфеля
  maxSlippageBps: number;      // basis points
  preferredStrategies: StrategyType[];
  blacklistedTokens: Address[];
}

interface Proposal {
  id: string;
  strategy: StrategyType;
  params: ArbParams;
  confidence: number;
  riskScore: number;
  expectedProfitBps: number;
  ttlSeconds: number;
}

interface SignedProposal extends Proposal {
  signature: Hex;           // EIP-712 signature
  attestationHash: Hex;     // Remote Attestation quote hash
  agentAddress: Address;    // TEE agent ephemeral address
  timestamp: number;
}
```

### 4.6 Конфигурация RWA Registry (`config/rwaRegistry.ts`)
Верифицированные адреса Real World Assets на Mantle:
- **mETH** (Mantle Staked ETH) — LSD, yield_bearing, ~4% APY
- **cmETH** (Compound mETH) — LRT, restaking, ~7% APY
- **USDY** (Ondo US Dollar Yield) — tokenized_yield, stable, ~5% APY
- **wstETH** (Wrapped stETH) — wrapped, yield_bearing

Каждый актив содержит: address, symbol, name, protocolName, assetType, riskClassification, decimals, underlying, estimatedApyBps, docsUrl, isRebase, relatedContracts.

---

## 5. Модуль: BFF API Server (`bff/`)

### 5.1 Технологический стек
- **Hono** — lightweight HTTP framework
- **ioredis** — Redis client
- **viem** — Ethereum interactions
- **zod** — request/response validation
- **node:crypto** — HMAC-SHA256, timingSafeEqual

### 5.2 API Endpoints

| Method | Path | Описание |
|--------|------|----------|
| GET | `/api/health` | Health check |
| GET | `/api/proposals` | Список активных proposals |
| GET | `/api/proposals/:id` | Детали proposal |
| POST | `/api/proposals/:id/approve` | Одобрение (HMAC verified) |
| POST | `/api/proposals/:id/reject` | Отклонение |
| GET | `/api/price/:pair` | On-chain цена (oracle) |
| GET | `/api/reputation/:agentId` | Репутация агента |

### 5.3 Сервисы

#### proposalService.ts — Proposal Store
- Redis-backed CRUD с HMAC verification
- Optimistic locking: версионирование через Redis WATCH/MULTI
- Nullifier: одноразовое использование approval (prevent double-spend)
- TTL: proposals автоматически expire
- HMAC: `createHmac("sha256", HMAC_SECRET).update(proposalId).digest("hex")`
- Timing-safe verification: `timingSafeEqual` против timing oracle attacks

#### onChainOracle.ts — On-Chain Price Oracle
- **viem PublicClient** с multi-RPC fallback:
  - Primary: `MANTLE_RPC_PRIMARY` (timeout 10s, 2 retries)
  - Fallback 1: BlastAPI (timeout 15s, 2 retries)
  - Fallback 2: dRPC (timeout 15s, 1 retry)
- Rank: true — автоматическое переранжирование по latency
- Цена ВСЕГДА берётся on-chain (не из request body клиента)
- Frontend Oracle Spoofing невозможен: BFF — единственный источник правды
- Staleness detection: `MAX_STALENESS_PCT` (default 2%)

#### reputationBatcher.ts — Reputation Batch Updates
- Polling interval: 5 минут
- Lua-скрипт для атомарного read+reset метрик из Redis
- Redis ключи:
  - `agent_feedback_score:{agentId}` — net score (+1/-1)
  - `agent_feedback_count:{agentId}` — total votes за период
- Batch tx submission в ReputationRegistry контракт
- Retry: exponential backoff (1s, 2s, 4s), max 3 attempts
- NONCE_TOO_LOW handling: немедленный перезапрос nonce + retry
- Relayer private key живёт только в BFF .env

### 5.4 Middleware
- **HMAC Verification:** header `x-hmac-signature` для proposal actions
- **CORS:** настроен для TMA_ORIGIN
- **Rate Limiting:** per-IP
- **Request Validation:** zod schemas

---

## 6. Модуль: Telegram Mini App (`frontend/`)

### 6.1 Технологический стек
- **React 18** — UI framework
- **Vite 5** — bundler
- **ZeroDev SDK v5.5** — Account Abstraction
- **WebAuthn/Passkeys** — биометрическая аутентификация
- **TypeScript** (strict)

### 6.2 Ключевые компоненты

#### hooks/useWebAuthn.ts — WebAuthn Integration
- Регистрация Passkey (FaceID/TouchID)
- Аутентификация через biometrics
- Интеграция с ZeroDev для подписи UserOperations
- Fallback: если устройство не поддерживает WebAuthn — показ QR

#### utils/bffClient.ts — BFF API Client
- Типизированный HTTP клиент для BFF API
- Automatic retry + error handling
- HMAC подпись запросов (получена через Telegram deep link)

### 6.3 UX Flow
1. Пользователь открывает Mini App через Telegram бота
2. Регистрация/вход через Passkey (biometrics)
3. ZeroDev создаёт Smart Account (Kernel v3.1)
4. Просмотр предложений AI-агента (proposals)
5. Одобрение/отклонение с биометрической подписью
6. Gasless execution через ZeroDev Paymaster

---

## 7. Модуль: HITL Telegram Bot (`devops/src/tg-bot/`)

### 7.1 Технологический стек
- **Telegraf v4** — Telegram Bot framework
- **ioredis** — Redis Pub/Sub + state
- **TypeScript**

### 7.2 Файлы

#### index.ts — Bot Entry Point
- Subscribe на Redis канал `proposals`
- Форматирование proposal в human-readable сообщение
- Inline keyboard: [✅ Approve] [❌ Reject] [📊 Details]
- Whitelist: только авторизованные chat IDs
- Callback handling: approve/reject → POST к BFF

#### config.ts — Bot Configuration
- `TELEGRAM_BOT_TOKEN` — токен бота
- `TARGET_CHAT_ID` — целевой чат для уведомлений
- `MINI_APP_URL` — URL для deep linking в Mini App
- `MAX_SLIPPAGE_PCT` — порог отображения warning

#### proposalStore.ts — Локальный кэш proposals
- In-memory cache последних N proposals для быстрого доступа
- TTL-based eviction
- Sync с Redis при старте

### 7.3 Поток HITL
```
TEE Agent → Redis PUBLISH "proposals" → TG Bot subscribes
  → Bot formats message + inline keyboard
  → User clicks [Approve]
  → Bot → POST /api/proposals/:id/approve (HMAC signed)
  → BFF → Redis state update → TEE Agent executes
  → TEE Agent → on-chain tx → result back via Redis
  → Bot notifies user: "✅ Executed! Profit: +0.3%"
```

---

## 8. Инфраструктура (Docker Compose)

### 8.1 Сервисы

| Сервис | Контейнер | Порт | Зависимости |
|--------|-----------|------|-------------|
| redis | alphaflow_redis | 6379 | — |
| agent-tee | alphaflow_agent | 8080 | redis |
| bff | alphaflow_bff | 3001 | redis |
| tg-bot | alphaflow_tg_bot | — | redis |

### 8.2 Redis Configuration
- **Версия:** Redis 7 (Alpine)
- **Persistence:** AOF (appendonly yes)
- **Password:** `REDIS_PASSWORD` env var
- **Health check:** `redis-cli ping` (interval 10s)
- **Memory limit:** конфигурируемый через env

### 8.3 Health Checks
- Redis: `redis-cli ping` (10s interval)
- BFF: `curl -f http://localhost:3001/api/health` (15s interval)
- Agent: HTTP GET `:8080/health`
- Restart policy: `unless-stopped`

---

## 9. Безопасность

### 9.1 Smart Contract Security
- **TransientReentrancyGuard** — EIP-1153 TSTORE/TLOAD (дешевле slot-based на ~5000 gas)
- **CEI Pattern** — Checks-Effects-Interactions строго соблюдается
- **Immutable** конструктор — нет admin функций, нет upgradeable proxy
- **Slippage protection** — amountOutMin на каждом swap
- **Owner-only execution** — только deployer может вызывать executeArbitrage
- **Foundry fuzz testing** — 1000 runs, invariant tests 256 runs depth 50

### 9.2 TEE Security
- **In-memory key generation** — `Wallet.createRandom()`, ключ не персистится
- **Remote Attestation** — SGX/TDX quote включается в каждый proposal
- **Ephemeral identity** — новый ключ при каждом рестарте контейнера
- **No network exfiltration** — Phala DStack ограничивает сетевой доступ

### 9.3 API Security
- **HMAC-SHA256** — timing-safe verification всех мутирующих запросов
- **Nullifier pattern** — proposal можно approve только один раз
- **On-chain price oracle** — BFF единственный источник цен (не клиент)
- **RPC Fallback** — 3 провайдера с automatic failover
- **Zod validation** — строгая типизация всех inputs

### 9.4 Transport Security
- **Whitelist** — Telegram bot принимает команды только от авторизованных пользователей
- **HMAC deep link** — одноразовая подпись для Mini App авторизации
- **Redis password** — все connections authenticated
- **CORS** — ограничен TMA_ORIGIN

### 9.5 Account Abstraction Security
- **Session Keys** — ограниченные по времени и scope
- **Automatic rotation** — ротация каждые 24h
- **Passkeys** — биометрическая 2FA для каждой операции
- **Paymaster** — пользователь не платит gas (нет нужды хранить ETH)

---

## 10. Phase 4: Dynamic Watchlist & Clustering

### 10.1 DynamicWatchlist
- Redis SET `watched_wallets` — основной список мониторинга
- Redis SET `cluster:{parent}` — группировка связанных адресов
- Redis HASH `wallet_meta:{addr}` — метаданные (label, first_seen, cluster_id, risk_score)
- SEED_WALLETS env — начальные адреса (Smart Money из Nansen)
- Capacity cap: 10,000 адресов
- Rate limit: 50 запросов за epoch

### 10.2 ClusteringEngine
- **Rule 1:** Transfer >$50k → auto-add recipient в watchlist
- **Rule 2:** Gas funding при nonce ≤ 1 → sub-cluster (вероятно новый кошелёк того же entity)
- **Rule 3:** Temporal proximity — транзакции в одном блоке

### 10.3 Main Loop
```
clustering tick → DynamicWatchlist.getMembers()
  → NansenClient.fetchSignals(wallets)
  → TxEnrichment.enrich(signals)
  → ClusteringEngine.process(enrichedSignals)
  → LLMEngine.analyze(clusters)
  → YieldArchitect.buildProposal(analysis)
  → ProposalPublisher.publish(signedProposal)
```

---

## 11. Phase 5: RWA Asset Registry

Верифицированный реестр Real World Assets на Mantle для downstream enrichment:

| Asset | Protocol | Type | Risk | APY (bps) |
|-------|----------|------|------|-----------|
| mETH | Mantle LSP | LSD | yield_bearing | ~400 |
| cmETH | Mantle LRT | LRT | restaking | ~700 |
| USDY | Ondo Finance | tokenized_yield | stable | ~500 |
| wstETH | Lido | wrapped | yield_bearing | ~350 |

Все адреса checksummed (EIP-55), верифицированы через Mantle Explorer.

---

## 11.5. Phase 6: ERC-8004 Agent Identity & Validation Registry

### 11.5.1 Обзор Стандарта

ERC-8004 — протокол on-chain идентичности для AI-агентов. Каждый агент получает ERC-721 NFT, привязанный к AgentCard (JSON) в децентрализованном хранилище (IPFS/Arweave). Стандарт обеспечивает:
- **Программное обнаружение** (Agent-to-Agent discovery) через capabilities/endpoints
- **Криптографическую верификацию** через независимые TEE-оракулы (Validation Hooks)
- **Оплату за сервисы** через протокол x402 (paymentAddresses)

### 11.5.2 IdentityRegistry.sol

**Путь:** `contracts/src/erc8004/IdentityRegistry.sol`

Реестр идентичности AI-агентов на базе ERC-721:
- Наследует `ERC721` + `ERC721URIStorage` (OpenZeppelin)
- Один адрес = один агент (soulbound-подобная механика)
- tokenURI указывает на decentralized URI (ipfs://, ar://)
- Централизованные URL (https://) нарушают Data Availability инвариант

**Функции:**
| Функция | Доступ | Описание |
|---------|--------|----------|
| `registerAgent(address owner, string agentCardURI)` | external | Минтинг NFT агента. Один owner = один tokenId. |
| `updateAgentCard(uint256 tokenId, string newURI)` | owner only | Обновление URI (ротация endpoints, capabilities) |
| `isRegistered(address account)` | view | Проверка существования агента |
| `totalAgents()` | view | Общее количество зарегистрированных агентов |

**Custom Errors:** `AgentAlreadyRegistered()`, `NotTokenOwner()`, `EmptyURI()`, `ZeroAddress()`

**Event:** `AgentRegistered(uint256 indexed tokenId, address indexed owner, string agentCardURI)`

### 11.5.3 ValidationRegistry.sol

**Путь:** `contracts/src/erc8004/ValidationRegistry.sol`

Реестр криптографической валидации агентов через TEE-оракулы:
- Любой адрес может запросить валидацию (`requestValidation`)
- Зарегистрированные TEE-оракулы проводят аудит и записывают результат (`submitValidation`)
- On-chain audit trail через events + mappings
- Attestation quote (SGX/TDX) хранится как keccak256 hash (газ-оптимизация)

**Архитектура валидации:**
```
1. Инициатор → requestValidation(agentId, requestURI, requestHash)
2. Event ValidationRequest эмитируется
3. Off-chain TEE-оракулы слушают event, проводят аудит
4. TEE-оракул → submitValidation(agentId, requestHash, isValid, attestationQuote)
5. Результат записывается on-chain (validator → result mapping)
```

**Функции:**
| Функция | Доступ | Описание |
|---------|--------|----------|
| `requestValidation(agentId, requestURI, requestHash)` | external | Запрос аудита агента |
| `submitValidation(agentId, requestHash, isValid, attestationQuote)` | onlyValidator | Запись результата TEE-оракула |
| `addValidator(address)` | onlyOwner | Регистрация TEE-оракула |
| `removeValidator(address)` | onlyOwner | Удаление валидатора |
| `getApprovalRate(requestHash)` | view | Процент положительных валидаций |
| `getAgentRequests(agentId)` | view | Все запросы для агента |

**Events:**
- `ValidationRequest(address indexed requester, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash)`
- `ValidationSubmitted(address indexed validator, uint256 indexed agentId, bytes32 indexed requestHash, bool isValid, bytes32 attestationHash)`

**Trust Model:**
- Валидаторы регистрируются owner (deployer)
- Один валидатор = один ответ на request (no double-submit)
- attestationQuote верифицируется off-chain через Intel/AMD attestation service

### 11.5.4 AgentCard JSON Generator

**Путь:** `agent-tee/scripts/generateAgentCard.ts`

TypeScript скрипт для генерации AgentCard JSON по стандарту ERC-8004:

**Обязательные поля (ERC-8004 compliance):**
```json
{
  "schemaVersion": "1.0.0",
  "name": "AlphaFlow Sentinel",
  "description": "Autonomous flash-arbitrage agent on Mantle Network...",
  "capabilities": ["MCP", "flash-arbitrage", "cross-dex-monitoring", "tee-execution", ...],
  "endpoints": {
    "mcp": "https://alphaflow-sentinel.phala.network/mcp",
    "health": "https://alphaflow-sentinel.phala.network/health",
    "ws": "wss://alphaflow-sentinel.phala.network/ws",
    "rest": "https://alphaflow-sentinel.phala.network/api/v1"
  },
  "paymentAddresses": {
    "mantle": "0x...",
    "ethereum": "0x..."
  },
  "tee": {
    "type": "TDX",
    "attestationEndpoint": "https://alphaflow-sentinel.phala.network/attestation"
  }
}
```

**Валидация:**
- `capabilities` ОБЯЗАН содержать "MCP" (Model Context Protocol)
- `endpoints.mcp` обязателен
- `paymentAddresses` — минимум одна запись, формат 0x + 40 hex chars
- Пустые name/description → ошибка валидации

**Использование:**
```bash
# Генерация JSON
npx tsx agent-tee/scripts/generateAgentCard.ts --output ./agent-card.json

# Генерация + загрузка на IPFS (Pinata)
PINATA_JWT=<jwt> npx tsx agent-tee/scripts/generateAgentCard.ts --upload
```

**Выход `--upload`:** CID файла на IPFS → используется как agentCardURI в IdentityRegistry.registerAgent()

### 11.5.5 Риски и Митигации

| Риск | Описание | Митигация |
|------|----------|-----------|
| Data Availability | AgentCard на централизованном сервере → single point of failure | agentCardURI ДОЛЖЕН быть ipfs:// или ar://. Filecoin Pin для persistence. |
| Несовместимость метаданных | Отсутствие capabilities/endpoints → Agent-to-Agent невозможен | Строгая JSON-валидация в generateAgentCard.ts, custom errors. |
| Sybil Attack | Множественная регистрация агентов | Один адрес = один агент (agentOf mapping). |
| Stale AgentCard | Endpoints устарели после ротации | updateAgentCard() + event для off-chain indexers. |
| Malicious Validator | Ложные результаты валидации | Multiple validators + approval rate threshold. |

---

## 12. Переменные Окружения

### Agent TEE
| Переменная | Описание | Default |
|-----------|----------|---------|
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `SEED_WALLETS` | Comma-separated initial wallets | — |
| `POLLING_INTERVAL_MS` | Clustering tick interval | `60000` |
| `NANSEN_API_KEY` | Nansen MCP API key | — |
| `ZERODEV_PROJECT_ID` | ZeroDev project for session keys | — |
| `MAX_WATCHLIST_SIZE` | Watchlist capacity cap | `10000` |
| `RATE_LIMIT_PER_EPOCH` | Max requests per epoch | `50` |

### BFF
| Переменная | Описание | Default |
|-----------|----------|---------|
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `PROPOSAL_HMAC_SECRET` | HMAC signing key | — |
| `MANTLE_RPC_PRIMARY` | Primary RPC endpoint | `https://rpc.mantle.xyz` |
| `MANTLE_RPC_FALLBACK_1` | Fallback RPC 1 | BlastAPI |
| `MANTLE_RPC_FALLBACK_2` | Fallback RPC 2 | dRPC |
| `ACTIVE_SENTINEL_ADDRESS` | Deployed contract address | — |
| `MAX_STALENESS_PCT` | Price staleness threshold | `2` |
| `TMA_ORIGIN` | CORS origin for Mini App | `http://localhost:5173` |
| `PORT` | HTTP port | `3001` |
| `RELAYER_PRIVATE_KEY` | Reputation batch relayer key | — |
| `REPUTATION_REGISTRY_ADDRESS` | Registry contract address | — |

### Telegram Bot
| Переменная | Описание | Default |
|-----------|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot API token | — |
| `REDIS_URL` | Redis connection string | — |
| `TARGET_CHAT_ID` | Authorized chat for notifications | — |
| `MINI_APP_URL` | TMA deep link URL | — |
| `PROPOSAL_HMAC_SECRET` | Shared HMAC secret with BFF | — |
| `MAX_SLIPPAGE_PCT` | Slippage warning threshold | `2` |
| `PROPOSAL_TTL_SEC` | Proposal expiration time | — |

### Docker Compose (root)
| Переменная | Описание |
|-----------|----------|
| `REDIS_PASSWORD` | Redis auth password |
| `PHALA_API_KEY` | Phala DStack API key |

---

## 13. Протоколы на Mantle Network

### INIT Capital
- Flash Borrow: Zero-fee flash loans для атомарного арбитража
- Интерфейс: `IINITCore.flashBorrow(token, amount, borrower, data)`
- Callback: `IFlashBorrower.onFlashBorrow(initiator, token, amount, fee, data)`

### Merchant Moe (DEX Router A)
- Fork UniswapV2 на Mantle
- Liquidity pools: MNT/USDC, WETH/USDC, mETH/WETH
- Router: `swapExactTokensForTokens`

### Agni Finance (DEX Router B)
- UniswapV3-style concentrated liquidity на Mantle
- Pools: tick-based с различными fee tiers (0.01%, 0.05%, 0.3%, 1%)
- Router: `exactInputSingle`

### ZeroDev
- **Kernel v3.1** — modular smart account
- **Session Keys** — scoped permissions with expiry
- **Passkeys** — WebAuthn-based signing
- **Paymaster** — gas sponsorship (пользователь не платит)
- **Bundler** — UserOperation submission

---

## 14. Тестирование

### Smart Contracts (Foundry)
```bash
cd contracts && forge test -vvv
```
- Fuzz: 1000 runs per test
- Invariant: 256 runs, depth 50
- Fork testing: Mantle mainnet fork

### Agent TEE (Vitest)
```bash
cd agent-tee && npm test
```
- Unit tests: yieldArchitect, clusteringEngine
- Integration: Redis mock, Nansen mock
- Coverage: `vitest --coverage`

### BFF (Vitest)
```bash
cd bff && npm test
```
- API tests: endpoint validation
- Service tests: proposalService, onChainOracle
- HMAC verification tests

---

## 15. Roadmap

### ✅ Completed
- Module 1: Smart Contracts (ActiveSentinel, SentinelIdentity, AlphaAuditor)
- Module 2: TEE Agent (YieldArchitect, EIP-712, Phala DStack)
- Module 3: BFF API (Hono, HMAC, On-chain Oracle, Reputation Batcher)
- Module 4: Telegram Mini App (React, ZeroDev, WebAuthn)
- Module 5: HITL Telegram Bot (Telegraf, Redis Pub/Sub)
- Module 6: Docker Compose orchestration
- Phase 4: Dynamic Watchlist + Clustering Engine
- Phase 5: RWA Asset Registry

### ✅ Phase 6: ERC-8004 Agent Identity & Validation
- IdentityRegistry.sol — on-chain реестр идентичности агентов (ERC-721 + URIStorage)
- ValidationRegistry.sol — криптографическая верификация через TEE-оракулы
- generateAgentCard.ts — генератор ERC-8004 AgentCard JSON (IPFS upload)

### 🔜 Next
- Circuit Breaker pattern (automatic halt при аномалиях)
- Formal Verification (Certora / Halmos)
- Multi-path Arbitrage (3+ hop routes)
- Cross-DEX aggregation (более 2 DEX одновременно)
- Portfolio rebalancing strategies
- Governance token integration

---

## 16. Лицензия и Контакты

- **Лицензия:** MIT
- **GitHub:** github.com/rocknrolla77/alphaflow-suite (private)
- **Сеть:** Mantle Network (Chain ID: 5000)
- **Hackathon:** DoraHacks Mantle Hackathon (Winner)
