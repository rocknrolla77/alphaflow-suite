// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MerchantMoeAdapter, IMerchantMoeRouter} from "../src/adapters/MerchantMoeAdapter.sol";
import {AgniAdapter, IAgniSwapRouter} from "../src/adapters/AgniAdapter.sol";
import {IDexRouter} from "../src/interfaces/IDexRouter.sol";

// ═══════════════════════════════════════════════════════════════════
//  Mock Tokens
// ═══════════════════════════════════════════════════════════════════

contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

// ═══════════════════════════════════════════════════════════════════
//  Mock Merchant Moe Router
// ═══════════════════════════════════════════════════════════════════

contract MockMerchantMoeRouter {
    uint256 public rate = 1e18; // 1:1 by default

    function setRate(uint256 _rate) external { rate = _rate; }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external returns (uint256[] memory amounts) {
        require(path.length >= 2, "Invalid path");

        uint256 amountOut = (amountIn * rate) / 1e18;
        require(amountOut >= amountOutMin, "Insufficient output");

        // Pull input tokens
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        // Mint output tokens to recipient
        MockERC20(path[path.length - 1]).mint(to, amountOut);

        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = amountOut;
    }
}

// ═══════════════════════════════════════════════════════════════════
//  Mock Agni Router
// ═══════════════════════════════════════════════════════════════════

contract MockAgniRouter {
    uint256 public rate = 1e18;

    function setRate(uint256 _rate) external { rate = _rate; }

    function exactInputSingle(IAgniSwapRouter.ExactInputSingleParams calldata params)
        external
        returns (uint256 amountOut)
    {
        amountOut = (params.amountIn * rate) / 1e18;
        require(amountOut >= params.amountOutMinimum, "Too little received");

        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        MockERC20(params.tokenOut).mint(params.recipient, amountOut);
    }
}

// ═══════════════════════════════════════════════════════════════════
//  Adapter Tests
// ═══════════════════════════════════════════════════════════════════

contract DexAdaptersTest is Test {
    MockERC20 tokenA;
    MockERC20 tokenB;
    MockMerchantMoeRouter moeRouter;
    MockAgniRouter agniRouter;
    MerchantMoeAdapter moeAdapter;
    AgniAdapter agniAdapter;

    address user = address(0xBEEF);

    function setUp() public {
        tokenA = new MockERC20("Token A", "TKA");
        tokenB = new MockERC20("Token B", "TKB");
        moeRouter = new MockMerchantMoeRouter();
        agniRouter = new MockAgniRouter();
        moeAdapter = new MerchantMoeAdapter(address(moeRouter));
        agniAdapter = new AgniAdapter(address(agniRouter));

        // Fund user
        tokenA.mint(user, 1000e18);
        tokenB.mint(user, 1000e18);
    }

    // ─── MerchantMoeAdapter Tests ───────────────────────────────────

    function test_moeAdapter_successfulSwap() public {
        moeRouter.setRate(1.05e18); // 5% profit

        vm.startPrank(user);
        tokenA.approve(address(moeAdapter), 100e18);

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        bytes memory payload = abi.encode(path, uint256(0));

        uint256 out = moeAdapter.swap(address(tokenA), address(tokenB), 100e18, 100e18, payload);
        vm.stopPrank();

        assertEq(out, 105e18);
        assertEq(tokenB.balanceOf(user), 1105e18); // 1000 + 105
    }

    function test_moeAdapter_revertInvalidPath() public {
        vm.startPrank(user);
        tokenA.approve(address(moeAdapter), 100e18);

        address[] memory path = new address[](1);
        path[0] = address(tokenA);
        bytes memory payload = abi.encode(path, uint256(0));

        vm.expectRevert(MerchantMoeAdapter.InvalidPath.selector);
        moeAdapter.swap(address(tokenA), address(tokenB), 100e18, 0, payload);
        vm.stopPrank();
    }

    function test_moeAdapter_revertPathMismatch() public {
        vm.startPrank(user);
        tokenA.approve(address(moeAdapter), 100e18);

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenA); // wrong! should be tokenB
        bytes memory payload = abi.encode(path, uint256(0));

        vm.expectRevert(MerchantMoeAdapter.PathMismatch.selector);
        moeAdapter.swap(address(tokenA), address(tokenB), 100e18, 0, payload);
        vm.stopPrank();
    }

    function test_moeAdapter_immutableRouter() public view {
        assertEq(moeAdapter.router(), address(moeRouter));
    }

    function test_moeAdapter_revertZeroAddress() public {
        vm.expectRevert(MerchantMoeAdapter.ZeroAddress.selector);
        new MerchantMoeAdapter(address(0));
    }

    // ─── AgniAdapter Tests ───────────────────────────────────────────

    function test_agniAdapter_successfulSwap() public {
        agniRouter.setRate(1.03e18); // 3% profit

        vm.startPrank(user);
        tokenA.approve(address(agniAdapter), 100e18);

        // payload: fee=3000, deadline=0, sqrtPriceLimitX96=0
        bytes memory payload = abi.encode(uint24(3000), uint256(0), uint160(0));

        uint256 out = agniAdapter.swap(address(tokenA), address(tokenB), 100e18, 100e18, payload);
        vm.stopPrank();

        assertEq(out, 103e18);
        assertEq(tokenB.balanceOf(user), 1103e18);
    }

    function test_agniAdapter_revertSlippage() public {
        agniRouter.setRate(0.95e18); // -5%

        vm.startPrank(user);
        tokenA.approve(address(agniAdapter), 100e18);

        bytes memory payload = abi.encode(uint24(3000), uint256(0), uint160(0));

        vm.expectRevert("Too little received");
        agniAdapter.swap(address(tokenA), address(tokenB), 100e18, 100e18, payload);
        vm.stopPrank();
    }

    function test_agniAdapter_immutableRouter() public view {
        assertEq(agniAdapter.router(), address(agniRouter));
    }

    function test_agniAdapter_revertZeroAddress() public {
        vm.expectRevert(AgniAdapter.ZeroAddress.selector);
        new AgniAdapter(address(0));
    }

    // ─── IDexRouter Interface Compliance ─────────────────────────────

    function test_bothAdapters_implementIDexRouter() public view {
        // Verify they can be cast to IDexRouter
        IDexRouter moe = IDexRouter(address(moeAdapter));
        IDexRouter agni = IDexRouter(address(agniAdapter));
        // Just verifying the cast doesn't revert
        assert(address(moe) != address(0));
        assert(address(agni) != address(0));
    }

    // ─── Fuzz: MerchantMoe ───────────────────────────────────────────

    function testFuzz_moeAdapter_amountConsistency(uint256 amountIn) public {
        amountIn = bound(amountIn, 1e6, 1000e18);
        moeRouter.setRate(1e18); // 1:1

        tokenA.mint(user, amountIn);

        vm.startPrank(user);
        tokenA.approve(address(moeAdapter), amountIn);

        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        bytes memory payload = abi.encode(path, uint256(0));

        uint256 out = moeAdapter.swap(address(tokenA), address(tokenB), amountIn, 0, payload);
        vm.stopPrank();

        assertEq(out, amountIn); // 1:1 rate
    }
}
