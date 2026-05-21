# AlphaFlow Suite

Flash arbitrage execution engine for Mantle Network (Merchant Moe / Agni Finance).

## Structure

```
alphaflow-suite/
├── contracts/        # Foundry project — on-chain execution (ActiveSentinel)
├── agent-tee/        # TEE agent — off-chain strategy, Nansen MCP (Phase 2)
├── frontend/         # Dashboard (Phase 3)
└── docs/             # Architecture, specs, audit notes
```

## Phase 1 (MVP) — Active Sentinel

Core execution contract with:
- Transient reentrancy guard (EIP-1153, TSTORE/TLOAD)
- Strict CEI pattern
- Math invariant: `P_sell * (1 - slippage) - P_buy * (1 + slippage) - costs > 0`
- Flash borrow via INIT Capital
- Two-leg swap: Merchant Moe → Agni Finance

## Quick Start

```bash
cd contracts
forge build
forge test -vvv
```

## Requirements

- Foundry (forge, anvil) >= 1.7.0
- Solidity 0.8.24+
- EVM target: cancun (for transient storage)
