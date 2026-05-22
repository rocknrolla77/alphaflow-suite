// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ReputationRegistry — On-chain Agent Reputation (ERC-8004 inspired)
/// @notice Хранит агрегированные репутационные оценки TEE-агентов.
///         Оценки записываются batch-ами от авторизованного оракула (BFF Relayer).
/// @dev Газ-оптимизация:
///      - Один batch-вызов на интервал (а не 1 tx на каждый vote)
///      - int128 для scoreDelta (допускает отрицательные значения)
///      - Минимальный storage footprint: 2 mapping
contract ReputationRegistry {
    // ═══════════════════════════════════════════════════════════════════
    //                          ERRORS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Вызывающий не является авторизованным оракулом
    error UnauthorizedOracle();

    /// @notice Нулевой scoreDelta (нет смысла записывать пустой batch)
    error ZeroScoreDelta();

    /// @notice Нулевое количество голосов
    error ZeroVotersCount();

    /// @notice Переполнение int128 при суммировании
    error ScoreOverflow();

    /// @notice Новый оракул — нулевой адрес
    error ZeroAddress();

    // ═══════════════════════════════════════════════════════════════════
    //                          EVENTS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Эмитируется при успешной фиксации batch-а фидбэка
    /// @param agentId ID агента (tokenId из SentinelIdentity)
    /// @param scoreDelta Дельта репутации за batch (+N или -N)
    /// @param newTotalScore Итоговая репутация агента после обновления
    event FeedbackRegistered(
        uint256 indexed agentId,
        int128 scoreDelta,
        int128 newTotalScore
    );

    /// @notice Эмитируется при смене оракула
    event OracleUpdated(address indexed previousOracle, address indexed newOracle);

    // ═══════════════════════════════════════════════════════════════════
    //                          STORAGE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Адрес владельца (может менять оракул)
    address public owner;

    /// @notice Авторизованный оракул (BFF Relayer), единственный кто может писать
    address public oracle;

    /// @notice Кумулятивная репутация агента (может быть отрицательной)
    /// @dev int128 дает диапазон ±1.7e38, достаточно для любого масштаба
    mapping(uint256 => int128) public agentReputation;

    /// @notice Общее количество голосов за всё время (monotonic, never decreases)
    mapping(uint256 => uint256) public agentTotalVotes;

    // ═══════════════════════════════════════════════════════════════════
    //                          MODIFIERS
    // ═══════════════════════════════════════════════════════════════════

    modifier onlyOracle() {
        if (msg.sender != oracle) revert UnauthorizedOracle();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert UnauthorizedOracle();
        _;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                          CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    /// @param _oracle Начальный адрес оракула (BFF Relayer wallet)
    constructor(address _oracle) {
        if (_oracle == address(0)) revert ZeroAddress();
        owner = msg.sender;
        oracle = _oracle;
        emit OracleUpdated(address(0), _oracle);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                          EXTERNAL
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Записывает агрегированный batch фидбэка для одного агента
    /// @dev Вызывается BFF Relayer раз в N минут с суммой голосов за период.
    ///      Газ: ~26k первый вызов (cold slots), ~6k последующие (warm slots)
    /// @param agentId ID агента (SentinelIdentity tokenId)
    /// @param scoreDelta Суммарная дельта за batch (может быть + или -)
    /// @param votersCount Количество уникальных голосов в batch-е
    /// @param metadata Произвольные метаданные (timestamp batch-а, epoch и т.д.)
    function postFeedbackBatch(
        uint256 agentId,
        int128 scoreDelta,
        uint256 votersCount,
        bytes calldata metadata
    ) external onlyOracle {
        if (scoreDelta == 0) revert ZeroScoreDelta();
        if (votersCount == 0) revert ZeroVotersCount();

        // ─── Overflow check ───────────────────────────────────────────────
        int128 currentScore = agentReputation[agentId];
        int128 newScore;

        // Manual overflow detection for int128 addition
        unchecked {
            newScore = currentScore + scoreDelta;
        }

        // Check: if scoreDelta > 0 and newScore < currentScore → overflow
        // Check: if scoreDelta < 0 and newScore > currentScore → underflow
        if (scoreDelta > 0 && newScore < currentScore) revert ScoreOverflow();
        if (scoreDelta < 0 && newScore > currentScore) revert ScoreOverflow();

        // ─── State updates ────────────────────────────────────────────────
        agentReputation[agentId] = newScore;
        agentTotalVotes[agentId] += votersCount;

        // ─── Event ────────────────────────────────────────────────────────
        // metadata is intentionally NOT stored — only passed for off-chain indexing
        // (included in transaction calldata, accessible via tx input parsing)
        emit FeedbackRegistered(agentId, scoreDelta, newScore);
    }

    /// @notice Batch-вызов для нескольких агентов за один tx
    /// @dev Экономия gas: один base tx cost (21k) на все агенты
    /// @param agentIds Массив ID агентов
    /// @param scoreDeltas Массив дельт (parallel с agentIds)
    /// @param votersCounts Массив количеств голосов (parallel)
    /// @param metadata Общие метаданные для всего batch-а
    function postFeedbackBatchMulti(
        uint256[] calldata agentIds,
        int128[] calldata scoreDeltas,
        uint256[] calldata votersCounts,
        bytes calldata metadata
    ) external onlyOracle {
        uint256 length = agentIds.length;
        require(length == scoreDeltas.length && length == votersCounts.length, "Array length mismatch");
        require(length > 0, "Empty batch");

        for (uint256 i = 0; i < length;) {
            int128 scoreDelta = scoreDeltas[i];
            uint256 votersCount = votersCounts[i];

            if (scoreDelta == 0) revert ZeroScoreDelta();
            if (votersCount == 0) revert ZeroVotersCount();

            uint256 agentId = agentIds[i];
            int128 currentScore = agentReputation[agentId];
            int128 newScore;

            unchecked {
                newScore = currentScore + scoreDelta;
            }

            if (scoreDelta > 0 && newScore < currentScore) revert ScoreOverflow();
            if (scoreDelta < 0 && newScore > currentScore) revert ScoreOverflow();

            agentReputation[agentId] = newScore;
            agentTotalVotes[agentId] += votersCount;

            emit FeedbackRegistered(agentId, scoreDelta, newScore);

            unchecked { ++i; }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //                          ADMIN
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Обновляет адрес оракула (только owner)
    /// @param newOracle Новый адрес оракула
    function setOracle(address newOracle) external onlyOwner {
        if (newOracle == address(0)) revert ZeroAddress();
        address old = oracle;
        oracle = newOracle;
        emit OracleUpdated(old, newOracle);
    }

    /// @notice Передача ownership (только owner)
    /// @param newOwner Новый владелец
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                          VIEW
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Возвращает полный профиль репутации агента
    /// @param agentId ID агента
    /// @return reputation Текущая кумулятивная репутация
    /// @return totalVotes Общее количество голосов
    function getAgentProfile(uint256 agentId) external view returns (
        int128 reputation,
        uint256 totalVotes
    ) {
        reputation = agentReputation[agentId];
        totalVotes = agentTotalVotes[agentId];
    }
}
