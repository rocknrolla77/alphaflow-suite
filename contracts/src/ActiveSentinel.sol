// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IINITCore} from "./interfaces/IINITCore.sol";
import {IFlashBorrower} from "./interfaces/IFlashBorrower.sol";
import {IDexRouter} from "./interfaces/IDexRouter.sol";
import {IdentityRegistry} from "./erc8004/IdentityRegistry.sol";

/// @title ActiveSentinel — Core Execution Engine (Hardened)
/// @notice Атомарный флеш-арбитраж на Mantle Network с гибридной защитой и криптографической валидацией
/// @dev Phase 2: Context Validation (H-08), Hybrid Reentrancy Guard, Token Whitelist
/// @custom:security-contact security@alphaflow.xyz
contract ActiveSentinel is EIP712, IFlashBorrower {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════
    //                          STORAGE
    // ═══════════════════════════════════════════════════════════════════

    address public immutable owner;
    address public immutable initCore;
    address public immutable dexRouterA; // Merchant Moe
    address public immutable dexRouterB; // Agni Finance

    /// @notice Авторизованный TEE-агент (подписывает EIP-712 квитанции)
    address public authorizedTeeAgent;

    /// @notice ERC-8004 IdentityRegistry (для разрешения agentId)
    IdentityRegistry public identityRegistry;

    /// @notice Agent ID (ERC-8004 tokenId) данного TEE-агента
    uint256 public agentId;

    /// @dev Гибридный замок: SSTORE (газовый барьер для low-gas субконтекстов)
    /// Значение 1 = unlocked, 2 = locked
    uint256 private _reentrancyStatus = 1;

    /// @dev Слот для TSTORE (быстрая проверка, газ-оптимизация)
    /// keccak256("sentinel.reentrancy.lock") - 1
    bytes32 private constant TSTORE_LOCK_SLOT = 0x8b1a944cf13a9a1c08facb1f3de33a0e0c40e06ee15c5e8a12ef28645c0d69a5;

    /// @dev EIP-712 typehash для ArbParams
    bytes32 private constant ARB_TYPEHASH = keccak256(
        "ArbParams(address tokenA,address tokenB,uint256 borrowAmount,uint256 minProfitTokenA,uint256 nonce,bytes32 reasoningHash)"
    );

    // Magic return value для callback подтверждения
    bytes32 private constant CALLBACK_SUCCESS = keccak256("IFlashBorrower.onFlashBorrow");

    /// @notice Белый список разрешённых токенов (защита от ERC-777 hooks)
    mapping(address => bool) public isWhitelistedToken;

    /// @notice Использованные nonces (replay protection)
    mapping(uint256 => bool) public usedNonces;

    // ═══════════════════════════════════════════════════════════════════
    //                          ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error Unauthorized();
    error ReentrancyAttempt();
    error InvariantViolated(uint256 expectedMinProfit, uint256 actualProfit);
    error SwapFailed(uint8 routeIndex);
    error ZeroAmount();
    error InvalidInitiator();
    error InvalidTEESignature();
    error UnapprovedToken();
    error NonceAlreadyUsed();
    error ZeroAddress();

    // ═══════════════════════════════════════════════════════════════════
    //                          EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event ArbitrageExecuted(
        address indexed tokenA,
        address indexed tokenB,
        uint256 borrowAmount,
        uint256 profit,
        bytes32 reasoningHash,
        uint256 indexed agentId
    );

    event TeeAgentUpdated(address indexed oldAgent, address indexed newAgent);
    event TokenWhitelistUpdated(address indexed token, bool status);
    event IdentityRegistryUpdated(address indexed registry, uint256 agentId);

    // ═══════════════════════════════════════════════════════════════════
    //                          STRUCTS
    // ═══════════════════════════════════════════════════════════════════

    struct ArbParams {
        address tokenA;          // Базовый токен (borrow & profit token)
        address tokenB;          // Промежуточный токен
        uint256 borrowAmount;    // Количество tokenA для flash borrow
        uint256 minProfitTokenA; // Минимальный профит (рассчитан TEE off-chain)
        uint256 nonce;           // Replay protection nonce
        uint256 amountOutMinRoute1; // Slippage protection: route 1 (A -> B)
        uint256 amountOutMinRoute2; // Slippage protection: route 2 (B -> A)
        bytes32 reasoningHash;   // keccak256 хэш off-chain reasoning (ERC-8004 transparency)
        bytes dexPayloadRoute1;  // Merchant Moe: swap tokenA -> tokenB
        bytes dexPayloadRoute2;  // Agni Finance: swap tokenB -> tokenA
        bytes teeSignature;      // EIP-712 подпись от авторизованного TEE-агента
    }

    // ═══════════════════════════════════════════════════════════════════
    //                          CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(
        address _initCore,
        address _dexRouterA,
        address _dexRouterB,
        address _teeAgent
    ) EIP712("AlphaFlow_ActiveSentinel", "2") {
        if (_initCore == address(0) || _dexRouterA == address(0) 
            || _dexRouterB == address(0) || _teeAgent == address(0)) revert ZeroAddress();
        
        owner = msg.sender;
        initCore = _initCore;
        dexRouterA = _dexRouterA;
        dexRouterB = _dexRouterB;
        authorizedTeeAgent = _teeAgent;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                          MODIFIERS
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Гибридная защита от повторного входа:
    ///      1) TLOAD — быстрая проверка (газ-оптимизация, ~100 gas)
    ///      2) SSTORE — физический барьер для low-gas reentrancy
    ///         Если атакующий вызывает callback с ≤2300 gas stipend,
    ///         TLOAD/TSTORE могут быть недоступны, но SSTORE check гарантирует revert (OOG)
    modifier hybridReentrancyGuard() {
        // 1. TSTORE: быстрая проверка (основной путь)
        assembly {
            if tload(TSTORE_LOCK_SLOT) {
                // ReentrancyAttempt() selector = 0x47baea06
                mstore(0x00, 0x47baea0600000000000000000000000000000000000000000000000000000000)
                revert(0x00, 0x04)
            }
            tstore(TSTORE_LOCK_SLOT, 1)
        }

        // 2. SSTORE: физический барьер (защита от EIP-1153 bypass в low-gas контекстах)
        if (_reentrancyStatus != 1) revert ReentrancyAttempt();
        _reentrancyStatus = 2;

        _;

        // Unlock: SSTORE + TSTORE
        _reentrancyStatus = 1;
        assembly {
            tstore(TSTORE_LOCK_SLOT, 0)
        }
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                      EXTERNAL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Точка входа для арбитражной операции
    /// @dev Вызывается owner (EOA или ZeroDev Kernel account через Session Key)
    /// @param params Параметры арбитража, рассчитанные и подписанные TEE-агентом
    function executeFlashArbitrage(ArbParams calldata params) external onlyOwner hybridReentrancyGuard {
        // CHECKS: Token whitelist
        if (!isWhitelistedToken[params.tokenA]) revert UnapprovedToken();
        if (!isWhitelistedToken[params.tokenB]) revert UnapprovedToken();

        // CHECKS: Zero amount
        if (params.borrowAmount == 0) revert ZeroAmount();

        // CHECKS: Nonce replay protection
        if (usedNonces[params.nonce]) revert NonceAlreadyUsed();

        // EFFECTS: Consume nonce
        usedNonces[params.nonce] = true;

        // CHECKS: TEE Agent EIP-712 signature verification
        _verifyTeeSignature(params);

        uint256 balanceBefore = IERC20(params.tokenA).balanceOf(address(this));

        // INTERACTIONS: Flash borrow инициирует callback
        IINITCore(initCore).flashBorrow(
            params.tokenA,
            params.borrowAmount,
            abi.encode(params)
        );

        // POST-INTERACTION CHECKS (invariant enforcement)
        uint256 balanceAfter = IERC20(params.tokenA).balanceOf(address(this));

        if (balanceAfter <= balanceBefore) {
            revert InvariantViolated(params.minProfitTokenA, 0);
        }

        uint256 actualProfit = balanceAfter - balanceBefore;
        if (actualProfit < params.minProfitTokenA) {
            revert InvariantViolated(params.minProfitTokenA, actualProfit);
        }

        emit ArbitrageExecuted(
            params.tokenA,
            params.tokenB,
            params.borrowAmount,
            actualProfit,
            params.reasoningHash,
            agentId
        );
    }

    /// @notice Callback от INIT Capital после передачи flash borrow
    /// @dev Защита от спуфинга H-08: msg.sender == initCore && initiator == address(this)
    function onFlashBorrow(
        address initiator,
        address token,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external override returns (bytes32) {
        // Проверка источника вызова: ТОЛЬКО INIT Core
        if (msg.sender != initCore) revert Unauthorized();

        // H-08 FIX: Защита от подмены контекста через многоуровневые позиции
        // Инициатором flash borrow ДОЛЖЕН быть этот контракт
        if (initiator != address(this)) revert InvalidInitiator();

        ArbParams memory params = abi.decode(data, (ArbParams));

        // ─── Route 1: tokenA -> tokenB (Merchant Moe) ───
        uint256 tokenABalance = IERC20(params.tokenA).balanceOf(address(this));
        IERC20(params.tokenA).safeIncreaseAllowance(dexRouterA, tokenABalance);

        uint256 receivedB = IDexRouter(dexRouterA).swap(
            params.tokenA,
            params.tokenB,
            tokenABalance,
            params.amountOutMinRoute1,
            params.dexPayloadRoute1
        );

        if (receivedB == 0) revert SwapFailed(1);

        // ─── Route 2: tokenB -> tokenA (Agni Finance) ───
        IERC20(params.tokenB).safeIncreaseAllowance(dexRouterB, receivedB);

        uint256 receivedA = IDexRouter(dexRouterB).swap(
            params.tokenB,
            params.tokenA,
            receivedB,
            params.amountOutMinRoute2,
            params.dexPayloadRoute2
        );

        if (receivedA == 0) revert SwapFailed(2);

        // ─── Возврат долга INIT Capital ───
        uint256 repayAmount = amount + fee;
        IERC20(token).safeTransfer(initCore, repayAmount);

        return CALLBACK_SUCCESS;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                      ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Обновить авторизованный TEE-агент
    /// @param _newAgent Адрес нового TEE-агента
    function setTeeAgent(address _newAgent) external onlyOwner {
        if (_newAgent == address(0)) revert ZeroAddress();
        address oldAgent = authorizedTeeAgent;
        authorizedTeeAgent = _newAgent;
        emit TeeAgentUpdated(oldAgent, _newAgent);
    }

    /// @notice Управление белым списком токенов
    /// @param token Адрес токена
    /// @param status true = разрешён, false = заблокирован
    function setWhitelistedToken(address token, bool status) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        isWhitelistedToken[token] = status;
        emit TokenWhitelistUpdated(token, status);
    }

    /// @notice Batch-обновление белого списка
    /// @param tokens Массив адресов токенов
    /// @param statuses Массив статусов
    function batchWhitelistTokens(address[] calldata tokens, bool[] calldata statuses) external onlyOwner {
        require(tokens.length == statuses.length, "Length mismatch");
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == address(0)) revert ZeroAddress();
            isWhitelistedToken[tokens[i]] = statuses[i];
            emit TokenWhitelistUpdated(tokens[i], statuses[i]);
        }
    }

    /// @notice Извлечение застрявших токенов (dust, partial execution)
    /// @param token Адрес токена для извлечения
    /// @param amount Количество (0 = весь баланс)
    function rescue(address token, uint256 amount) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 toSend = amount == 0 ? bal : amount;
        IERC20(token).safeTransfer(owner, toSend);
    }

    /// @notice Извлечение нативного MNT
    function rescueNative() external onlyOwner {
        (bool success,) = owner.call{value: address(this).balance}("");
        require(success, "Native transfer failed");
    }

    /// @notice Установить IdentityRegistry и привязать Agent ID
    /// @param _registry Адрес IdentityRegistry (ERC-8004)
    /// @dev agentId автоматически разрешается через agentOf[authorizedTeeAgent]
    function setIdentityRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert ZeroAddress();
        identityRegistry = IdentityRegistry(_registry);
        uint256 _agentId = identityRegistry.agentOf(authorizedTeeAgent);
        require(_agentId != 0, "TEE agent not registered in IdentityRegistry");
        agentId = _agentId;
        emit IdentityRegistryUpdated(_registry, _agentId);
    }

    /// @notice Установить ValidationRegistry (для совместимости с Deploy script)
    /// @param _registry Адрес ValidationRegistry
    function setValidationRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert ZeroAddress();
        // Store as generic — ValidationRegistry is referenced off-chain
        // No on-chain interaction needed from ActiveSentinel
    }

    // ═══════════════════════════════════════════════════════════════════
    //                      INTERNAL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Верификация EIP-712 подписи TEE-агента
    /// @param params Параметры арбитража с подписью
    function _verifyTeeSignature(ArbParams calldata params) internal view {
        bytes32 structHash = keccak256(abi.encode(
            ARB_TYPEHASH,
            params.tokenA,
            params.tokenB,
            params.borrowAmount,
            params.minProfitTokenA,
            params.nonce,
            params.reasoningHash
        ));
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, params.teeSignature);
        if (recovered != authorizedTeeAgent) revert InvalidTEESignature();
    }

    /// @notice Возвращает EIP-712 domain separator (для off-chain верификации)
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    receive() external payable {}
}
