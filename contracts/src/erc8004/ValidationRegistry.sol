// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IdentityRegistry} from "./IdentityRegistry.sol";

/// @title ValidationRegistry — ERC-8004 Cryptographic Validation
/// @notice Реестр валидации AI-агентов. Позволяет запросить аудит агента и записать
///         ответ от независимого TEE-оракула (Validation Hook).
/// @dev Полная имплементация ERC-8004 Validation Registry:
///      - requestValidation: создаёт запрос на валидацию с привязкой к agentId
///      - submitValidation: TEE-оракул записывает результат + attestation quote
///      - On-chain audit trail: все валидации доступны через events + mappings
///
/// АРХИТЕКТУРА:
///   1. Любой адрес вызывает requestValidation(agentId, requestURI, requestHash)
///   2. Event ValidationRequest эмитируется → off-chain TEE-оракулы слушают
///   3. TEE-оракул проводит аудит (проверяет AgentCard, endpoints, behaviour)
///   4. TEE-оракул вызывает submitValidation с результатом + SGX/TDX attestation quote
///
/// TRUST MODEL:
///   - Валидаторы (TEE-оракулы) регистрируются owner через addValidator/removeValidator
///   - Каждый валидатор может подать ответ только один раз на request
///   - attestationQuote содержит SGX/TDX quote для верификации TEE среды
contract ValidationRegistry {
    // ═══════════════════════════════════════════════════════════════════
    //                          ERRORS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Агент с данным tokenId не существует в IdentityRegistry
    error AgentNotFound();

    /// @notice Вызывающий не является зарегистрированным валидатором
    error UnauthorizedValidator();

    /// @notice Валидатор уже отправил ответ на этот request
    error AlreadyValidated();

    /// @notice Запрос валидации не существует
    error RequestNotFound();

    /// @notice Пустой requestURI
    error EmptyRequestURI();

    /// @notice Нулевой хэш
    error ZeroHash();

    /// @notice Только владелец контракта
    error Unauthorized();

    /// @notice Нулевой адрес
    error ZeroAddress();

    // ═══════════════════════════════════════════════════════════════════
    //                          EVENTS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Запрос на валидацию агента
    /// @param requester Адрес инициатора запроса
    /// @param agentId ID агента из IdentityRegistry
    /// @param requestURI URI документа запроса (описание критериев аудита)
    /// @param requestHash keccak256 хэш содержимого запроса (content-addressable)
    event ValidationRequest(
        address indexed requester,
        uint256 indexed agentId,
        string requestURI,
        bytes32 indexed requestHash
    );

    /// @notice Результат валидации от TEE-оракула
    /// @param validator Адрес валидатора (TEE-оракул)
    /// @param agentId ID валидируемого агента
    /// @param requestHash Хэш оригинального запроса
    /// @param isValid Результат: true = агент прошёл валидацию
    /// @param attestationHash keccak256 от attestation quote (для верификации)
    event ValidationSubmitted(
        address indexed validator,
        uint256 indexed agentId,
        bytes32 indexed requestHash,
        bool isValid,
        bytes32 attestationHash
    );

    /// @notice Валидатор добавлен
    event ValidatorAdded(address indexed validator);

    /// @notice Валидатор удалён
    event ValidatorRemoved(address indexed validator);

    // ═══════════════════════════════════════════════════════════════════
    //                          STRUCTS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Запись результата валидации
    struct ValidationResult {
        address validator;      // TEE-оракул
        bool isValid;           // Результат аудита
        bytes32 attestationHash; // keccak256(attestationQuote)
        uint256 timestamp;      // block.timestamp ответа
    }

    /// @notice Метаданные запроса валидации
    struct ValidationRequestData {
        address requester;      // Инициатор запроса
        uint256 agentId;        // ID агента
        string requestURI;      // URI критериев аудита
        uint256 timestamp;      // block.timestamp запроса
        bool exists;            // Флаг существования
    }

    // ═══════════════════════════════════════════════════════════════════
    //                          STORAGE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Владелец контракта (управление валидаторами)
    address public immutable owner;

    /// @notice Ссылка на IdentityRegistry (для проверки существования агентов)
    IdentityRegistry public immutable identityRegistry;

    /// @notice Зарегистрированные валидаторы (TEE-оракулы)
    mapping(address => bool) public isValidator;

    /// @notice Запросы валидации: requestHash → данные запроса
    mapping(bytes32 => ValidationRequestData) public requests;

    /// @notice Результаты валидации: requestHash → validator → result
    mapping(bytes32 => mapping(address => ValidationResult)) public results;

    /// @notice Количество валидаций по запросу: requestHash → count
    mapping(bytes32 => uint256) public validationCount;

    /// @notice Количество положительных валидаций: requestHash → count
    mapping(bytes32 => uint256) public positiveValidationCount;

    /// @notice Все запросы для агента: agentId → requestHash[]
    mapping(uint256 => bytes32[]) public agentRequests;

    // ═══════════════════════════════════════════════════════════════════
    //                          CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    /// @param _identityRegistry Адрес контракта IdentityRegistry
    constructor(address _identityRegistry) {
        if (_identityRegistry == address(0)) revert ZeroAddress();
        owner = msg.sender;
        identityRegistry = IdentityRegistry(_identityRegistry);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                      MODIFIERS
    // ═══════════════════════════════════════════════════════════════════

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyValidator() {
        if (!isValidator[msg.sender]) revert UnauthorizedValidator();
        _;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                      VALIDATOR MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Добавить TEE-оракул как валидатор
    /// @param validator Адрес TEE-оракула
    function addValidator(address validator) external onlyOwner {
        if (validator == address(0)) revert ZeroAddress();
        isValidator[validator] = true;
        emit ValidatorAdded(validator);
    }

    /// @notice Удалить валидатор
    /// @param validator Адрес удаляемого валидатора
    function removeValidator(address validator) external onlyOwner {
        isValidator[validator] = false;
        emit ValidatorRemoved(validator);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                      CORE FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Запросить валидацию агента
    /// @param agentId ID агента из IdentityRegistry
    /// @param requestURI URI документа с критериями аудита (ipfs://... или ar://...)
    /// @param requestHash keccak256 хэш содержимого запроса (content-addressable идентификатор)
    /// @dev Любой адрес может запросить валидацию. TEE-оракулы слушают event ValidationRequest.
    ///
    /// FLOW:
    ///   1. Вызывающий формирует документ аудита (JSON с критериями)
    ///   2. Загружает на IPFS/Arweave, получает CID
    ///   3. Вычисляет keccak256(document) = requestHash
    ///   4. Вызывает requestValidation(agentId, "ipfs://CID", requestHash)
    ///   5. Off-chain TEE-оракулы подхватывают event и проводят аудит
    function requestValidation(
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external {
        // CHECKS
        if (bytes(requestURI).length == 0) revert EmptyRequestURI();
        if (requestHash == bytes32(0)) revert ZeroHash();

        // Проверяем что агент существует в IdentityRegistry
        // ownerOf reverts если token не существует (ERC-721 стандарт)
        identityRegistry.ownerOf(agentId);

        // Проверяем что запрос с таким хэшем ещё не существует
        // (допускаем перезапрос если requestHash уникален)
        require(!requests[requestHash].exists, "Request already exists");

        // EFFECTS
        requests[requestHash] = ValidationRequestData({
            requester: msg.sender,
            agentId: agentId,
            requestURI: requestURI,
            timestamp: block.timestamp,
            exists: true
        });

        agentRequests[agentId].push(requestHash);

        // EMIT
        emit ValidationRequest(msg.sender, agentId, requestURI, requestHash);
    }

    /// @notice Записать результат валидации от TEE-оракула
    /// @param agentId ID валидируемого агента
    /// @param requestHash Хэш оригинального запроса валидации
    /// @param isValid Результат аудита (true = агент прошёл проверку)
    /// @param attestationQuote Полный SGX/TDX Remote Attestation quote
    /// @dev Только зарегистрированные валидаторы (TEE-оракулы) могут вызывать.
    ///      attestationQuote хранится как хэш on-chain (газ-оптимизация),
    ///      полный quote доступен через event logs.
    ///
    /// SECURITY:
    ///   - Один валидатор может ответить только один раз на запрос
    ///   - attestationQuote можно верифицировать off-chain через Intel/AMD attestation service
    ///   - On-chain хранится только hash для audit trail
    function submitValidation(
        uint256 agentId,
        bytes32 requestHash,
        bool isValid,
        bytes calldata attestationQuote
    ) external onlyValidator {
        // CHECKS
        if (!requests[requestHash].exists) revert RequestNotFound();
        if (requests[requestHash].agentId != agentId) revert AgentNotFound();
        if (results[requestHash][msg.sender].timestamp != 0) revert AlreadyValidated();

        // EFFECTS
        bytes32 attestationHash = keccak256(attestationQuote);

        results[requestHash][msg.sender] = ValidationResult({
            validator: msg.sender,
            isValid: isValid,
            attestationHash: attestationHash,
            timestamp: block.timestamp
        });

        validationCount[requestHash]++;
        if (isValid) {
            positiveValidationCount[requestHash]++;
        }

        // EMIT
        emit ValidationSubmitted(
            msg.sender,
            agentId,
            requestHash,
            isValid,
            attestationHash
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    //                      VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Получить все requestHash для агента
    /// @param agentId ID агента
    /// @return Массив requestHash
    function getAgentRequests(uint256 agentId) external view returns (bytes32[] memory) {
        return agentRequests[agentId];
    }

    /// @notice Проверить результат конкретного валидатора
    /// @param requestHash Хэш запроса
    /// @param validator Адрес валидатора
    /// @return result Структура ValidationResult
    function getValidationResult(
        bytes32 requestHash,
        address validator
    ) external view returns (ValidationResult memory result) {
        return results[requestHash][validator];
    }

    /// @notice Рассчитать процент положительных валидаций
    /// @param requestHash Хэш запроса
    /// @return Процент (0-100), 0 если нет валидаций
    function getApprovalRate(bytes32 requestHash) external view returns (uint256) {
        uint256 total = validationCount[requestHash];
        if (total == 0) return 0;
        return (positiveValidationCount[requestHash] * 100) / total;
    }
}
