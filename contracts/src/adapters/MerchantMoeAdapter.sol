// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IDexRouter} from "../interfaces/IDexRouter.sol";

/// @title IMerchantMoeRouter — Interface для Merchant Moe Router (LBRouter) на Mantle
/// @dev Merchant Moe использует модифицированный UniV2 интерфейс с bin-based liquidity
interface IMerchantMoeRouter {
    /// @notice Swap exact tokens for tokens через Merchant Moe LB pools
    /// @param amountIn Количество входных токенов
    /// @param amountOutMin Минимальное количество выходных токенов
    /// @param path Массив адресов токенов (маршрут свопа)
    /// @param to Адрес получателя
    /// @param deadline Дедлайн транзакции (unix timestamp)
    /// @return amounts Массив количеств на каждом шаге маршрута
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/// @title MerchantMoeAdapter — IDexRouter adapter для Merchant Moe (LBRouter)
/// @notice Обёртка над swapExactTokensForTokens с unified IDexRouter интерфейсом
/// @dev Payload encoding: abi.encode(address[] path, uint256 deadline)
///      Если deadline == 0 → используется block.timestamp + 300 (5 min)
///
/// SECURITY:
///   - Токены approval делается вызывающим контрактом (ActiveSentinel)
///   - Адаптер НЕ хранит токены — все средства проходят транзитом
///   - Router address immutable — нельзя подменить после деплоя
///   - amountOutMin проверяется роутером (revert если slippage превышен)
contract MerchantMoeAdapter is IDexRouter {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════
    //                          ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error ZeroAddress();
    error InvalidPath();
    error PathMismatch();
    error SwapReturnedZero();

    // ═══════════════════════════════════════════════════════════════════
    //                          STORAGE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Адрес Merchant Moe LBRouter (immutable)
    address public immutable router;

    /// @notice Дефолтный deadline offset (5 минут)
    uint256 private constant DEFAULT_DEADLINE_OFFSET = 300;

    // ═══════════════════════════════════════════════════════════════════
    //                          CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    /// @param _router Адрес Merchant Moe LBRouter на Mantle
    constructor(address _router) {
        if (_router == address(0)) revert ZeroAddress();
        router = _router;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                      IDexRouter IMPLEMENTATION
    // ═══════════════════════════════════════════════════════════════════

    /// @inheritdoc IDexRouter
    /// @dev Payload format: abi.encode(address[] path, uint256 deadline)
    ///      path[0] ДОЛЖЕН == tokenIn, path[last] ДОЛЖЕН == tokenOut
    ///      deadline == 0 → block.timestamp + 300
    ///
    /// FLOW:
    ///   1. Decode payload → (path, deadline)
    ///   2. Validate path endpoints match tokenIn/tokenOut
    ///   3. TransferFrom caller → this adapter
    ///   4. Approve router
    ///   5. Execute swapExactTokensForTokens
    ///   6. Transfer output to caller (msg.sender = ActiveSentinel)
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        bytes calldata payload
    ) external override returns (uint256 amountOut) {
        // ─── Decode payload ──────────────────────────────────────────────
        (address[] memory path, uint256 deadline) = abi.decode(payload, (address[], uint256));

        // ─── Validations ─────────────────────────────────────────────────
        if (path.length < 2) revert InvalidPath();
        if (path[0] != tokenIn || path[path.length - 1] != tokenOut) revert PathMismatch();

        // ─── Default deadline ────────────────────────────────────────────
        if (deadline == 0) {
            deadline = block.timestamp + DEFAULT_DEADLINE_OFFSET;
        }

        // ─── Pull tokens from caller (ActiveSentinel) ────────────────────
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        // ─── Approve router ──────────────────────────────────────────────
        IERC20(tokenIn).forceApprove(router, amountIn);

        // ─── Execute swap ────────────────────────────────────────────────
        uint256[] memory amounts = IMerchantMoeRouter(router).swapExactTokensForTokens(
            amountIn,
            amountOutMin,
            path,
            address(this),  // Receive here first
            deadline
        );

        amountOut = amounts[amounts.length - 1];
        if (amountOut == 0) revert SwapReturnedZero();

        // ─── Transfer output back to caller ──────────────────────────────
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
    }
}
