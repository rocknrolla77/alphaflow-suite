// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title MicroFundingDispatcher — TEE-Signed Meta-Transaction Relay with Gas Refund
/// @notice Принимает подписанные TEE-агентом запросы, маршрутизирует вызовы в целевые
///         контракты (Byreal Agent Wallet, ActiveSentinel и др.) и возмещает газ релейеру.
/// @dev Замена закрытых AA-систем (Biconomy/ZeroDev). Использует EIP-712 typed data
///      для защиты от подделки подписей. Пул MNT для рефандов хранится на балансе контракта.
///
///      Архитектура:
///        TEE Agent (Phala CVM) → подписывает ForwardRequest (EIP-712)
///        Relayer (любой EOA)   → отправляет TX, получает MNT компенсацию
///        Target                → целевой контракт получает вызов от имени Dispatcher
///
///      Безопасность:
///        - EIP-712 Domain Separator (chain-specific, address-specific)
///        - Nonce replay protection (per-target monotonic counter)
///        - Deadline staleness check (block.timestamp)
///        - Graceful degradation: если MNT пул пуст — TX проходит без рефанда
///        - Owner-only withdraw для экстренной эвакуации
contract MicroFundingDispatcher is EIP712 {
    // ═══════════════════════════════════════════════════════════════════════════
    //                              ERRORS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Дедлайн истёк — запрос устарел
    error DeadlineExpired();

    /// @notice Подпись не принадлежит зарегистрированному TEE-агенту
    error InvalidTEESignature();

    /// @notice Нонс не совпадает — возможная replay-атака
    error InvalidNonce();

    /// @notice Целевой вызов завершился с revert
    error TargetCallFailed(bytes returnData);

    /// @notice Только владелец может вызвать эту функцию
    error OnlyOwner();

    /// @notice Нулевой адрес недопустим
    error ZeroAddress();

    /// @notice Недостаточно MNT для вывода
    error InsufficientBalance();

    // ═══════════════════════════════════════════════════════════════════════════
    //                              EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Эмитируется при успешном исполнении meta-транзакции
    /// @param relayer Адрес EOA, отправившего TX (получает рефанд)
    /// @param target Целевой контракт, получивший вызов
    /// @param nonce Использованный нонс
    /// @param gasRefund Сумма MNT, возмещённая релейеру (0 если пул пуст)
    event Executed(
        address indexed relayer,
        address indexed target,
        uint256 nonce,
        uint256 gasRefund
    );

    /// @notice Эмитируется при пополнении MNT пула
    event PoolFunded(address indexed sender, uint256 amount);

    /// @notice Эмитируется при смене TEE-подписанта
    event TeeSignerUpdated(address indexed oldSigner, address indexed newSigner);

    /// @notice Эмитируется при экстренном выводе средств
    event EmergencyWithdraw(address indexed to, uint256 amount);

    /// @notice Рефанд не выплачен из-за пустого пула (graceful degradation)
    event RefundSkipped(address indexed relayer, uint256 attemptedAmount);

    // ═══════════════════════════════════════════════════════════════════════════
    //                            TYPE HASH
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev EIP-712 TypeHash для ForwardRequest
    ///      keccak256("ForwardRequest(address target,bytes data,uint256 value,uint256 nonce,uint256 deadline)")
    bytes32 public constant FORWARD_REQUEST_TYPEHASH = keccak256(
        "ForwardRequest(address target,bytes data,uint256 value,uint256 nonce,uint256 deadline)"
    );

    // ═══════════════════════════════════════════════════════════════════════════
    //                          DATA STRUCTURES
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Структура мета-транзакции, подписываемой TEE-агентом
    /// @param target Целевой контракт (Byreal Agent Wallet, ActiveSentinel, etc.)
    /// @param data Закодированный вызов (abi.encodeWithSelector(...))
    /// @param value Сумма MNT для передачи целевому контракту (0 если не требуется)
    /// @param nonce Монотонный счётчик для защиты от replay-атак
    /// @param deadline Unix timestamp — после него запрос невалиден
    struct ForwardRequest {
        address target;
        bytes data;
        uint256 value;
        uint256 nonce;
        uint256 deadline;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //                          STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Публичный ключ (адрес) TEE-агента Phala, чьи подписи принимаются
    address public teeSigner;

    /// @notice Владелец контракта (deployer) — может обновлять signer и выводить MNT
    address public immutable owner;

    /// @notice Монотонный нонс для каждого целевого адреса (replay protection)
    mapping(address => uint256) public nonces;

    /// @notice Базовый газовый оверхед, добавляемый к расчёту рефанда
    /// @dev Покрывает: SSTORE nonce, event emit, refund transfer, calldata decode
    uint256 public constant GAS_OVERHEAD = 30_000;

    // ═══════════════════════════════════════════════════════════════════════════
    //                          CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════

    /// @param _teeSigner Адрес TEE-агента (Phala CVM ephemeral key)
    constructor(address _teeSigner)
        EIP712("MicroFundingDispatcher", "1")
    {
        if (_teeSigner == address(0)) revert ZeroAddress();
        teeSigner = _teeSigner;
        owner = msg.sender;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //                        RECEIVE / FALLBACK
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Пополнение MNT пула для газовых рефандов
    receive() external payable {
        emit PoolFunded(msg.sender, msg.value);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //                      CORE EXECUTION LOGIC
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Исполнение мета-транзакции с верификацией TEE-подписи и рефандом газа
    /// @dev Полный pipeline:
    ///      1. Фиксация startGas
    ///      2. Deadline check (staleness)
    ///      3. Nonce check (replay)
    ///      4. EIP-712 digest → ECDSA.recover → сравнение с teeSigner
    ///      5. Nonce increment (CEI: effects before interactions)
    ///      6. Low-level call к target
    ///      7. Gas refund расчёт + transfer (graceful: не revert если пул пуст)
    ///
    /// @param req Подписанный TEE-агентом запрос
    /// @param signature 65-байтная ECDSA подпись (r, s, v) от teeSigner
    /// @return result Возвращённые данные от целевого контракта
    function executeValidatedCall(
        ForwardRequest calldata req,
        bytes calldata signature
    ) external returns (bytes memory result) {
        // 1. Фиксация стартового газа для расчёта рефанда
        uint256 startGas = gasleft();

        // 2. Staleness check — запрос не должен быть устаревшим
        if (block.timestamp > req.deadline) revert DeadlineExpired();

        // 3. Nonce check — защита от replay
        uint256 currentNonce = nonces[req.target];
        if (req.nonce != currentNonce) revert InvalidNonce();

        // 4. EIP-712 signature verification
        bytes32 structHash = keccak256(
            abi.encode(
                FORWARD_REQUEST_TYPEHASH,
                req.target,
                keccak256(req.data),
                req.value,
                req.nonce,
                req.deadline
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, signature);

        if (recovered != teeSigner) revert InvalidTEESignature();

        // 5. EFFECTS: Increment nonce BEFORE external call (CEI pattern)
        nonces[req.target] = currentNonce + 1;

        // 6. INTERACTIONS: Low-level call to target
        bool success;
        (success, result) = req.target.call{value: req.value}(req.data);

        if (!success) revert TargetCallFailed(result);

        // 7. Gas refund calculation + transfer (graceful degradation)
        uint256 gasUsed = startGas - gasleft() + GAS_OVERHEAD;
        uint256 refundAmount = gasUsed * tx.gasprice;

        if (address(this).balance >= refundAmount) {
            // Достаточно MNT — выплачиваем рефанд
            (bool refundSuccess,) = payable(msg.sender).call{value: refundAmount}("");
            if (!refundSuccess) {
                // Рефанд не прошёл (получатель — контракт без receive?)
                // Graceful: не revert, просто пропускаем
                emit RefundSkipped(msg.sender, refundAmount);
                refundAmount = 0;
            }
        } else {
            // Пул пуст — graceful degradation (TX проходит без компенсации)
            emit RefundSkipped(msg.sender, refundAmount);
            refundAmount = 0;
        }

        emit Executed(msg.sender, req.target, currentNonce, refundAmount);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Обновление адреса TEE-подписанта (при ротации ключей)
    /// @param _newSigner Новый адрес TEE-агента
    function setTeeSigner(address _newSigner) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (_newSigner == address(0)) revert ZeroAddress();

        address oldSigner = teeSigner;
        teeSigner = _newSigner;

        emit TeeSignerUpdated(oldSigner, _newSigner);
    }

    /// @notice Экстренный вывод MNT из пула (только владелец)
    /// @param amount Сумма MNT для вывода
    function withdraw(uint256 amount) external {
        if (msg.sender != owner) revert OnlyOwner();
        if (address(this).balance < amount) revert InsufficientBalance();

        (bool success,) = payable(owner).call{value: amount}("");
        require(success, "Withdraw failed");

        emit EmergencyWithdraw(owner, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //                        VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Текущий нонс для целевого адреса
    /// @param target Адрес целевого контракта
    /// @return nonce Текущий (ожидаемый) нонс
    function getNonce(address target) external view returns (uint256) {
        return nonces[target];
    }

    /// @notice Баланс MNT пула для рефандов
    /// @return balance Текущий баланс контракта
    function getPoolBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice EIP-712 Domain Separator (для внешней верификации подписей)
    /// @return domainSeparator Хэш домена
    function getDomainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
