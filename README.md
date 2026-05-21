# AlphaFlow Suite

> **Agentic Commerce Infrastructure on Mantle Network**  
> 🏆 DoraHacks Mantle Hackathon Winner  
> Flash arbitrage with AI-driven TEE execution + Human-in-the-Loop UX

---

## Architecture Overview

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

## Modules

| Module | Path | Tech Stack |
|--------|------|-----------|
| Smart Contracts | `contracts/` | Solidity 0.8.24, Foundry, EIP-1153 TSTORE |
| TEE Agent (AI) | `agent-tee/` | TypeScript, ethers v6, Phala DStack, 2D Nonces |
| Backend API | `bff/` | Hono, ioredis, viem, HMAC-SHA256 |
| Telegram Mini App | `frontend/` | React 18, Vite 5, ZeroDev SDK v5.5, Passkeys |
| Transport/HITL | `devops/src/tg-bot/` | Telegraf v4, Redis Pub/Sub, Whitelist |

## Key Features

- **AI-Driven Strategy**: YieldArchitect agent analyzes Nansen signals in TEE
- **Zero-Trust Execution**: Private keys never leave Phala CVM (in-memory only)
- **Gasless UX**: ZeroDev Paymaster sponsors all user operations
- **Biometric Auth**: WebAuthn/Passkeys for transaction approval (FaceID/TouchID)
- **Human-in-the-Loop**: Every trade requires explicit Telegram approval
- **MEV Protection**: EIP-712 typed data with deadline + 2D nonce scheme
- **Staleness Guard**: On-chain price freshness validation before execution

## Quick Start

### Prerequisites

- Docker & Docker Compose v2
- Node.js >= 20 (for local dev)
- Foundry >= 1.7.0 (for contracts)

### Production Deployment

```bash
# Clone
git clone https://github.com/rocknrolla77/alphaflow-suite.git
cd alphaflow-suite

# Configure
cp .env.example .env
# Fill in: TELEGRAM_BOT_TOKEN, PROPOSAL_HMAC_SECRET, ACTIVE_SENTINEL_ADDRESS, etc.

# Launch core services (Redis + BFF + Telegram Bot)
docker compose up -d

# Verify
docker ps  # → alphaflow_redis, alphaflow_bff, alphaflow_tg_bot
curl http://localhost:3001/api/health  # → 200 OK
```

### Development (with TEE mock + Anvil fork)

```bash
docker compose --profile dev --profile test up -d
```

### Smart Contract Deployment (Mantle Mainnet)

```bash
cd contracts
forge script script/Deploy.s.sol \
  --rpc-url $MANTLE_RPC_PRIMARY \
  --broadcast --verify \
  --etherscan-api-key $MANTLESCAN_API_KEY
```

## Security Model

| Layer | Mechanism |
|-------|-----------|
| Reentrancy | EIP-1153 TSTORE/TLOAD (transient storage) |
| Replay | 2D Nonces (channel + sequence) |
| Staleness | slot0/getReserves freshness < 2% deviation |
| Auth | HMAC-SHA256 timing-safe + Passkey challenge |
| Transport | Telegram whitelist (TARGET_CHAT_ID only) |
| Key Mgmt | In-memory ephemeral keys inside Phala CVM |

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — Full technical reference (1000+ lines)
- [contracts/](./contracts/) — Foundry tests with fuzz coverage
- [.env.example](./.env.example) — All configuration keys documented

## Verified Contracts

| Contract | Address | Explorer |
|----------|---------|----------|
| ActiveSentinel | `TBD` | [Mantle Explorer](https://explorer.mantle.xyz/address/TBD) |

## License

MIT
