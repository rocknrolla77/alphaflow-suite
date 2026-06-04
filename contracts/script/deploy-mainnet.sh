#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# AlphaFlow Suite - Mantle Mainnet Deployment & Verification
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

export PATH="$HOME/.foundry/bin:$PATH"

# Load environment
source .env.deploy

echo "============================================="
echo " AlphaFlow Suite - Mantle Mainnet Deploy"
echo "============================================="
echo ""

# ─── Deploy ───────────────────────────────────────────────────────────────────
echo "[STEP 1] Deploying contracts..."
forge script script/DeployMainnet.s.sol:DeployMainnet \
    --rpc-url https://rpc.mantle.xyz \
    --chain-id 5000 \
    --broadcast \
    --slow \
    -vvv

echo ""
echo "[STEP 2] Extracting deployed addresses from broadcast..."

# Parse latest broadcast
BROADCAST_FILE=$(ls -t broadcast/DeployMainnet.s.sol/5000/run-latest.json 2>/dev/null | head -1)
if [ -z "$BROADCAST_FILE" ]; then
    echo "ERROR: No broadcast file found. Deploy may have failed."
    exit 1
fi

# Extract addresses (contracts deployed in order: SentinelIdentity, AlphaAuditor, ActiveSentinel)
IDENTITY_ADDR=$(cat "$BROADCAST_FILE" | python3 -c "
import json, sys
data = json.load(sys.stdin)
txs = [t for t in data['transactions'] if t['transactionType'] == 'CREATE']
print(txs[0]['contractAddress'])
")

AUDITOR_ADDR=$(cat "$BROADCAST_FILE" | python3 -c "
import json, sys
data = json.load(sys.stdin)
txs = [t for t in data['transactions'] if t['transactionType'] == 'CREATE']
print(txs[1]['contractAddress'])
")

SENTINEL_ADDR=$(cat "$BROADCAST_FILE" | python3 -c "
import json, sys
data = json.load(sys.stdin)
txs = [t for t in data['transactions'] if t['transactionType'] == 'CREATE']
print(txs[2]['contractAddress'])
")

echo "SentinelIdentity: $IDENTITY_ADDR"
echo "AlphaAuditor:     $AUDITOR_ADDR"
echo "ActiveSentinel:   $SENTINEL_ADDR"
echo ""

# ─── Verify ──────────────────────────────────────────────────────────────────
echo "[STEP 3] Verifying contracts on Mantle Explorer..."

echo "Verifying SentinelIdentity..."
forge verify-contract "$IDENTITY_ADDR" src/SentinelIdentity.sol:SentinelIdentity \
    --chain-id 5000 \
    --verifier blockscout \
    --verifier-url https://explorer.mantle.xyz/api \
    || echo "WARNING: SentinelIdentity verification failed (retry manually)"

echo ""
echo "Verifying AlphaAuditor..."
AUDITOR_ARGS=$(cast abi-encode "constructor(address)" "$IDENTITY_ADDR")
forge verify-contract "$AUDITOR_ADDR" src/AlphaAuditor.sol:AlphaAuditor \
    --chain-id 5000 \
    --verifier blockscout \
    --verifier-url https://explorer.mantle.xyz/api \
    --constructor-args "$AUDITOR_ARGS" \
    || echo "WARNING: AlphaAuditor verification failed (retry manually)"

echo ""
echo "Verifying ActiveSentinel..."
TEE_AGENT=${TEE_AGENT_ADDRESS:-$(cast wallet address --private-key $DEPLOYER_PRIVATE_KEY)}
SENTINEL_ARGS=$(cast abi-encode "constructor(address,address,address,address)" \
    "0x972bCB0284cCA0e24C81F6BF8EE48bd7E2E90f91" \
    "0xeaEE7EE68874218c3558b40063c42B82D3E7232a" \
    "0x319B69888b0d11cEC22caA5034e25FfFBDc88421" \
    "$TEE_AGENT")
forge verify-contract "$SENTINEL_ADDR" src/ActiveSentinel.sol:ActiveSentinel \
    --chain-id 5000 \
    --verifier blockscout \
    --verifier-url https://explorer.mantle.xyz/api \
    --constructor-args "$SENTINEL_ARGS" \
    || echo "WARNING: ActiveSentinel verification failed (retry manually)"

echo ""
echo "============================================="
echo " DEPLOYMENT SUMMARY"
echo "============================================="
echo "Network:          Mantle Mainnet (5000)"
echo "SentinelIdentity: $IDENTITY_ADDR"
echo "AlphaAuditor:     $AUDITOR_ADDR"
echo "ActiveSentinel:   $SENTINEL_ADDR"
echo ""
echo "Explorer links:"
echo "  https://explorer.mantle.xyz/address/$IDENTITY_ADDR"
echo "  https://explorer.mantle.xyz/address/$AUDITOR_ADDR"
echo "  https://explorer.mantle.xyz/address/$SENTINEL_ADDR"
echo "============================================="
