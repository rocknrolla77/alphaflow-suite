// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ActiveSentinel} from "../src/ActiveSentinel.sol";

/// @title Deploy Active Sentinel
/// @notice Деплой на Mantle mainnet/testnet
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

        require(initCore != address(0), "INIT_CORE not set");
        require(dexA != address(0), "DEX_ROUTER_A not set");
        require(dexB != address(0), "DEX_ROUTER_B not set");

        vm.startBroadcast(deployerKey);

        ActiveSentinel sentinel = new ActiveSentinel(initCore, dexA, dexB);

        console2.log("ActiveSentinel deployed at:", address(sentinel));
        console2.log("Owner:", sentinel.owner());
        console2.log("INIT Core:", sentinel.initCore());
        console2.log("DEX Router A:", sentinel.dexRouterA());
        console2.log("DEX Router B:", sentinel.dexRouterB());

        vm.stopBroadcast();
    }
}
