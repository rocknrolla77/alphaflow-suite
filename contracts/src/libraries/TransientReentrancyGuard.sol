// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TransientReentrancyGuard
/// @notice Газ-эффективная защита от reentrancy на базе EIP-1153 (Transient Storage)
/// @dev Требует EVM версии cancun+ и Solidity >= 0.8.24
abstract contract TransientReentrancyGuard {
    // Уникальный слот: keccak256("alphaflow.sentinel.reentrancy.lock") - 1
    bytes32 private constant _LOCK_SLOT = 0x8b1a944cf13a9a1c08facb1f3de33a0e0c40e06ee15c5e8a12ef28645c0d69a5;

    error ReentrancyAttempt();

    modifier nonReentrant() {
        assembly {
            if tload(_LOCK_SLOT) {
                // ReentrancyAttempt() selector = keccak256("ReentrancyAttempt()")[:4]
                mstore(0x00, 0x01336cea00000000000000000000000000000000000000000000000000000000)
                revert(0x00, 0x04)
            }
            tstore(_LOCK_SLOT, 1)
        }
        _;
        assembly {
            tstore(_LOCK_SLOT, 0)
        }
    }
}
