// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IDexRouter - Unified interface for DEX swap execution
/// @notice Абстракция над Merchant Moe и Agni Finance роутерами
interface IDexRouter {
    /// @notice Выполняет swap по заданному payload
    /// @param tokenIn Входной токен
    /// @param tokenOut Выходной токен
    /// @param amountIn Количество входных токенов
    /// @param amountOutMin Минимальное количество выходных токенов (slippage protection)
    /// @param payload DEX-специфичные данные маршрутизации (path, pools, fees)
    /// @return amountOut Фактическое количество полученных токенов
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        bytes calldata payload
    ) external returns (uint256 amountOut);
}
