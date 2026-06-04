// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {SentinelIdentity} from "../src/SentinelIdentity.sol";
import {AlphaAuditor} from "../src/AlphaAuditor.sol";
import {ActiveSentinel} from "../src/ActiveSentinel.sol";

/// @title DeployMainnet - Ordered deployment for Mantle Mainnet
/// @notice Deploy order:
///   1. SentinelIdentity (no deps)
///   2. AlphaAuditor (requires SentinelIdentity address)
///   3. ActiveSentinel (requires initCore, dexRouterA, dexRouterB, teeAgent)
///   4. Post-deploy: ActiveSentinel.setIdentityRegistry(SentinelIdentity)
contract DeployMainnet is Script {
    // Mantle Mainnet Protocol Addresses
    address constant INIT_CORE    = 0x972bCB0284cCA0e24C81F6BF8EE48bd7E2E90f91;
    address constant DEX_ROUTER_A = 0xeaEE7EE68874218c3558b40063c42B82D3E7232a;
    address constant DEX_ROUTER_B = 0x319B69888b0d11cEC22caA5034e25FfFBDc88421;

    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);
        address teeAgent = vm.envOr("TEE_AGENT_ADDRESS", deployer);

        console2.log("=== AlphaFlow - Mantle Mainnet Deploy ===");
        console2.log("Deployer:", deployer);
        console2.log("TEE Agent:", teeAgent);

        vm.startBroadcast(deployerPk);

        // 1. SentinelIdentity
        SentinelIdentity identity = new SentinelIdentity();
        console2.log("[1/3] SentinelIdentity:", address(identity));

        // 2. AlphaAuditor
        AlphaAuditor auditor = new AlphaAuditor(address(identity));
        console2.log("[2/3] AlphaAuditor:", address(auditor));

        // 3. Register TEE agent in IdentityRegistry
        uint256 agentTokenId = identity.registerAgent(
            "https://alphaflow.xyz/agent-card.json"
        );
        console2.log("[3/5] TEE Agent registered, tokenId:", agentTokenId);

        // 4. ActiveSentinel
        ActiveSentinel sentinel = new ActiveSentinel(
            INIT_CORE,
            DEX_ROUTER_A,
            DEX_ROUTER_B
        );
        console2.log("[4/5] ActiveSentinel:", address(sentinel));

        // 5. Link Identity Registry
        sentinel.setIdentityRegistry(address(identity), agentTokenId);
        console2.log("[5/5] setIdentityRegistry done");

        vm.stopBroadcast();

        console2.log("=== DEPLOYMENT COMPLETE ===");
    }
}
