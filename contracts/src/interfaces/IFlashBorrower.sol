// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IFlashBorrower - Callback interface for flash borrow recipients
interface IFlashBorrower {
    /// @notice Вызывается протоколом INIT Capital после передачи заимствованных токенов
    /// @param initiator Адрес инициатора flash borrow
    /// @param token Адрес заимствованного токена
    /// @param amount Количество заимствованных токенов
    /// @param fee Комиссия за flash borrow
    /// @param data Данные, переданные при инициации
    /// @return Магическое значение для подтверждения корректной обработки
    function onFlashBorrow(
        address initiator,
        address token,
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external returns (bytes32);
}
