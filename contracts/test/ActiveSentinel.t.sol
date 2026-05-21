// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ActiveSentinel} from "../src/ActiveSentinel.sol";
import {IINITCore} from "../src/interfaces/IINITCore.sol";
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
        allowance[from][msg.sender] -= amount;
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
        bytes32 result = ActiveSentinel(payable(msg.sender)).onFlashBorrow(
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

/// @dev Вредоносный DEX — пытается reentrancy
contract MaliciousDexRouter is IDexRouter {
    ActiveSentinel public target;
    bool public attacked;

    constructor(address _target) {
        target = ActiveSentinel(payable(_target));
    }

    function swap(
        address tokenIn,
        address, /* tokenOut */
        uint256 amountIn,
        uint256, /* amountOutMin */
        bytes calldata /* payload */
    ) external override returns (uint256) {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);

        // Попытка reentrancy
        if (!attacked) {
            attacked = true;
            ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
                tokenA: address(0),
                tokenB: address(0),
                borrowAmount: 1,
                minProfitTokenA: 0,
                amountOutMinRoute1: 0,
                amountOutMinRoute2: 0,
                dexPayloadRoute1: "",
                dexPayloadRoute2: ""
            });
            // Это должно откатиться с ReentrancyAttempt
            target.executeFlashArbitrage(params);
        }
        return 0;
    }
}

// ═══════════════════════════════════════════════════════════════════════
//                          TEST CONTRACT
// ═══════════════════════════════════════════════════════════════════════

contract ActiveSentinelTest is Test {
    ActiveSentinel public sentinel;
    MockINITCore public initCore;
    MockDexRouter public dexRouterA;
    MockDexRouter public dexRouterB;
    MockERC20 public tokenA; // USDC-like
    MockERC20 public tokenB; // WMNT-like

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

        // Seed INIT Core с ликвидностью
        tokenA.mint(address(initCore), 1_000_000e18);
    }

    // ─── Успешный арбитраж ───────────────────────────────────────────

    function test_successfulArbitrage() public {
        // Настраиваем прибыльные рейты:
        // Route 1 (A->B): 1 A = 1.05 B
        // Route 2 (B->A): 1 B = 1.0 A
        // Net: 1 A -> 1.05 B -> 1.05 A = 5% profit
        dexRouterA.setRate(1.05e18);
        dexRouterB.setRate(1.0e18);

        ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
            tokenA: address(tokenA),
            tokenB: address(tokenB),
            borrowAmount: 100e18,
            minProfitTokenA: 4e18, // Ожидаем минимум 4 токена профита
            amountOutMinRoute1: 100e18,
            amountOutMinRoute2: 100e18,
            dexPayloadRoute1: "",
            dexPayloadRoute2: ""
        });

        sentinel.executeFlashArbitrage(params);

        // Проверяем что профит >= minProfitTokenA
        uint256 balance = tokenA.balanceOf(address(sentinel));
        assertGe(balance, 4e18, "Profit should be >= 4 tokens");
    }

    // ─── Инвариант: недостаточный профит → revert ────────────────────

    function test_revert_invariantViolated() public {
        // Рейты дают только 1% профита, но мы требуем 5%
        dexRouterA.setRate(1.01e18);
        dexRouterB.setRate(1.0e18);

        ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
            tokenA: address(tokenA),
            tokenB: address(tokenB),
            borrowAmount: 100e18,
            minProfitTokenA: 5e18, // Требуем 5 токенов
            amountOutMinRoute1: 0,
            amountOutMinRoute2: 0,
            dexPayloadRoute1: "",
            dexPayloadRoute2: ""
        });

        vm.expectRevert(
            abi.encodeWithSelector(
                ActiveSentinel.InvariantViolated.selector,
                5e18,
                1e18  // Реальный профит ~1 токен
            )
        );
        sentinel.executeFlashArbitrage(params);
    }

    // ─── Unauthorized ────────────────────────────────────────────────

    function test_revert_unauthorized() public {
        ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
            tokenA: address(tokenA),
            tokenB: address(tokenB),
            borrowAmount: 100e18,
            minProfitTokenA: 0,
            amountOutMinRoute1: 0,
            amountOutMinRoute2: 0,
            dexPayloadRoute1: "",
            dexPayloadRoute2: ""
        });

        vm.prank(address(0xdead));
        vm.expectRevert(ActiveSentinel.Unauthorized.selector);
        sentinel.executeFlashArbitrage(params);
    }

    // ─── Zero amount ─────────────────────────────────────────────────

    function test_revert_zeroAmount() public {
        ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
            tokenA: address(tokenA),
            tokenB: address(tokenB),
            borrowAmount: 0,
            minProfitTokenA: 0,
            amountOutMinRoute1: 0,
            amountOutMinRoute2: 0,
            dexPayloadRoute1: "",
            dexPayloadRoute2: ""
        });

        vm.expectRevert(ActiveSentinel.ZeroAmount.selector);
        sentinel.executeFlashArbitrage(params);
    }

    // ─── Reentrancy protection ───────────────────────────────────────

    function test_revert_reentrancy() public {
        // Создаём sentinel с вредоносным DEX router
        MaliciousDexRouter malicious = new MaliciousDexRouter(address(0)); // placeholder

        ActiveSentinel sentinelVuln = new ActiveSentinel(
            address(initCore),
            address(malicious),
            address(dexRouterB)
        );

        // Обновляем target в malicious router
        malicious = new MaliciousDexRouter(address(sentinelVuln));

        // Пересоздаём с правильным malicious router
        sentinelVuln = new ActiveSentinel(
            address(initCore),
            address(malicious),
            address(dexRouterB)
        );

        tokenA.mint(address(initCore), 1_000_000e18);

        ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
            tokenA: address(tokenA),
            tokenB: address(tokenB),
            borrowAmount: 100e18,
            minProfitTokenA: 0,
            amountOutMinRoute1: 0,
            amountOutMinRoute2: 0,
            dexPayloadRoute1: "",
            dexPayloadRoute2: ""
        });

        // Транзакция должна откатиться из-за reentrancy в callback
        vm.expectRevert();
        sentinelVuln.executeFlashArbitrage(params);
    }

    // ─── Swap failure ────────────────────────────────────────────────

    function test_revert_swapFailed() public {
        dexRouterA.setFail(true);

        ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
            tokenA: address(tokenA),
            tokenB: address(tokenB),
            borrowAmount: 100e18,
            minProfitTokenA: 0,
            amountOutMinRoute1: 0,
            amountOutMinRoute2: 0,
            dexPayloadRoute1: "",
            dexPayloadRoute2: ""
        });

        vm.expectRevert(
            abi.encodeWithSelector(ActiveSentinel.SwapFailed.selector, 1)
        );
        sentinel.executeFlashArbitrage(params);
    }

    // ─── Rescue tokens ───────────────────────────────────────────────

    function test_rescue() public {
        tokenA.mint(address(sentinel), 50e18);

        uint256 balBefore = tokenA.balanceOf(owner);
        sentinel.rescue(address(tokenA), 0); // 0 = весь баланс
        uint256 balAfter = tokenA.balanceOf(owner);

        assertEq(balAfter - balBefore, 50e18);
    }

    // ─── Fuzz: minProfitTokenA ───────────────────────────────────────

    function testFuzz_invariantEnforcement(uint256 minProfit) public {
        // Bound minProfit to reasonable range
        minProfit = bound(minProfit, 0, 1000e18);

        // Fixed 5% profit scenario
        dexRouterA.setRate(1.05e18);
        dexRouterB.setRate(1.0e18);
        uint256 borrowAmount = 100e18;
        uint256 expectedProfit = 5e18; // 5% of 100

        ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
            tokenA: address(tokenA),
            tokenB: address(tokenB),
            borrowAmount: borrowAmount,
            minProfitTokenA: minProfit,
            amountOutMinRoute1: 0,
            amountOutMinRoute2: 0,
            dexPayloadRoute1: "",
            dexPayloadRoute2: ""
        });

        if (minProfit > expectedProfit) {
            vm.expectRevert();
        }

        sentinel.executeFlashArbitrage(params);
    }

    // ─── Callback auth: direct call should fail ──────────────────────

    function test_revert_directCallbackCall() public {
        bytes memory fakeData = abi.encode(
            ActiveSentinel.ArbParams({
                tokenA: address(tokenA),
                tokenB: address(tokenB),
                borrowAmount: 100e18,
                minProfitTokenA: 0,
                amountOutMinRoute1: 0,
                amountOutMinRoute2: 0,
                dexPayloadRoute1: "",
                dexPayloadRoute2: ""
            })
        );

        vm.expectRevert(ActiveSentinel.Unauthorized.selector);
        sentinel.onFlashBorrow(address(this), address(tokenA), 100e18, 0, fakeData);
    }
}
