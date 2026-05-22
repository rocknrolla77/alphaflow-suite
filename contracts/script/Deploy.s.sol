// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ActiveSentinel} from "../src/ActiveSentinel.sol";
import {SentinelIdentity} from "../src/SentinelIdentity.sol";
import {AlphaAuditor} from "../src/AlphaAuditor.sol";
import {ReputationRegistry} from "../src/ReputationRegistry.sol";

/// @title Deploy AlphaFlow Suite
/// @notice Деплой всех контрактов на Mantle mainnet/testnet
contract DeployActiveSentinel is Script {
    // Mantle mainnet addresses (обновить после верификации)
    address constant INIT_CORE_MANTLE = address(0); // TODO: адрес INIT Capital на Mantle
    address constant MERCHANT_MOE_ROUTER = address(0); // TODO: Merchant Moe router
    address constant AGNI_ROUTER = address(0); // TODO: Agni Finance router

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address initCore = vm.envOr("INIT_CORE", INIT_CORE_MANTLE);
        address dexA = vm.envOr("DEX_ROUTER_A", MERCHANT_MOE_ROUTER);
        address dexB = vm.envOr("DEX_ROUTER_B", AGNI_ROUTER);
        address oracleRelayer = vm.envAddress("ORACLE_RELAYER_ADDRESS");

        require(initCore != address(0), "INIT_CORE not set");
        require(dexA != address(0), "DEX_ROUTER_A not set");
        require(dexB != address(0), "DEX_ROUTER_B not set");
        require(oracleRelayer != address(0), "ORACLE_RELAYER_ADDRESS not set");

        vm.startBroadcast(deployerKey);

        // ─── 1. ActiveSentinel ─────────────────────────────────────────
        ActiveSentinel sentinel = new ActiveSentinel(initCore, dexA, dexB);
        console2.log("ActiveSentinel deployed at:", address(sentinel));
        console2.log("  Owner:", sentinel.owner());

        // ─── 2. SentinelIdentity (ERC-721) ─────────────────────────────
        SentinelIdentity identity = new SentinelIdentity();
        console2.log("SentinelIdentity deployed at:", address(identity));

        // ─── 3. AlphaAuditor ───────────────────────────────────────────
        AlphaAuditor auditor = new AlphaAuditor(address(identity));
        console2.log("AlphaAuditor deployed at:", address(auditor));

        // ─── 4. ReputationRegistry ─────────────────────────────────────
        ReputationRegistry reputation = new ReputationRegistry(oracleRelayer);
        console2.log("ReputationRegistry deployed at:", address(reputation));
        console2.log("  Oracle (BFF Relayer):", reputation.oracle());

        vm.stopBroadcast();

        // ─── Summary ───────────────────────────────────────────────────
        console2.log("");
        console2.log("═══════════════════════════════════════════════════════");
        console2.log("  DEPLOYMENT SUMMARY");
        console2.log("═══════════════════════════════════════════════════════");
        console2.log("  ActiveSentinel:      ", address(sentinel));
        console2.log("  SentinelIdentity:    ", address(identity));
        console2.log("  AlphaAuditor:        ", address(auditor));
        console2.log("  ReputationRegistry:  ", address(reputation));
        console2.log("  Oracle Relayer:      ", oracleRelayer);
        console2.log("═══════════════════════════════════════════════════════");
    }
}
