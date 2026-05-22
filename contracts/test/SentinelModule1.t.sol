// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {SentinelIdentity} from "../src/SentinelIdentity.sol";
import {AlphaAuditor} from "../src/AlphaAuditor.sol";

/// @title SentinelModule1Test — Unit tests for SentinelIdentity + AlphaAuditor
contract SentinelModule1Test is Test {
    // ─── Contracts Under Test ──────────────────────────────────────────
    SentinelIdentity public identity;
    AlphaAuditor public auditor;

    // ─── Test Actors ───────────────────────────────────────────────────
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public charlie = makeAddr("charlie");

    // ─── Test Data ─────────────────────────────────────────────────────
    string constant AGENT_URI_ALICE = "ipfs://QmAliceAgentCard";
    string constant AGENT_URI_BOB = "ipfs://QmBobAgentCard";
    string constant UPDATED_URI = "ipfs://QmAliceAgentCardV2";
    bytes32 constant INSIGHT_HASH = keccak256("BUY WMNT conviction=0.87");
    bytes32 constant INSIGHT_HASH_2 = keccak256("SELL USDC conviction=0.65");

    // ═══════════════════════════════════════════════════════════════════
    //                          SETUP
    // ═══════════════════════════════════════════════════════════════════

    function setUp() public {
        identity = new SentinelIdentity();
        auditor = new AlphaAuditor(address(identity));
    }

    // ═══════════════════════════════════════════════════════════════════
    //              SENTINEL IDENTITY — REGISTRATION
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Успешная регистрация агента
    function test_registerAgent_success() public {
        vm.prank(alice);
        uint256 tokenId = identity.registerAgent(AGENT_URI_ALICE);

        // Token ID starts at 1
        assertEq(tokenId, 1);
        // Owner is alice
        assertEq(identity.ownerOf(tokenId), alice);
        // agentOf mapping updated
        assertEq(identity.agentOf(alice), tokenId);
        // Token URI correct
        assertEq(identity.tokenURI(tokenId), AGENT_URI_ALICE);
        // Total agents = 1
        assertEq(identity.totalAgents(), 1);
    }

    /// @notice Несколько агентов от разных адресов
    function test_registerAgent_multipleUsers() public {
        vm.prank(alice);
        uint256 aliceId = identity.registerAgent(AGENT_URI_ALICE);

        vm.prank(bob);
        uint256 bobId = identity.registerAgent(AGENT_URI_BOB);

        assertEq(aliceId, 1);
        assertEq(bobId, 2);
        assertEq(identity.totalAgents(), 2);
        assertEq(identity.ownerOf(1), alice);
        assertEq(identity.ownerOf(2), bob);
    }

    /// @notice Revert при повторной регистрации с того же адреса
    function test_registerAgent_revert_alreadyRegistered() public {
        vm.startPrank(alice);
        identity.registerAgent(AGENT_URI_ALICE);

        // Вторая попытка — revert
        vm.expectRevert(SentinelIdentity.AgentAlreadyRegistered.selector);
        identity.registerAgent("ipfs://QmDuplicate");
        vm.stopPrank();
    }

    /// @notice Event emitted при регистрации
    function test_registerAgent_emitsEvent() public {
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit SentinelIdentity.AgentRegistered(1, alice, AGENT_URI_ALICE);
        identity.registerAgent(AGENT_URI_ALICE);
    }

    // ═══════════════════════════════════════════════════════════════════
    //              SENTINEL IDENTITY — UPDATE AGENT CARD
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Владелец может обновить URI
    function test_updateAgentCard_success() public {
        vm.startPrank(alice);
        uint256 tokenId = identity.registerAgent(AGENT_URI_ALICE);
        identity.updateAgentCard(tokenId, UPDATED_URI);
        vm.stopPrank();

        assertEq(identity.tokenURI(tokenId), UPDATED_URI);
    }

    /// @notice Не-владелец не может обновить URI
    function test_updateAgentCard_revert_notOwner() public {
        vm.prank(alice);
        uint256 tokenId = identity.registerAgent(AGENT_URI_ALICE);

        vm.prank(bob);
        vm.expectRevert(SentinelIdentity.NotTokenOwner.selector);
        identity.updateAgentCard(tokenId, "ipfs://QmHacked");
    }

    /// @notice Event emitted при обновлении
    function test_updateAgentCard_emitsEvent() public {
        vm.startPrank(alice);
        uint256 tokenId = identity.registerAgent(AGENT_URI_ALICE);

        vm.expectEmit(true, false, false, true);
        emit SentinelIdentity.AgentCardUpdated(tokenId, UPDATED_URI);
        identity.updateAgentCard(tokenId, UPDATED_URI);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════
    //              ALPHA AUDITOR — COMMIT INSIGHT
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Успешный коммит инсайта от владельца агента
    function test_commitInsight_success() public {
        // Register agent first
        vm.prank(alice);
        uint256 agentId = identity.registerAgent(AGENT_URI_ALICE);

        // Commit insight
        vm.prank(alice);
        auditor.commitInsight(agentId, INSIGHT_HASH);

        // Count incremented
        assertEq(auditor.agentCommitCount(agentId), 1);
        assertEq(auditor.getCommitCount(agentId), 1);
    }

    /// @notice Множественные коммиты — счётчик растёт
    function test_commitInsight_multipleCommits() public {
        vm.prank(alice);
        uint256 agentId = identity.registerAgent(AGENT_URI_ALICE);

        vm.startPrank(alice);
        auditor.commitInsight(agentId, INSIGHT_HASH);
        auditor.commitInsight(agentId, INSIGHT_HASH_2);
        auditor.commitInsight(agentId, keccak256("third insight"));
        vm.stopPrank();

        assertEq(auditor.agentCommitCount(agentId), 3);
    }

    /// @notice Revert при попытке коммита от не-владельца агента
    function test_commitInsight_revert_unauthorizedAgent() public {
        // Alice registers
        vm.prank(alice);
        uint256 agentId = identity.registerAgent(AGENT_URI_ALICE);

        // Bob tries to commit on behalf of Alice's agent
        vm.prank(bob);
        vm.expectRevert(AlphaAuditor.UnauthorizedAgent.selector);
        auditor.commitInsight(agentId, INSIGHT_HASH);
    }

    /// @notice Revert при нулевом insightHash
    function test_commitInsight_revert_zeroHash() public {
        vm.prank(alice);
        uint256 agentId = identity.registerAgent(AGENT_URI_ALICE);

        vm.prank(alice);
        vm.expectRevert(AlphaAuditor.ZeroInsightHash.selector);
        auditor.commitInsight(agentId, bytes32(0));
    }

    /// @notice Revert при несуществующем agentId (ownerOf reverts)
    function test_commitInsight_revert_nonexistentAgent() public {
        vm.prank(alice);
        vm.expectRevert(); // ERC721: ownerOf reverts for non-existent token
        auditor.commitInsight(999, INSIGHT_HASH);
    }

    /// @notice Event emitted при коммите
    function test_commitInsight_emitsEvent() public {
        vm.prank(alice);
        uint256 agentId = identity.registerAgent(AGENT_URI_ALICE);

        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit AlphaAuditor.InsightCommitted(agentId, INSIGHT_HASH, block.timestamp);
        auditor.commitInsight(agentId, INSIGHT_HASH);
    }

    // ═══════════════════════════════════════════════════════════════════
    //              ALPHA AUDITOR — INTEGRATION
    // ═══════════════════════════════════════════════════════════════════

    /// @notice identityRegistry возвращает правильный адрес
    function test_auditor_identityRegistryLinked() public view {
        assertEq(address(auditor.identityRegistry()), address(identity));
    }

    /// @notice Разные агенты коммитят независимо
    function test_commitInsight_independentAgents() public {
        vm.prank(alice);
        uint256 aliceAgent = identity.registerAgent(AGENT_URI_ALICE);

        vm.prank(bob);
        uint256 bobAgent = identity.registerAgent(AGENT_URI_BOB);

        vm.startPrank(alice);
        auditor.commitInsight(aliceAgent, INSIGHT_HASH);
        auditor.commitInsight(aliceAgent, INSIGHT_HASH_2);
        vm.stopPrank();

        vm.prank(bob);
        auditor.commitInsight(bobAgent, INSIGHT_HASH);

        assertEq(auditor.agentCommitCount(aliceAgent), 2);
        assertEq(auditor.agentCommitCount(bobAgent), 1);
    }

    // ═══════════════════════════════════════════════════════════════════
    //              FUZZ TESTS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Fuzz: любой непустой URI проходит регистрацию
    function testFuzz_registerAgent(address user, string calldata uri) public {
        vm.assume(user != address(0));
        vm.assume(bytes(uri).length > 0);
        // Exclude contract addresses (safeMint checks onERC721Received)
        vm.assume(user.code.length == 0);

        vm.prank(user);
        uint256 tokenId = identity.registerAgent(uri);

        assertEq(identity.ownerOf(tokenId), user);
        assertEq(identity.tokenURI(tokenId), uri);
    }

    /// @notice Fuzz: любой ненулевой хэш проходит commitInsight
    function testFuzz_commitInsight(bytes32 hash) public {
        vm.assume(hash != bytes32(0));

        vm.prank(alice);
        uint256 agentId = identity.registerAgent(AGENT_URI_ALICE);

        vm.prank(alice);
        auditor.commitInsight(agentId, hash);

        assertEq(auditor.agentCommitCount(agentId), 1);
    }
}
