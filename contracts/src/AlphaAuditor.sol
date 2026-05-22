// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SentinelIdentity} from "./SentinelIdentity.sol";

/// @title AlphaAuditor — Proof-of-Alpha Registry
/// @notice Регистрирует хэши инсайтов (Proof-of-Alpha) от зарегистрированных агентов.
/// @dev Газ-оптимизация: хэш НЕ записывается в storage, только emit event.
///      Storage обновляется минимально — только счётчик коммитов.
contract AlphaAuditor {
    // ═══════════════════════════════════════════════════════════════════
    //                          ERRORS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Вызывающий не является владельцем указанного agentId
    error UnauthorizedAgent();

    /// @notice Нулевой хэш инсайта недопустим
    error ZeroInsightHash();

    // ═══════════════════════════════════════════════════════════════════
    //                          EVENTS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Эмитируется при фиксации инсайта агентом
    /// @param agentId ID агента (tokenId из SentinelIdentity)
    /// @param insightHash keccak256 хэш инсайта (content-addressable)
    /// @param timestamp block.timestamp фиксации
    event InsightCommitted(
        uint256 indexed agentId,
        bytes32 indexed insightHash,
        uint256 timestamp
    );

    // ═══════════════════════════════════════════════════════════════════
    //                          STORAGE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Ссылка на реестр идентичности агентов
    SentinelIdentity public immutable identityRegistry;

    /// @notice Счётчик коммитов инсайтов по каждому agentId
    mapping(uint256 => uint256) public agentCommitCount;

    // ═══════════════════════════════════════════════════════════════════
    //                          CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    /// @param _identityRegistry Адрес развёрнутого SentinelIdentity контракта
    constructor(address _identityRegistry) {
        identityRegistry = SentinelIdentity(_identityRegistry);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                      EXTERNAL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Фиксация хэша инсайта от имени агента.
    /// @dev Хэш НЕ хранится on-chain (gas optimization). Доказательство — event log.
    ///      Верификация: indexer/subgraph может восстановить полную историю из events.
    /// @param agentId tokenId агента в SentinelIdentity
    /// @param insightHash keccak256 хэш содержимого инсайта
    function commitInsight(uint256 agentId, bytes32 insightHash) external {
        // CHECKS
        // 1. Вызывающий должен быть владельцем agentId
        if (identityRegistry.ownerOf(agentId) != msg.sender) revert UnauthorizedAgent();

        // 2. Нулевой хэш недопустим (защита от случайного вызова)
        if (insightHash == bytes32(0)) revert ZeroInsightHash();

        // EFFECTS
        unchecked {
            agentCommitCount[agentId]++; // overflow невозможен в пределах uint256
        }

        // INTERACTIONS (нет внешних вызовов после effects — CEI соблюдён)
        emit InsightCommitted(agentId, insightHash, block.timestamp);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                      VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Количество коммитов инсайтов для агента
    /// @param agentId tokenId агента
    /// @return count Количество зафиксированных инсайтов
    function getCommitCount(uint256 agentId) external view returns (uint256 count) {
        return agentCommitCount[agentId];
    }
}
