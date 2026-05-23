// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ActiveSentinel} from "../src/ActiveSentinel.sol";
import {SentinelIdentity} from "../src/SentinelIdentity.sol";
import {AlphaAuditor} from "../src/AlphaAuditor.sol";
import {ReputationRegistry} from "../src/ReputationRegistry.sol";
import {IdentityRegistry} from "../src/erc8004/IdentityRegistry.sol";
import {ValidationRegistry} from "../src/erc8004/ValidationRegistry.sol";

/// @title Deploy AlphaFlow Suite — Consolidated Deployment Script
/// @notice Последовательный деплой: ERC-8004 реестры → ActiveSentinel → Auditor → Reputation
/// @dev Phase 3: IdentityRegistry → ValidationRegistry → ActiveSentinel (с инъекцией адресов)
///
/// ПОРЯДОК ДЕПЛОЯ (зависимости):
///   1. IdentityRegistry (нет зависимостей)
///   2. ValidationRegistry (← IdentityRegistry)
///   3. ActiveSentinel (← INIT Core, DEX routers, TEE agent)
///   4. SentinelIdentity (нет зависимостей)
///   5. AlphaAuditor (← SentinelIdentity)
///   6. ReputationRegistry (← Oracle Relayer)
///
/// POST-DEPLOY:
///   - Регистрация TEE-агента в IdentityRegistry (mint ERC-721)
///   - Добавление TEE-агента как валидатора в ValidationRegistry
///   - Конфигурация ActiveSentinel: setIdentityRegistry(), setValidationRegistry()
contract DeployActiveSentinel is Script {
    // Mantle mainnet addresses (переопределяются через env)
    address constant INIT_CORE_MANTLE = address(0);
    address constant MERCHANT_MOE_ROUTER = address(0);
    address constant AGNI_ROUTER = address(0);

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address initCore = vm.envOr("INIT_CORE", INIT_CORE_MANTLE);
        address dexA = vm.envOr("DEX_ROUTER_A", MERCHANT_MOE_ROUTER);
        address dexB = vm.envOr("DEX_ROUTER_B", AGNI_ROUTER);
        address oracleRelayer = vm.envAddress("ORACLE_RELAYER_ADDRESS");
        address teeAgent = vm.envAddress("TEE_AGENT_ADDRESS");

        // Optional: AgentCard URI для автоматической регистрации
        string memory agentCardURI = vm.envOr(
            "AGENT_CARD_URI",
            string("ipfs://bafkreidefault_placeholder_replace_after_upload")
        );

        require(initCore != address(0), "INIT_CORE not set");
        require(dexA != address(0), "DEX_ROUTER_A not set");
        require(dexB != address(0), "DEX_ROUTER_B not set");
        require(oracleRelayer != address(0), "ORACLE_RELAYER_ADDRESS not set");
        require(teeAgent != address(0), "TEE_AGENT_ADDRESS not set");

        vm.startBroadcast(deployerKey);

        // ═══════════════════════════════════════════════════════════════════
        //  STEP 1: IdentityRegistry (ERC-8004 Agent Identity)
        // ═══════════════════════════════════════════════════════════════════
        IdentityRegistry identityReg = new IdentityRegistry();
        console2.log("[1/6] IdentityRegistry deployed at:", address(identityReg));

        // ═══════════════════════════════════════════════════════════════════
        //  STEP 2: ValidationRegistry (ERC-8004 Validation)
        // ═══════════════════════════════════════════════════════════════════
        ValidationRegistry validationReg = new ValidationRegistry(address(identityReg));
        console2.log("[2/6] ValidationRegistry deployed at:", address(validationReg));
        console2.log("       identityRegistry:", address(validationReg.identityRegistry()));

        // ═══════════════════════════════════════════════════════════════════
        //  STEP 3: ActiveSentinel (Core Execution Engine)
        // ═══════════════════════════════════════════════════════════════════
        ActiveSentinel sentinel = new ActiveSentinel(initCore, dexA, dexB, teeAgent);
        console2.log("[3/6] ActiveSentinel deployed at:", address(sentinel));
        console2.log("       Owner:", sentinel.owner());
        console2.log("       TEE Agent:", sentinel.authorizedTeeAgent());

        // ═══════════════════════════════════════════════════════════════════
        //  STEP 4: SentinelIdentity (Legacy ERC-721 — Agent Tokens)
        // ═══════════════════════════════════════════════════════════════════
        SentinelIdentity identity = new SentinelIdentity();
        console2.log("[4/6] SentinelIdentity deployed at:", address(identity));

        // ═══════════════════════════════════════════════════════════════════
        //  STEP 5: AlphaAuditor (Proof-of-Alpha Registry)
        // ═══════════════════════════════════════════════════════════════════
        AlphaAuditor auditor = new AlphaAuditor(address(identity));
        console2.log("[5/6] AlphaAuditor deployed at:", address(auditor));

        // ═══════════════════════════════════════════════════════════════════
        //  STEP 6: ReputationRegistry
        // ═══════════════════════════════════════════════════════════════════
        ReputationRegistry reputation = new ReputationRegistry(oracleRelayer);
        console2.log("[6/6] ReputationRegistry deployed at:", address(reputation));
        console2.log("       Oracle (BFF Relayer):", reputation.oracle());

        // ═══════════════════════════════════════════════════════════════════
        //  POST-DEPLOY: ERC-8004 Configuration Injection
        // ═══════════════════════════════════════════════════════════════════

        console2.log("");
        console2.log("--- POST-DEPLOY: ERC-8004 Configuration ---");

        // 1. Register TEE Agent in IdentityRegistry (mint ERC-721 AgentCard NFT)
        uint256 agentTokenId = identityReg.registerAgent(teeAgent, agentCardURI);
        console2.log("  Agent registered in IdentityRegistry:");
        console2.log("    tokenId:", agentTokenId);
        console2.log("    owner:", teeAgent);

        // 2. Add TEE Agent as validator in ValidationRegistry
        validationReg.addValidator(teeAgent);
        console2.log("  TEE Agent added as validator in ValidationRegistry");

        // 3. Inject ERC-8004 registry addresses into ActiveSentinel
        //    NOTE: ActiveSentinel must expose setIdentityRegistry/setValidationRegistry
        //    If not available, addresses are logged for manual configuration
        try sentinel.setIdentityRegistry(address(identityReg)) {
            console2.log("  ActiveSentinel.setIdentityRegistry:", address(identityReg));
        } catch {
            console2.log("  [WARN] ActiveSentinel.setIdentityRegistry not available");
            console2.log("         Manual config required:", address(identityReg));
        }

        try sentinel.setValidationRegistry(address(validationReg)) {
            console2.log("  ActiveSentinel.setValidationRegistry:", address(validationReg));
        } catch {
            console2.log("  [WARN] ActiveSentinel.setValidationRegistry not available");
            console2.log("         Manual config required:", address(validationReg));
        }

        vm.stopBroadcast();

        // ═══════════════════════════════════════════════════════════════════
        //  DEPLOYMENT SUMMARY
        // ═══════════════════════════════════════════════════════════════════
        console2.log("");
        console2.log("====================================================");
        console2.log("  ALPHAFLOW SUITE - DEPLOYMENT SUMMARY (Phase 3)");
        console2.log("====================================================");
        console2.log("  [ERC-8004]");
        console2.log("    IdentityRegistry:    ", address(identityReg));
        console2.log("    ValidationRegistry:  ", address(validationReg));
        console2.log("  [Core]");
        console2.log("    ActiveSentinel:      ", address(sentinel));
        console2.log("    SentinelIdentity:    ", address(identity));
        console2.log("    AlphaAuditor:        ", address(auditor));
        console2.log("    ReputationRegistry:  ", address(reputation));
        console2.log("  [Actors]");
        console2.log("    TEE Agent:           ", teeAgent);
        console2.log("    Oracle Relayer:      ", oracleRelayer);
        console2.log("    Agent Token ID:      ", agentTokenId);
        console2.log("====================================================");
        console2.log("");
        console2.log("  Next steps:");
        console2.log("  1. Upload AgentCard JSON to IPFS/Arweave");
        console2.log("  2. Update AGENT_CARD_URI and call identityReg.updateAgentCard()");
        console2.log("  3. Configure .env with deployed addresses");
        console2.log("  4. Run e2e smoke test: npx vitest tests/e2e-pipeline.test.ts");
        console2.log("====================================================");
    }
}
