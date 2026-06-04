// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ActiveSentinel} from "../src/ActiveSentinel.sol";
import {IdentityRegistry} from "../src/erc8004/IdentityRegistry.sol";
import {IINITCore} from "../src/interfaces/IINITCore.sol";
import {IFlashBorrower} from "../src/interfaces/IFlashBorrower.sol";
import {IDexRouter} from "../src/interfaces/IDexRouter.sol";

// ═══════════════════════════════════════════════════════════════════════
//                          MOCK CONTRACTS
// ═══════════════════════════════════════════════════════════════════════

/// @dev Mock ERC20 для тестов
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

/// @dev Mock INIT Core — имитирует flash borrow
contract MockINITCore {
    uint256 public fee = 0; // 0 fee для тестов

    function setFee(uint256 _fee) external {
        fee = _fee;
    }

    function flashBorrow(address token, uint256 amount, bytes calldata data) external {
        // Передаём токены заёмщику
        IERC20(token).transfer(msg.sender, amount);

        // Вызываем callback
        bytes32 result = IFlashBorrower(msg.sender).onFlashBorrow(
            msg.sender, token, amount, fee, data
        );

        require(result == keccak256("IFlashBorrower.onFlashBorrow"), "Invalid callback return");
    }
}

/// @dev Mock DEX Router — имитирует swap с настраиваемым rate
contract MockDexRouter is IDexRouter {
    uint256 public rate = 1e18; // 1:1 по умолчанию
    bool public shouldFail;

    function setRate(uint256 _rate) external {
        rate = _rate;
    }

    function setFail(bool _fail) external {
        shouldFail = _fail;
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        bytes calldata /* payload */
    ) external override returns (uint256 amountOut) {
        if (shouldFail) return 0;

        // Забираем входной токен
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);

        // Рассчитываем выход по rate
        amountOut = (amountIn * rate) / 1e18;
        require(amountOut >= amountOutMin, "Slippage exceeded");

        // Отдаём выходной токен
        MockERC20(tokenOut).mint(msg.sender, amountOut);
    }
}

// ═══════════════════════════════════════════════════════════════════════
//                          TEST CONTRACT
// ═══════════════════════════════════════════════════════════════════════

contract ActiveSentinelTest is Test {
    ActiveSentinel public sentinel;
    IdentityRegistry public identity;
    MockINITCore public initCore;
    MockDexRouter public dexRouterA;
    MockDexRouter public dexRouterB;
    MockERC20 public tokenA; // USDC-like
    MockERC20 public tokenB; // WMNT-like

    address public dispatcher = address(0xD15);
    address public owner = address(this);

    function setUp() public {
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

        // Configure access control
        sentinel.setTrustedDispatcher(dispatcher);
        sentinel.setWhitelistedToken(address(tokenA), true);
        sentinel.setWhitelistedToken(address(tokenB), true);

        // Register dispatcher as ERC-8004 agent (for isAuthorizedCaller coverage)
        identity.registerAgent(dispatcher, "ipfs://QmDispatcher");
        sentinel.setIdentityRegistry(address(identity), 1);

        // Seed INIT Core с ликвидностью
        tokenA.mint(address(initCore), 1_000_000e18);
    }

    // ─── Helper: build ArbParams ────────────────────────────────────────

    function _buildParams(
        uint256 borrowAmount,
        uint256 minProfit,
        uint256 nonce
    ) internal view returns (ActiveSentinel.ArbParams memory) {
        return ActiveSentinel.ArbParams({
            tokenA: address(tokenA),
            tokenB: address(tokenB),
            borrowAmount: borrowAmount,
            minProfitTokenA: minProfit,
            nonce: nonce,
            amountOutMinRoute1: 0,
            amountOutMinRoute2: 0,
            reasoningHash: bytes32(0),
            dexPayloadRoute1: "",
            dexPayloadRoute2: ""
        });
    }

    // ─── Успешный арбитраж (через dispatcher) ──────────────────────────

    function test_successfulArbitrage() public {
        dexRouterA.setRate(1.05e18);
        dexRouterB.setRate(1.0e18);

        ActiveSentinel.ArbParams memory params = _buildParams(100e18, 4e18, 1);

        vm.prank(dispatcher);
        sentinel.executeFlashArbitrage(params);

        uint256 balance = tokenA.balanceOf(address(sentinel));
        assertGe(balance, 4e18, "Profit should be >= 4 tokens");
    }

    // ─── Инвариант: недостаточный профит → revert ────────────────────

    function test_revert_invariantViolated() public {
        dexRouterA.setRate(1.01e18);
        dexRouterB.setRate(1.0e18);

        ActiveSentinel.ArbParams memory params = _buildParams(100e18, 5e18, 2);

        vm.prank(dispatcher);
        vm.expectRevert(
            abi.encodeWithSelector(
                ActiveSentinel.InvariantViolated.selector,
                5e18,
                1e18
            )
        );
        sentinel.executeFlashArbitrage(params);
    }

    // ─── Unauthorized (random address) ─────────────────────────────────

    function test_revert_unauthorized() public {
        ActiveSentinel.ArbParams memory params = _buildParams(100e18, 0, 3);

        vm.prank(address(0xdead));
        vm.expectRevert(ActiveSentinel.Unauthorized.selector);
        sentinel.executeFlashArbitrage(params);
    }

    // ─── Zero amount ─────────────────────────────────────────────────

    function test_revert_zeroAmount() public {
        ActiveSentinel.ArbParams memory params = _buildParams(0, 0, 4);

        vm.prank(dispatcher);
        vm.expectRevert(ActiveSentinel.ZeroAmount.selector);
        sentinel.executeFlashArbitrage(params);
    }

    // ─── Swap failure ────────────────────────────────────────────────

    function test_revert_swapFailed() public {
        dexRouterA.setFail(true);

        ActiveSentinel.ArbParams memory params = _buildParams(100e18, 0, 5);

        vm.prank(dispatcher);
        vm.expectRevert(
            abi.encodeWithSelector(ActiveSentinel.SwapFailed.selector, 1)
        );
        sentinel.executeFlashArbitrage(params);
    }

    // ─── Rescue tokens ───────────────────────────────────────────────

    function test_rescue() public {
        tokenA.mint(address(sentinel), 50e18);

        uint256 balBefore = tokenA.balanceOf(owner);
        sentinel.rescue(address(tokenA), 0);
        uint256 balAfter = tokenA.balanceOf(owner);

        assertEq(balAfter - balBefore, 50e18);
    }

    // ─── Callback auth: direct call should fail ──────────────────────

    function test_revert_directCallbackCall() public {
        ActiveSentinel.ArbParams memory params = _buildParams(100e18, 0, 6);

        bytes memory fakeData = abi.encode(params);

        vm.expectRevert(ActiveSentinel.Unauthorized.selector);
        sentinel.onFlashBorrow(address(this), address(tokenA), 100e18, 0, fakeData);
    }

    // ─── Nonce replay protection ─────────────────────────────────────

    function test_revert_nonceReplay() public {
        dexRouterA.setRate(1.05e18);
        dexRouterB.setRate(1.0e18);

        ActiveSentinel.ArbParams memory params = _buildParams(100e18, 0, 7);

        vm.prank(dispatcher);
        sentinel.executeFlashArbitrage(params);

        // Same nonce again
        vm.prank(dispatcher);
        vm.expectRevert(ActiveSentinel.NonceAlreadyUsed.selector);
        sentinel.executeFlashArbitrage(params);
    }

    // ─── ERC-8004 agent can call directly ────────────────────────────

    function test_registeredAgentCanCall() public {
        address agent = address(0xA6E);
        identity.registerAgent(agent, "ipfs://QmAgent2");

        dexRouterA.setRate(1.05e18);
        dexRouterB.setRate(1.0e18);

        ActiveSentinel.ArbParams memory params = _buildParams(50e18, 0, 8);

        vm.prank(agent);
        sentinel.executeFlashArbitrage(params);

        assertTrue(sentinel.usedNonces(8));
    }

    // ─── Fuzz: minProfitTokenA invariant ─────────────────────────────

    function testFuzz_invariantEnforcement(uint256 minProfit) public {
        minProfit = bound(minProfit, 0, 1000e18);

        dexRouterA.setRate(1.05e18);
        dexRouterB.setRate(1.0e18);
        uint256 borrowAmount = 100e18;
        uint256 expectedProfit = 5e18;

        ActiveSentinel.ArbParams memory params = _buildParams(borrowAmount, minProfit, minProfit);

        if (minProfit > expectedProfit) {
            vm.expectRevert();
        }

        vm.prank(dispatcher);
        sentinel.executeFlashArbitrage(params);
    }

    // ─── Admin: setTrustedDispatcher ─────────────────────────────────

    function test_setTrustedDispatcher() public {
        address newDispatcher = address(0x1234);
        sentinel.setTrustedDispatcher(newDispatcher);
        assertEq(sentinel.trustedDispatcher(), newDispatcher);
    }

    function test_revert_setTrustedDispatcher_notOwner() public {
        vm.prank(address(0xdead));
        vm.expectRevert(ActiveSentinel.Unauthorized.selector);
        sentinel.setTrustedDispatcher(address(0x123));
    }

    // ─── isAuthorizedCaller view ─────────────────────────────────────

    function test_isAuthorizedCaller() public view {
        assertTrue(sentinel.isAuthorizedCaller(dispatcher));
        assertFalse(sentinel.isAuthorizedCaller(address(0xDEAD)));
    }
}
