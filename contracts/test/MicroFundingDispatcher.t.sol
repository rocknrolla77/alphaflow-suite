// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {MicroFundingDispatcher} from "../src/MicroFundingDispatcher.sol";

/// @dev Mock target contract for testing dispatched calls
contract MockTarget {
    uint256 public lastValue;
    bytes public lastData;
    bool public shouldRevert;

    function doSomething(uint256 x) external payable returns (uint256) {
        if (shouldRevert) revert("MockTarget: forced revert");
        lastValue = x;
        lastData = msg.data;
        return x * 2;
    }

    function setShouldRevert(bool _val) external {
        shouldRevert = _val;
    }

    receive() external payable {}
}

contract MicroFundingDispatcherTest is Test {
    MicroFundingDispatcher public dispatcher;
    MockTarget public target;

    uint256 internal teePrivateKey = 0xA11CE;
    address internal teeSigner;
    address internal relayer = address(0xBEEF);
    address internal owner;

    bytes32 constant FORWARD_REQUEST_TYPEHASH = keccak256(
        "ForwardRequest(address target,bytes data,uint256 value,uint256 nonce,uint256 deadline)"
    );

    function setUp() public {
        teeSigner = vm.addr(teePrivateKey);
        owner = address(this);

        dispatcher = new MicroFundingDispatcher(teeSigner);
        target = new MockTarget();

        // Fund the dispatcher pool with 10 MNT
        vm.deal(address(dispatcher), 10 ether);
        // Fund relayer
        vm.deal(relayer, 1 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //                         HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    function _signRequest(
        MicroFundingDispatcher.ForwardRequest memory req
    ) internal view returns (bytes memory) {
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
        bytes32 digest = _getDigest(structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(teePrivateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _getDigest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                dispatcher.getDomainSeparator(),
                structHash
            )
        );
    }

    function _buildRequest(
        uint256 value,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (MicroFundingDispatcher.ForwardRequest memory) {
        return MicroFundingDispatcher.ForwardRequest({
            target: address(target),
            data: abi.encodeWithSelector(MockTarget.doSomething.selector, 42),
            value: value,
            nonce: nonce,
            deadline: deadline
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //                         CORE TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_executeValidatedCall_success() public {
        MicroFundingDispatcher.ForwardRequest memory req = _buildRequest(0, 0, block.timestamp + 1 hours);
        bytes memory sig = _signRequest(req);

        uint256 relayerBalBefore = relayer.balance;

        vm.txGasPrice(50 gwei); // Set non-zero gas price for refund calculation
        vm.prank(relayer);
        bytes memory result = dispatcher.executeValidatedCall(req, sig);

        // Target was called correctly
        assertEq(target.lastValue(), 42);
        // Nonce incremented
        assertEq(dispatcher.nonces(address(target)), 1);
        // Result decoded
        uint256 decoded = abi.decode(result, (uint256));
        assertEq(decoded, 84); // 42 * 2
        // Relayer got refund (gasPrice > 0 so refund > 0)
        assertGt(relayer.balance, relayerBalBefore);
    }

    function test_executeValidatedCall_withValue() public {
        uint256 sendValue = 0.5 ether;
        MicroFundingDispatcher.ForwardRequest memory req = _buildRequest(sendValue, 0, block.timestamp + 1 hours);
        bytes memory sig = _signRequest(req);

        // Fund dispatcher extra for the value transfer
        vm.deal(address(dispatcher), 10 ether + sendValue);

        vm.prank(relayer);
        dispatcher.executeValidatedCall(req, sig);

        assertEq(address(target).balance, sendValue);
        assertEq(target.lastValue(), 42);
    }

    function test_revert_deadlineExpired() public {
        MicroFundingDispatcher.ForwardRequest memory req = _buildRequest(0, 0, block.timestamp - 1);
        bytes memory sig = _signRequest(req);

        vm.prank(relayer);
        vm.expectRevert(MicroFundingDispatcher.DeadlineExpired.selector);
        dispatcher.executeValidatedCall(req, sig);
    }

    function test_revert_invalidNonce() public {
        MicroFundingDispatcher.ForwardRequest memory req = _buildRequest(0, 999, block.timestamp + 1 hours);
        bytes memory sig = _signRequest(req);

        vm.prank(relayer);
        vm.expectRevert(MicroFundingDispatcher.InvalidNonce.selector);
        dispatcher.executeValidatedCall(req, sig);
    }

    function test_revert_invalidSignature() public {
        MicroFundingDispatcher.ForwardRequest memory req = _buildRequest(0, 0, block.timestamp + 1 hours);

        // Sign with wrong key
        uint256 wrongKey = 0xBAD;
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
        bytes32 digest = _getDigest(structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongKey, digest);
        bytes memory badSig = abi.encodePacked(r, s, v);

        vm.prank(relayer);
        vm.expectRevert(MicroFundingDispatcher.InvalidTEESignature.selector);
        dispatcher.executeValidatedCall(req, badSig);
    }

    function test_revert_targetCallFailed() public {
        target.setShouldRevert(true);

        MicroFundingDispatcher.ForwardRequest memory req = _buildRequest(0, 0, block.timestamp + 1 hours);
        bytes memory sig = _signRequest(req);

        vm.prank(relayer);
        vm.expectRevert();
        dispatcher.executeValidatedCall(req, sig);
    }

    function test_gracefulDegradation_emptyPool() public {
        // Drain the pool
        vm.deal(address(dispatcher), 0);

        MicroFundingDispatcher.ForwardRequest memory req = _buildRequest(0, 0, block.timestamp + 1 hours);
        bytes memory sig = _signRequest(req);

        uint256 relayerBalBefore = relayer.balance;

        vm.prank(relayer);
        // Should NOT revert even with empty pool
        dispatcher.executeValidatedCall(req, sig);

        // Target was called
        assertEq(target.lastValue(), 42);
        // Nonce incremented
        assertEq(dispatcher.nonces(address(target)), 1);
        // Relayer balance unchanged (no refund)
        assertEq(relayer.balance, relayerBalBefore);
    }

    function test_nonceIncrement_sequential() public {
        for (uint256 i = 0; i < 5; i++) {
            MicroFundingDispatcher.ForwardRequest memory req = _buildRequest(0, i, block.timestamp + 1 hours);
            bytes memory sig = _signRequest(req);

            vm.prank(relayer);
            dispatcher.executeValidatedCall(req, sig);
        }

        assertEq(dispatcher.nonces(address(target)), 5);
    }

    function test_replayProtection() public {
        MicroFundingDispatcher.ForwardRequest memory req = _buildRequest(0, 0, block.timestamp + 1 hours);
        bytes memory sig = _signRequest(req);

        // First call succeeds
        vm.prank(relayer);
        dispatcher.executeValidatedCall(req, sig);

        // Second call with same nonce reverts
        vm.prank(relayer);
        vm.expectRevert(MicroFundingDispatcher.InvalidNonce.selector);
        dispatcher.executeValidatedCall(req, sig);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //                         ADMIN TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_setTeeSigner() public {
        address newSigner = address(0x1234);
        dispatcher.setTeeSigner(newSigner);
        assertEq(dispatcher.teeSigner(), newSigner);
    }

    function test_setTeeSigner_onlyOwner() public {
        vm.prank(relayer);
        vm.expectRevert(MicroFundingDispatcher.OnlyOwner.selector);
        dispatcher.setTeeSigner(address(0x1234));
    }

    function test_setTeeSigner_zeroAddress() public {
        vm.expectRevert(MicroFundingDispatcher.ZeroAddress.selector);
        dispatcher.setTeeSigner(address(0));
    }

    function test_withdraw() public {
        uint256 balBefore = address(this).balance;
        dispatcher.withdraw(1 ether);
        assertEq(address(this).balance, balBefore + 1 ether);
    }

    function test_withdraw_onlyOwner() public {
        vm.prank(relayer);
        vm.expectRevert(MicroFundingDispatcher.OnlyOwner.selector);
        dispatcher.withdraw(1 ether);
    }

    function test_withdraw_insufficientBalance() public {
        vm.expectRevert(MicroFundingDispatcher.InsufficientBalance.selector);
        dispatcher.withdraw(999 ether);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //                         VIEW TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_getPoolBalance() public view {
        assertEq(dispatcher.getPoolBalance(), 10 ether);
    }

    function test_getNonce() public view {
        assertEq(dispatcher.getNonce(address(target)), 0);
    }

    function test_getDomainSeparator_nonZero() public view {
        assertNotEq(dispatcher.getDomainSeparator(), bytes32(0));
    }

    function test_constructor_zeroAddress() public {
        vm.expectRevert(MicroFundingDispatcher.ZeroAddress.selector);
        new MicroFundingDispatcher(address(0));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //                         FUZZ TESTS
    // ═══════════════════════════════════════════════════════════════════════════

    function testFuzz_executeWithDifferentValues(uint256 value) public {
        value = bound(value, 0, 1 ether);

        vm.deal(address(dispatcher), 10 ether + value);

        MicroFundingDispatcher.ForwardRequest memory req = _buildRequest(value, 0, block.timestamp + 1 hours);
        bytes memory sig = _signRequest(req);

        vm.prank(relayer);
        dispatcher.executeValidatedCall(req, sig);

        assertEq(address(target).balance, value);
    }

    function testFuzz_deadlineEnforcement(uint256 elapsed) public {
        elapsed = bound(elapsed, 1, 365 days);
        uint256 deadline = block.timestamp + 1;
        vm.warp(block.timestamp + elapsed + 1);

        MicroFundingDispatcher.ForwardRequest memory req = _buildRequest(0, 0, deadline);
        bytes memory sig = _signRequest(req);

        vm.prank(relayer);
        vm.expectRevert(MicroFundingDispatcher.DeadlineExpired.selector);
        dispatcher.executeValidatedCall(req, sig);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //                         RECEIVE (for withdraw)
    // ═══════════════════════════════════════════════════════════════════════════

    receive() external payable {}
}
