// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {TransientReentrancyGuard} from "./libraries/TransientReentrancyGuard.sol";
import {IINITCore} from "./interfaces/IINITCore.sol";
import {IFlashBorrower} from "./interfaces/IFlashBorrower.sol";
import {IDexRouter} from "./interfaces/IDexRouter.sol";

/// @title ActiveSentinel - Core Execution Engine
/// @notice Атомарный флеш-арбитраж на Mantle Network (Merchant Moe / Agni Finance)
/// @dev Фаза 1 (MVP): прямые вызовы, CEI паттерн, transient reentrancy guard
contract ActiveSentinel is TransientReentrancyGuard, IFlashBorrower {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════
    //                          STORAGE
    // ═══════════════════════════════════════════════════════════════════

    address public immutable owner;
    address public immutable initCore;
    address public immutable dexRouterA; // Merchant Moe
    address public immutable dexRouterB; // Agni Finance

    // Magic return value для callback подтверждения
    bytes32 private constant CALLBACK_SUCCESS = keccak256("IFlashBorrower.onFlashBorrow");

    // ═══════════════════════════════════════════════════════════════════
    //                          ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error Unauthorized();
    error InvariantViolated(uint256 expectedMinProfit, uint256 actualProfit);
    error SwapFailed(uint8 routeIndex);
    error ZeroAmount();

    // ═══════════════════════════════════════════════════════════════════
    //                          EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event ArbitrageExecuted(
        address indexed tokenA,
        address indexed tokenB,
        uint256 borrowAmount,
        uint256 profit
    );

    // ═══════════════════════════════════════════════════════════════════
    //                          STRUCTS
    // ═══════════════════════════════════════════════════════════════════

    struct ArbParams {
        address tokenA;          // Базовый токен (borrow & profit token)
        address tokenB;          // Промежуточный токен
        uint256 borrowAmount;    // Количество tokenA для flash borrow
        uint256 minProfitTokenA; // Минимальный профит (рассчитан TEE off-chain)
        uint256 amountOutMinRoute1; // Slippage protection: route 1 (A -> B)
        uint256 amountOutMinRoute2; // Slippage protection: route 2 (B -> A)
        bytes dexPayloadRoute1;  // Merchant Moe: swap tokenA -> tokenB
        bytes dexPayloadRoute2;  // Agni Finance: swap tokenB -> tokenA
    }

    // ═══════════════════════════════════════════════════════════════════
    //                          CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(
        address _initCore,
        address _dexRouterA,
        address _dexRouterB
    ) {
        owner = msg.sender;
        initCore = _initCore;
        dexRouterA = _dexRouterA;
        dexRouterB = _dexRouterB;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                      EXTERNAL FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Точка входа для арбитражной операции
    /// @dev Вызывается owner (EOA или ZeroDev Kernel account)
    /// @param params Параметры арбитража, рассчитанные TEE-агентом
    function executeFlashArbitrage(ArbParams calldata params) external nonReentrant {
        // CHECKS
        if (msg.sender != owner) revert Unauthorized();
        if (params.borrowAmount == 0) revert ZeroAmount();

        uint256 balanceBefore = IERC20(params.tokenA).balanceOf(address(this));

        // EFFECTS + INTERACTIONS: Flash borrow инициирует callback
        IINITCore(initCore).flashBorrow(
            params.tokenA,
            params.borrowAmount,
            abi.encode(params)
        );

        // POST-INTERACTION CHECKS (invariant enforcement)
        uint256 balanceAfter = IERC20(params.tokenA).balanceOf(address(this));

        // Защита от underflow: если balanceAfter < balanceBefore — явный revert
        if (balanceAfter < balanceBefore) {
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
            actualProfit
        );
    }

    /// @notice Callback от INIT Capital после передачи flash borrow
    /// @dev Только initCore может вызвать. Выполняет двухшаговый swap и возврат.
    function onFlashBorrow(
        address initiator,
        address token,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external override returns (bytes32) {
        // Strict auth: только INIT Core, только мы как initiator
        if (msg.sender != initCore) revert Unauthorized();
        if (initiator != address(this)) revert Unauthorized();

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

    /// @notice Извлечение застрявших токенов (dust, partial execution)
    /// @param token Адрес токена для извлечения
    /// @param amount Количество (0 = весь баланс)
    function rescue(address token, uint256 amount) external {
        if (msg.sender != owner) revert Unauthorized();
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 toSend = amount == 0 ? bal : amount;
        IERC20(token).safeTransfer(owner, toSend);
    }

    /// @notice Извлечение нативного MNT
    function rescueNative() external {
        if (msg.sender != owner) revert Unauthorized();
        (bool success,) = owner.call{value: address(this).balance}("");
        require(success);
    }

    receive() external payable {}
}
