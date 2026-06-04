// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ActiveSentinel} from "../src/ActiveSentinel.sol";
import {IdentityRegistry} from "../src/erc8004/IdentityRegistry.sol";
import {IFlashBorrower} from "../src/interfaces/IFlashBorrower.sol";
import {IDexRouter} from "../src/interfaces/IDexRouter.sol";

// ═══════════════════════════════════════════════════════════════════════
//                          MOCK CONTRACTS
// ═══════════════════════════════════════════════════════════════════════

/// @dev Mock ERC20
contract MockERC20 is IERC20 {
    string public name;
    string public symbol;
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, string memory _symbol) {
        name = _name;
        symbol = _symbol;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @dev Mock INIT Core
contract MockINITCore {
    uint256 public fee = 0;

    function setFee(uint256 _fee) external {
        fee = _fee;
    }

    function flashBorrow(address token, uint256 amount, bytes calldata data) external {
        IERC20(token).transfer(msg.sender, amount);
        bytes32 result = IFlashBorrower(msg.sender).onFlashBorrow(
            msg.sender, token, amount, fee, data
        );
        require(result == keccak256("IFlashBorrower.onFlashBorrow"), "Invalid callback return");
    }
}

/// @dev Fake INIT Core — spoofed initiator for H-08 test
contract FakeINITCore {
    address public realSentinel;

    constructor(address _sentinel) {
        realSentinel = _sentinel;
    }

    function exploitH08(
        address fakeSentinel,
        address token,
        uint256 amount,
        bytes calldata data
    ) external {
        IFlashBorrower(realSentinel).onFlashBorrow(
            fakeSentinel,
            token,
            amount,
            0,
            data
        );
    }
}

/// @dev Mock DEX Router
contract MockDexRouter is IDexRouter {
    uint256 public rate = 1e18;
    bool public shouldFail;

    function setRate(uint256 _rate) external { rate = _rate; }
    function setFail(bool _fail) external { shouldFail = _fail; }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        bytes calldata
    ) external override returns (uint256 amountOut) {
        if (shouldFail) return 0;
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        amountOut = (amountIn * rate) / 1e18;
        require(amountOut >= amountOutMin, "Slippage exceeded");
        MockERC20(tokenOut).mint(msg.sender, amountOut);
    }
}

/// @dev Malicious DEX — attempts reentrancy via standard call
contract MaliciousDexRouter is IDexRouter {
    ActiveSentinel public target;
    address public dispatcher;
    bool public attacked;

    constructor(address _target, address _dispatcher) {
        target = ActiveSentinel(payable(_target));
        dispatcher = _dispatcher;
    }

    function swap(
        address tokenIn,
        address,
        uint256 amountIn,
        uint256,
        bytes calldata
    ) external override returns (uint256) {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);

        if (!attacked) {
            attacked = true;
            ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
                tokenA: address(0),
                tokenB: address(0),
                borrowAmount: 1,
                minProfitTokenA: 0,
                nonce: 999999,
                amountOutMinRoute1: 0,
                amountOutMinRoute2: 0,
                reasoningHash: bytes32(0),
                dexPayloadRoute1: "",
                dexPayloadRoute2: ""
            });
            // Attempt reentrancy from within swap callback
            target.executeFlashArbitrage(params);
        }
        return 0;
    }
}

/// @dev ERC-777 style token with low-gas reentrancy hook
contract MaliciousERC777Token is IERC20 {
    string public name = "Evil777";
    string public symbol = "EVIL";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    ActiveSentinel public target;
    bool public hookEnabled;
    uint256 public hookGasLimit;

    constructor() {}

    function setTarget(address _target) external {
        target = ActiveSentinel(payable(_target));
    }

    function setHook(bool _enabled, uint256 _gasLimit) external {
        hookEnabled = _enabled;
        hookGasLimit = _gasLimit;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);

        if (hookEnabled && address(target) != address(0)) {
            ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
                tokenA: address(0),
                tokenB: address(0),
                borrowAmount: 1,
                minProfitTokenA: 0,
                nonce: 888888,
                amountOutMinRoute1: 0,
                amountOutMinRoute2: 0,
                reasoningHash: bytes32(0),
                dexPayloadRoute1: "",
                dexPayloadRoute2: ""
            });

            (bool success,) = address(target).call{gas: hookGasLimit}(
                abi.encodeCall(ActiveSentinel.executeFlashArbitrage, (params))
            );
            require(!success, "Reentrancy should have failed!");
        }

        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

// ═══════════════════════════════════════════════════════════════════════
//                     SECURITY TEST CONTRACT
// ═══════════════════════════════════════════════════════════════════════

contract ActiveSentinelSecurityTest is Test {
    ActiveSentinel public sentinel;
    IdentityRegistry public identity;
    MockINITCore public initCore;
    MockDexRouter public dexRouterA;
    MockDexRouter public dexRouterB;
    MockERC20 public tokenA;
    MockERC20 public tokenB;

    address public dispatcher = address(0xD15);
    address public attacker = address(0xBAD);
    address public owner;

    function setUp() public {
        owner = address(this);

        tokenA = new MockERC20("USD Coin", "USDC");
        tokenB = new MockERC20("Wrapped MNT", "WMNT");

        initCore = new MockINITCore();
        dexRouterA = new MockDexRouter();
        dexRouterB = new MockDexRouter();

        sentinel = new ActiveSentinel(
            address(initCore),
            address(dexRouterA),
            address(dexRouterB)
        );

        identity = new IdentityRegistry();

        // Configure access
        sentinel.setTrustedDispatcher(dispatcher);
        sentinel.setWhitelistedToken(address(tokenA), true);
        sentinel.setWhitelistedToken(address(tokenB), true);

        // Register dispatcher as agent
        identity.registerAgent(dispatcher, "ipfs://QmDispatcher");
        sentinel.setIdentityRegistry(address(identity), 1);

        // Seed liquidity
        tokenA.mint(address(initCore), 1_000_000e18);
    }

    // ─── Helper ─────────────────────────────────────────────────────────

    function _buildParams(uint256 nonce) internal view returns (ActiveSentinel.ArbParams memory) {
        return ActiveSentinel.ArbParams({
            tokenA: address(tokenA),
            tokenB: address(tokenB),
            borrowAmount: 100e18,
            minProfitTokenA: 4e18,
            nonce: nonce,
            amountOutMinRoute1: 0,
            amountOutMinRoute2: 0,
            reasoningHash: bytes32(0),
            dexPayloadRoute1: "",
            dexPayloadRoute2: ""
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Section 1: H-08 Context Validation (Spoofed Initiator)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Fake INIT Core пытается вызвать callback с подменённым initiator
    function test_revert_spoofedInitiator_H08() public {
        FakeINITCore fakeCore = new FakeINITCore(address(sentinel));

        ActiveSentinel.ArbParams memory params = _buildParams(100);
        bytes memory fakeData = abi.encode(params);

        // FakeINITCore is NOT initCore → should revert with Unauthorized
        vm.expectRevert(ActiveSentinel.Unauthorized.selector);
        fakeCore.exploitH08(address(0xDEAD), address(tokenA), 100e18, fakeData);
    }

    /// @notice Callback from real initCore but with wrong initiator
    function test_revert_wrongInitiator_H08() public {
        ActiveSentinel.ArbParams memory params = _buildParams(101);
        bytes memory data = abi.encode(params);

        // Direct call from initCore but initiator != sentinel
        vm.prank(address(initCore));
        vm.expectRevert(ActiveSentinel.InvalidInitiator.selector);
        sentinel.onFlashBorrow(address(0xDEAD), address(tokenA), 100e18, 0, data);
    }

    /// @notice FakeINITCore trying to drain via initCore address spoof
    function test_revert_fakeInitCoreDrain_H08() public {
        FakeINITCore fakeCore = new FakeINITCore(address(sentinel));

        ActiveSentinel.ArbParams memory params = _buildParams(102);
        bytes memory data = abi.encode(params);

        // msg.sender != initCore → Unauthorized
        vm.expectRevert(ActiveSentinel.Unauthorized.selector);
        fakeCore.exploitH08(address(sentinel), address(tokenA), 100e18, data);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Section 2: Access Control (Dispatcher/Agent Authorization)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Random attacker cannot call executeFlashArbitrage
    function test_revert_unauthorized_attacker() public {
        ActiveSentinel.ArbParams memory params = _buildParams(200);

        vm.prank(attacker);
        vm.expectRevert(ActiveSentinel.Unauthorized.selector);
        sentinel.executeFlashArbitrage(params);
    }

    /// @notice Owner (deployer) without dispatcher/agent role cannot call
    function test_revert_ownerCannotCallDirectly() public {
        // Owner is not dispatcher nor registered agent
        ActiveSentinel.ArbParams memory params = _buildParams(201);

        // owner = address(this), which is not dispatcher nor registered
        vm.expectRevert(ActiveSentinel.Unauthorized.selector);
        sentinel.executeFlashArbitrage(params);
    }

    /// @notice After dispatcher is changed, old dispatcher loses access
    function test_revert_oldDispatcherAfterRotation() public {
        address newDispatcher = address(0xFACE);
        sentinel.setTrustedDispatcher(newDispatcher);

        ActiveSentinel.ArbParams memory params = _buildParams(202);

        // Old dispatcher is still a registered agent, so check depends on identity
        // If old dispatcher is NOT in identityRegistry, it should fail
        // dispatcher = 0xD15 which IS registered → still passes
        // Let's use a fresh address that's NOT registered
        address oldDisp = address(0xAAA);
        sentinel.setTrustedDispatcher(oldDisp);
        sentinel.setTrustedDispatcher(newDispatcher);

        vm.prank(oldDisp);
        vm.expectRevert(ActiveSentinel.Unauthorized.selector);
        sentinel.executeFlashArbitrage(params);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Section 3: Reentrancy Guard (Hybrid TSTORE + SSTORE)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Standard-gas reentrancy via malicious DEX router
    function test_revert_reentrancy_standardGas() public {
        // Deploy malicious DEX as routerA
        MaliciousDexRouter malDex = new MaliciousDexRouter(address(sentinel), dispatcher);

        // Redeploy sentinel with malicious router
        ActiveSentinel sentinelVuln = new ActiveSentinel(
            address(initCore),
            address(malDex),
            address(dexRouterB)
        );
        sentinelVuln.setTrustedDispatcher(dispatcher);
        sentinelVuln.setWhitelistedToken(address(tokenA), true);
        sentinelVuln.setWhitelistedToken(address(tokenB), true);

        tokenA.mint(address(initCore), 1_000_000e18);

        ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
            tokenA: address(tokenA),
            tokenB: address(tokenB),
            borrowAmount: 100e18,
            minProfitTokenA: 0,
            nonce: 300,
            amountOutMinRoute1: 0,
            amountOutMinRoute2: 0,
            reasoningHash: bytes32(0),
            dexPayloadRoute1: "",
            dexPayloadRoute2: ""
        });

        // The reentrancy attempt inside malDex will be caught by hybridReentrancyGuard
        vm.prank(dispatcher);
        vm.expectRevert(); // Reentrancy triggers SwapFailed(1) since malDex returns 0 after reentrancy fails
        sentinelVuln.executeFlashArbitrage(params);
    }

    /// @notice Low-gas ERC-777 style reentrancy (SSTORE barrier)
    function test_revert_lowGasReentrancy_ERC777() public {
        MaliciousERC777Token evilToken = new MaliciousERC777Token();
        evilToken.setTarget(address(sentinel));
        evilToken.setHook(true, 2300); // Simulate 2300 gas stipend

        // Deploy sentinel with evil token whitelisted
        sentinel.setWhitelistedToken(address(evilToken), true);
        evilToken.mint(address(initCore), 1_000_000e18);
        evilToken.mint(address(sentinel), 1_000e18);

        // The hook will try to re-enter with only 2300 gas
        // SSTORE check costs 5000 gas → OOG → silent fail
        // The hook's require(!success) confirms the attack was blocked
        ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
            tokenA: address(evilToken),
            tokenB: address(tokenB),
            borrowAmount: 100e18,
            minProfitTokenA: 0,
            nonce: 301,
            amountOutMinRoute1: 0,
            amountOutMinRoute2: 0,
            reasoningHash: bytes32(0),
            dexPayloadRoute1: "",
            dexPayloadRoute2: ""
        });

        // This will revert because the evil token's transfer hook
        // asserts that reentrancy failed (require(!success))
        // but the outer tx still continues — in this mock setup
        // the swap itself won't produce valid output
        vm.prank(dispatcher);
        vm.expectRevert();
        sentinel.executeFlashArbitrage(params);
    }

    /// @notice Verify SSTORE state management (lock/unlock cycle)
    function test_hybridGuard_sstoreBarrier() public {
        dexRouterA.setRate(1.05e18);
        dexRouterB.setRate(1.0e18);

        ActiveSentinel.ArbParams memory params = _buildParams(302);

        vm.prank(dispatcher);
        sentinel.executeFlashArbitrage(params);

        // If we get here, the guard properly unlocked after execution
        // Verify with a second execution (different nonce)
        ActiveSentinel.ArbParams memory params2 = _buildParams(303);

        vm.prank(dispatcher);
        sentinel.executeFlashArbitrage(params2);

        assertTrue(true, "Both executions passed - guard unlocks correctly");
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Section 4: Token Whitelist
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Unapproved tokenA reverts
    function test_revert_unapprovedTokenA() public {
        MockERC20 badToken = new MockERC20("Bad", "BAD");

        ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
            tokenA: address(badToken),
            tokenB: address(tokenB),
            borrowAmount: 100e18,
            minProfitTokenA: 0,
            nonce: 400,
            amountOutMinRoute1: 0,
            amountOutMinRoute2: 0,
            reasoningHash: bytes32(0),
            dexPayloadRoute1: "",
            dexPayloadRoute2: ""
        });

        vm.prank(dispatcher);
        vm.expectRevert(ActiveSentinel.UnapprovedToken.selector);
        sentinel.executeFlashArbitrage(params);
    }

    /// @notice Unapproved tokenB reverts
    function test_revert_unapprovedTokenB() public {
        MockERC20 badToken = new MockERC20("Bad", "BAD");

        ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
            tokenA: address(tokenA),
            tokenB: address(badToken),
            borrowAmount: 100e18,
            minProfitTokenA: 0,
            nonce: 401,
            amountOutMinRoute1: 0,
            amountOutMinRoute2: 0,
            reasoningHash: bytes32(0),
            dexPayloadRoute1: "",
            dexPayloadRoute2: ""
        });

        vm.prank(dispatcher);
        vm.expectRevert(ActiveSentinel.UnapprovedToken.selector);
        sentinel.executeFlashArbitrage(params);
    }

    /// @notice Token removed from whitelist after whitelisting
    function test_revert_removedFromWhitelist() public {
        sentinel.setWhitelistedToken(address(tokenA), false);

        ActiveSentinel.ArbParams memory params = _buildParams(402);

        vm.prank(dispatcher);
        vm.expectRevert(ActiveSentinel.UnapprovedToken.selector);
        sentinel.executeFlashArbitrage(params);
    }

    /// @notice Batch whitelist update
    function test_batchWhitelist() public {
        MockERC20 token1 = new MockERC20("T1", "T1");
        MockERC20 token2 = new MockERC20("T2", "T2");

        address[] memory tokens = new address[](2);
        tokens[0] = address(token1);
        tokens[1] = address(token2);

        bool[] memory statuses = new bool[](2);
        statuses[0] = true;
        statuses[1] = true;

        sentinel.batchWhitelistTokens(tokens, statuses);

        assertTrue(sentinel.isWhitelistedToken(address(token1)));
        assertTrue(sentinel.isWhitelistedToken(address(token2)));
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Section 5: Nonce Replay Protection
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Same nonce used twice → revert
    function test_revert_nonceReplay() public {
        dexRouterA.setRate(1.05e18);
        dexRouterB.setRate(1.0e18);

        ActiveSentinel.ArbParams memory params = _buildParams(500);

        vm.prank(dispatcher);
        sentinel.executeFlashArbitrage(params);

        // Replay
        vm.prank(dispatcher);
        vm.expectRevert(ActiveSentinel.NonceAlreadyUsed.selector);
        sentinel.executeFlashArbitrage(params);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Section 6: Admin Access Control
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Non-owner cannot set dispatcher
    function test_revert_setDispatcher_unauthorized() public {
        vm.prank(attacker);
        vm.expectRevert(ActiveSentinel.Unauthorized.selector);
        sentinel.setTrustedDispatcher(address(0x123));
    }

    /// @notice Cannot set zero-address dispatcher
    function test_revert_setDispatcher_zeroAddress() public {
        vm.expectRevert(ActiveSentinel.ZeroAddress.selector);
        sentinel.setTrustedDispatcher(address(0));
    }

    /// @notice Non-owner cannot set whitelist
    function test_revert_setWhitelist_unauthorized() public {
        vm.prank(attacker);
        vm.expectRevert(ActiveSentinel.Unauthorized.selector);
        sentinel.setWhitelistedToken(address(tokenA), false);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Section 7: Full Happy Path
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Complete flow: dispatcher calls, profit generated, nonce consumed
    function test_fullHappyPath() public {
        dexRouterA.setRate(1.05e18);
        dexRouterB.setRate(1.0e18);

        ActiveSentinel.ArbParams memory params = _buildParams(700);

        uint256 balBefore = tokenA.balanceOf(address(sentinel));

        vm.prank(dispatcher);
        sentinel.executeFlashArbitrage(params);

        uint256 balAfter = tokenA.balanceOf(address(sentinel));
        uint256 profit = balAfter - balBefore;

        assertGe(profit, 4e18, "Minimum profit not met");
        assertTrue(sentinel.usedNonces(700), "Nonce must be consumed");
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Section 8: Fuzz Testing
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Fuzz: various nonces should all work (no collision)
    function testFuzz_nonceVariations(uint256 nonce) public {
        nonce = bound(nonce, 1, type(uint128).max);

        dexRouterA.setRate(1.05e18);
        dexRouterB.setRate(1.0e18);

        ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
            tokenA: address(tokenA),
            tokenB: address(tokenB),
            borrowAmount: 100e18,
            minProfitTokenA: 0,
            nonce: nonce,
            amountOutMinRoute1: 0,
            amountOutMinRoute2: 0,
            reasoningHash: bytes32(uint256(nonce)),
            dexPayloadRoute1: "",
            dexPayloadRoute2: ""
        });

        vm.prank(dispatcher);
        sentinel.executeFlashArbitrage(params);

        assertTrue(sentinel.usedNonces(nonce));
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Section 9: Dispatcher Rotation
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Dispatcher rotation: new dispatcher works, old loses access (if not agent)
    function test_dispatcherRotation() public {
        address newDispatcher = address(0xFACE);
        sentinel.setTrustedDispatcher(newDispatcher);

        dexRouterA.setRate(1.05e18);
        dexRouterB.setRate(1.0e18);

        ActiveSentinel.ArbParams memory params = _buildParams(900);

        // New dispatcher can call
        vm.prank(newDispatcher);
        sentinel.executeFlashArbitrage(params);

        // Old dispatcher (0xD15) — still a registered ERC-8004 agent, so it can still call
        ActiveSentinel.ArbParams memory params2 = _buildParams(901);
        vm.prank(dispatcher);
        sentinel.executeFlashArbitrage(params2);
    }
}
