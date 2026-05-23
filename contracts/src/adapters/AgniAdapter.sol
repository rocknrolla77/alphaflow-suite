// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IDexRouter} from "../interfaces/IDexRouter.sol";

/// @title IAgniSwapRouter — Interface для Agni Finance SwapRouter (UniV3 fork) на Mantle
/// @dev Agni — форк Uniswap V3 на Mantle Network
interface IAgniSwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Swap exact input (single hop) через Agni Finance concentrated liquidity pool
    /// @param params Параметры свопа
    /// @return amountOut Количество полученных tokenOut
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

/// @title AgniAdapter — IDexRouter adapter для Agni Finance (UniV3-style)
/// @notice Обёртка над exactInputSingle с unified IDexRouter интерфейсом
/// @dev Payload encoding: abi.encode(uint24 fee, uint256 deadline, uint160 sqrtPriceLimitX96)
///      fee: pool fee tier (500 = 0.05%, 3000 = 0.3%, 10000 = 1%)
///      deadline == 0 → block.timestamp + 300
///      sqrtPriceLimitX96 == 0 → без price limit (любой tick)
///
/// SECURITY:
///   - Токены approval делается вызывающим контрактом (ActiveSentinel)
///   - Адаптер НЕ хранит токены — все средства проходят транзитом
///   - Router address immutable — нельзя подменить после деплоя
///   - amountOutMinimum проверяется роутером на уровне pool
contract AgniAdapter is IDexRouter {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════
    //                          ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error ZeroAddress();
    error SwapReturnedZero();

    // ═══════════════════════════════════════════════════════════════════
    //                          STORAGE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Адрес Agni Finance SwapRouter (immutable)
    address public immutable router;

    /// @notice Дефолтный deadline offset (5 минут)
    uint256 private constant DEFAULT_DEADLINE_OFFSET = 300;

    // ═══════════════════════════════════════════════════════════════════
    //                          CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    /// @param _router Адрес Agni Finance SwapRouter на Mantle
    constructor(address _router) {
        if (_router == address(0)) revert ZeroAddress();
        router = _router;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                      IDexRouter IMPLEMENTATION
    // ═══════════════════════════════════════════════════════════════════

    /// @inheritdoc IDexRouter
    /// @dev Payload format: abi.encode(uint24 fee, uint256 deadline, uint160 sqrtPriceLimitX96)
    ///      fee: обязательный параметр (определяет pool)
    ///      deadline == 0 → block.timestamp + 300
    ///      sqrtPriceLimitX96 == 0 → без ограничения цены (swap по рынку)
    ///
    /// FLOW:
    ///   1. Decode payload → (fee, deadline, sqrtPriceLimitX96)
    ///   2. TransferFrom caller → this adapter
    ///   3. Approve router
    ///   4. Execute exactInputSingle
    ///   5. Transfer output to caller (msg.sender = ActiveSentinel)
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        bytes calldata payload
    ) external override returns (uint256 amountOut) {
        // ─── Decode payload ──────────────────────────────────────────────
        (uint24 fee, uint256 deadline, uint160 sqrtPriceLimitX96) =
            abi.decode(payload, (uint24, uint256, uint160));

        // ─── Default deadline ────────────────────────────────────────────
        if (deadline == 0) {
            deadline = block.timestamp + DEFAULT_DEADLINE_OFFSET;
        }

        // ─── Pull tokens from caller (ActiveSentinel) ────────────────────
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        // ─── Approve router ──────────────────────────────────────────────
        IERC20(tokenIn).forceApprove(router, amountIn);

        // ─── Execute exactInputSingle ────────────────────────────────────
        amountOut = IAgniSwapRouter(router).exactInputSingle(
            IAgniSwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this), // Receive here first
                deadline: deadline,
                amountIn: amountIn,
                amountOutMinimum: amountOutMin,
                sqrtPriceLimitX96: sqrtPriceLimitX96
            })
        );

        if (amountOut == 0) revert SwapReturnedZero();

        // ─── Transfer output back to caller ──────────────────────────────
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
    }
}
