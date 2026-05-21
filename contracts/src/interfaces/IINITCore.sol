// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IINITCore - Interface for INIT Capital flash borrow
/// @notice Минимальный интерфейс для flash borrow через INIT Capital на Mantle
interface IINITCore {
    /// @notice Инициирует flash borrow
    /// @param token Адрес заимствуемого токена
    /// @param amount Количество токенов
    /// @param data Произвольные данные, передаваемые в callback
    function flashBorrow(address token, uint256 amount, bytes calldata data) external;
}
