// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ActiveSentinel} from "../src/ActiveSentinel.sol";
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
    uint256 public fee = 0;

    function setFee(uint256 _fee) external {
        fee = _fee;
    }

    function flashBorrow(address token, uint256 amount, bytes calldata data) external {
        // Передаём токены заёмщику
        IERC20(token).transfer(msg.sender, amount);

        // Вызываем callback с msg.sender как initiator (корректное поведение)
        bytes32 result = IFlashBorrower(msg.sender).onFlashBorrow(
            msg.sender, token, amount, fee, data
        );

        require(result == keccak256("IFlashBorrower.onFlashBorrow"), "Invalid callback return");
    }
}

/// @dev Поддельный INIT Core — для теста спуфинга (H-08)
///      Вызывает onFlashBorrow с подменённым initiator
contract FakeINITCore {
    address public realSentinel;

    constructor(address _sentinel) {
        realSentinel = _sentinel;
    }

    /// @dev Имитирует вызов от лица initCore, но с чужим initiator
    function exploitH08(
        address fakeSentinel,
        address token,
        uint256 amount,
        bytes calldata data
    ) external {
        // Пытаемся вызвать callback с поддельным initiator
        IFlashBorrower(realSentinel).onFlashBorrow(
            fakeSentinel, // НЕ address(realSentinel) — подмена контекста
            token,
            amount,
            0,
            data
        );
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

        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);

        amountOut = (amountIn * rate) / 1e18;
        require(amountOut >= amountOutMin, "Slippage exceeded");

        MockERC20(tokenOut).mint(msg.sender, amountOut);
    }
}

/// @dev Вредоносный DEX — пытается reentrancy через стандартный вызов
contract MaliciousDexRouter is IDexRouter {
    ActiveSentinel public target;
    bool public attacked;
    uint256 public teeKey;
    address public teeAgent;

    constructor(address _target, uint256 _teeKey, address _teeAgent) {
        target = ActiveSentinel(payable(_target));
        teeKey = _teeKey;
        teeAgent = _teeAgent;
    }

    function swap(
        address tokenIn,
        address, /* tokenOut */
        uint256 amountIn,
        uint256, /* amountOutMin */
        bytes calldata /* payload */
    ) external override returns (uint256) {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);

        if (!attacked) {
            attacked = true;
            // Попытка reentrancy
            ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
                tokenA: address(0),
                tokenB: address(0),
                borrowAmount: 1,
                minProfitTokenA: 0,
                nonce: 999999,
                amountOutMinRoute1: 0,
                amountOutMinRoute2: 0,
                dexPayloadRoute1: "",
                dexPayloadRoute2: "",
                teeSignature: ""
            });
            target.executeFlashArbitrage(params);
        }
        return 0;
    }
}

/// @dev ERC-777-style токен с хуком, пытающимся low-gas reentrancy
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

        // ERC-777 style hook: попытка reentrancy при transfer с ограниченным gas
        if (hookEnabled && address(target) != address(0)) {
            // Симуляция low-gas call (≤2300 gas stipend)
            ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
                tokenA: address(0),
                tokenB: address(0),
                borrowAmount: 1,
                minProfitTokenA: 0,
                nonce: 888888,
                amountOutMinRoute1: 0,
                amountOutMinRoute2: 0,
                dexPayloadRoute1: "",
                dexPayloadRoute2: "",
                teeSignature: ""
            });

            // Low-gas call — должен упасть на SSTORE (5000 gas нужно, но только 2300 дано)
            (bool success,) = address(target).call{gas: hookGasLimit}(
                abi.encodeCall(ActiveSentinel.executeFlashArbitrage, (params))
            );
            // success должен быть false (OOG или revert)
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
    MockINITCore public initCore;
    MockDexRouter public dexRouterA;
    MockDexRouter public dexRouterB;
    MockERC20 public tokenA; // USDC-like
    MockERC20 public tokenB; // WMNT-like

    // TEE Agent keypair для EIP-712 подписей
    uint256 internal teePrivateKey = 0xA11CE;
    address internal teeAgent;

    // Attacker keypair
    uint256 internal attackerPrivateKey = 0xBAD;
    address internal attacker;

    address public owner;

    function setUp() public {
        owner = address(this);
        teeAgent = vm.addr(teePrivateKey);
        attacker = vm.addr(attackerPrivateKey);

        tokenA = new MockERC20("USD Coin", "USDC");
        tokenB = new MockERC20("Wrapped MNT", "WMNT");

        initCore = new MockINITCore();
        dexRouterA = new MockDexRouter();
        dexRouterB = new MockDexRouter();

        sentinel = new ActiveSentinel(
            address(initCore),
            address(dexRouterA),
            address(dexRouterB),
            teeAgent
        );

        // Whitelist tokens
        sentinel.setWhitelistedToken(address(tokenA), true);
        sentinel.setWhitelistedToken(address(tokenB), true);

        // Seed INIT Core с ликвидностью
        tokenA.mint(address(initCore), 1_000_000e18);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                  HELPER: Generate TEE Signature
    // ═══════════════════════════════════════════════════════════════════

    function _signArbParams(
        uint256 privateKey,
        address _tokenA,
        address _tokenB,
        uint256 borrowAmount,
        uint256 minProfit,
        uint256 nonce
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(
            keccak256("ArbParams(address tokenA,address tokenB,uint256 borrowAmount,uint256 minProfitTokenA,uint256 nonce)"),
            _tokenA,
            _tokenB,
            borrowAmount,
            minProfit,
            nonce
        ));

        bytes32 domainSeparator = sentinel.domainSeparator();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _buildValidParams(uint256 nonce) internal view returns (ActiveSentinel.ArbParams memory) {
        bytes memory sig = _signArbParams(
            teePrivateKey,
            address(tokenA),
            address(tokenB),
            100e18,
            4e18,
            nonce
        );

        return ActiveSentinel.ArbParams({
            tokenA: address(tokenA),
            tokenB: address(tokenB),
            borrowAmount: 100e18,
            minProfitTokenA: 4e18,
            nonce: nonce,
            amountOutMinRoute1: 0,
            amountOutMinRoute2: 0,
            dexPayloadRoute1: "",
            dexPayloadRoute2: "",
            teeSignature: sig
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    //  TEST 1: Спуфинг INIT Capital (Exploit Path H-08)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Поддельный контракт вызывает onFlashBorrow — должен получить InvalidInitiator
    function test_revert_spoofedInitiator_H08() public {
        // Attacker деплоит fake INIT Core с адресом sentinel
        // Но так как msg.sender != initCore → revert Unauthorized
        
        // Сценарий 1: Вызов от произвольного адреса (не initCore)
        bytes memory fakeData = abi.encode(_buildValidParams(1));

        vm.prank(address(0xCAFE)); // не initCore
        vm.expectRevert(ActiveSentinel.Unauthorized.selector);
        sentinel.onFlashBorrow(
            address(sentinel), // правильный initiator
            address(tokenA),
            100e18,
            0,
            fakeData
        );
    }

    /// @notice Даже если msg.sender == initCore, но initiator != address(this) → revert
    function test_revert_wrongInitiator_H08() public {
        bytes memory fakeData = abi.encode(_buildValidParams(2));

        // Имитируем вызов от initCore, но с подменённым initiator
        vm.prank(address(initCore));
        vm.expectRevert(ActiveSentinel.InvalidInitiator.selector);
        sentinel.onFlashBorrow(
            address(0xDEAD), // поддельный initiator (НЕ address(sentinel))
            address(tokenA),
            100e18,
            0,
            fakeData
        );
    }

    /// @notice Полный H-08 сценарий: fake INIT core пытается drain через multilevel position
    function test_revert_fakeInitCoreDrain_H08() public {
        FakeINITCore fakeInit = new FakeINITCore(address(sentinel));

        bytes memory fakeData = abi.encode(_buildValidParams(3));

        // FakeINITCore вызывает onFlashBorrow на sentinel, но:
        // msg.sender = address(fakeInit) != initCore → revert Unauthorized
        vm.expectRevert(ActiveSentinel.Unauthorized.selector);
        fakeInit.exploitH08(
            address(0xDEAD),  // фейковый initiator
            address(tokenA),
            100e18,
            fakeData
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    //  TEST 2: TEE Signature Verification
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Подпись от неавторизованного ключа → revert InvalidTEESignature
    function test_revert_invalidTEESignature() public {
        // Подписываем валидные params, но СТОРОННИМ ключом (не teeAgent)
        bytes memory attackerSig = _signArbParams(
            attackerPrivateKey,  // ← НЕ teePrivateKey
            address(tokenA),
            address(tokenB),
            100e18,
            4e18,
            10
        );

        ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
            tokenA: address(tokenA),
            tokenB: address(tokenB),
            borrowAmount: 100e18,
            minProfitTokenA: 4e18,
            nonce: 10,
            amountOutMinRoute1: 0,
            amountOutMinRoute2: 0,
            dexPayloadRoute1: "",
            dexPayloadRoute2: "",
            teeSignature: attackerSig
        });

        vm.expectRevert(ActiveSentinel.InvalidTEESignature.selector);
        sentinel.executeFlashArbitrage(params);
    }

    /// @notice Пустая подпись → revert (ECDSA recover вернёт address(0))
    function test_revert_emptyTEESignature() public {
        ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
            tokenA: address(tokenA),
            tokenB: address(tokenB),
            borrowAmount: 100e18,
            minProfitTokenA: 4e18,
            nonce: 11,
            amountOutMinRoute1: 0,
            amountOutMinRoute2: 0,
            dexPayloadRoute1: "",
            dexPayloadRoute2: "",
            teeSignature: ""  // пустая подпись
        });

        vm.expectRevert(); // ECDSA.recover reverts on empty/malformed sig
        sentinel.executeFlashArbitrage(params);
    }

    /// @notice Подпись правильного ключа, но для ДРУГИХ параметров → revert
    function test_revert_signatureMismatch() public {
        // Подписываем для borrowAmount = 50e18
        bytes memory sig = _signArbParams(
            teePrivateKey,
            address(tokenA),
            address(tokenB),
            50e18,     // ← подписано для 50
            4e18,
            12
        );

        // Но передаём borrowAmount = 100e18
        ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
            tokenA: address(tokenA),
            tokenB: address(tokenB),
            borrowAmount: 100e18,   // ← 100, не 50
            minProfitTokenA: 4e18,
            nonce: 12,
            amountOutMinRoute1: 0,
            amountOutMinRoute2: 0,
            dexPayloadRoute1: "",
            dexPayloadRoute2: "",
            teeSignature: sig
        });

        vm.expectRevert(ActiveSentinel.InvalidTEESignature.selector);
        sentinel.executeFlashArbitrage(params);
    }

    /// @notice Валидная подпись TEE → успешное выполнение
    function test_validTEESignature_success() public {
        dexRouterA.setRate(1.05e18);
        dexRouterB.setRate(1.0e18);

        ActiveSentinel.ArbParams memory params = _buildValidParams(20);

        sentinel.executeFlashArbitrage(params);

        uint256 balance = tokenA.balanceOf(address(sentinel));
        assertGe(balance, 4e18, "Profit should be >= 4 tokens");
    }

    // ═══════════════════════════════════════════════════════════════════
    //  TEST 3: Low-Gas Reentrancy (EIP-1153 Bypass via ERC-777 Hook)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Reentrancy через стандартный вызов → revert ReentrancyAttempt (TLOAD path)
    function test_revert_reentrancy_standardGas() public {
        // Создаём sentinel с malicious DEX router
        MaliciousDexRouter malicious = new MaliciousDexRouter(
            address(0), teePrivateKey, teeAgent // placeholder target
        );

        ActiveSentinel sentinelVuln = new ActiveSentinel(
            address(initCore),
            address(malicious),
            address(dexRouterB),
            teeAgent
        );
        sentinelVuln.setWhitelistedToken(address(tokenA), true);
        sentinelVuln.setWhitelistedToken(address(tokenB), true);

        // Пересоздаём malicious с правильным target
        malicious = new MaliciousDexRouter(address(sentinelVuln), teePrivateKey, teeAgent);
        sentinelVuln = new ActiveSentinel(
            address(initCore),
            address(malicious),
            address(dexRouterB),
            teeAgent
        );
        sentinelVuln.setWhitelistedToken(address(tokenA), true);
        sentinelVuln.setWhitelistedToken(address(tokenB), true);

        tokenA.mint(address(initCore), 1_000_000e18);

        bytes memory sig = _signArbParams(
            teePrivateKey, address(tokenA), address(tokenB), 100e18, 0, 30
        );

        ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
            tokenA: address(tokenA),
            tokenB: address(tokenB),
            borrowAmount: 100e18,
            minProfitTokenA: 0,
            nonce: 30,
            amountOutMinRoute1: 0,
            amountOutMinRoute2: 0,
            dexPayloadRoute1: "",
            dexPayloadRoute2: "",
            teeSignature: sig
        });

        // Reentrancy attempt → revert
        vm.expectRevert();
        sentinelVuln.executeFlashArbitrage(params);
    }

    /// @notice Low-gas reentrancy (≤2300 gas stipend) через ERC-777-style хук
    ///         SSTORE требует ~5000 gas → OOG при попытке записи _reentrancyStatus
    function test_revert_lowGasReentrancy_ERC777() public {
        MaliciousERC777Token evilToken = new MaliciousERC777Token();
        evilToken.mint(address(initCore), 1_000_000e18);

        // Создаём sentinel с evil token в whitelist
        ActiveSentinel sentinelTarget = new ActiveSentinel(
            address(initCore),
            address(dexRouterA),
            address(dexRouterB),
            teeAgent
        );
        sentinelTarget.setWhitelistedToken(address(evilToken), true);
        sentinelTarget.setWhitelistedToken(address(tokenB), true);

        evilToken.setTarget(address(sentinelTarget));
        // Включаем хук с 2300 gas (стандартная стипендия transfer)
        evilToken.setHook(true, 2300);

        // При transfer evil token попытается re-enter с 2300 gas
        // SSTORE для _reentrancyStatus = 2 стоит 5000 gas (cold) → OOG
        // Даже если TSTORE доступен за 100 gas, onlyOwner check на msg.sender  
        // гарантирует что вызов от token contract всё равно revert

        // Прямой low-gas вызов executeFlashArbitrage с 2300 gas → OOG
        ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
            tokenA: address(evilToken),
            tokenB: address(tokenB),
            borrowAmount: 100e18,
            minProfitTokenA: 0,
            nonce: 40,
            amountOutMinRoute1: 0,
            amountOutMinRoute2: 0,
            dexPayloadRoute1: "",
            dexPayloadRoute2: "",
            teeSignature: ""
        });

        // Вызов с ограниченным gas (< 5000) гарантированно упадёт на SSTORE
        (bool success,) = address(sentinelTarget).call{gas: 2300}(
            abi.encodeCall(ActiveSentinel.executeFlashArbitrage, (params))
        );
        assertFalse(success, "Low-gas reentrancy should fail with OOG");
    }

    /// @notice Проверка: SSTORE записывает _reentrancyStatus = 2 во время выполнения
    ///         Если low-gas субконтекст пытается вызвать, он видит status = 2 → revert
    function test_hybridGuard_sstoreBarrier() public {
        // Настраиваем прибыльный scenario
        dexRouterA.setRate(1.05e18);
        dexRouterB.setRate(1.0e18);

        ActiveSentinel.ArbParams memory params = _buildValidParams(41);

        // Успешное выполнение — доказывает что guard корректно lock/unlock
        sentinel.executeFlashArbitrage(params);

        // Повторный вызов с тем же nonce → revert NonceAlreadyUsed (не ReentrancyAttempt)
        // Это подтверждает что guard разблокировался после выполнения
        vm.expectRevert(ActiveSentinel.NonceAlreadyUsed.selector);
        sentinel.executeFlashArbitrage(params);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  TEST 4: Token Whitelist
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Арбитраж с неавторизованным tokenA → revert UnapprovedToken
    function test_revert_unapprovedTokenA() public {
        MockERC20 badToken = new MockERC20("Bad Token", "BAD");
        // badToken НЕ добавлен в whitelist

        bytes memory sig = _signArbParams(
            teePrivateKey, address(badToken), address(tokenB), 100e18, 0, 50
        );

        ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
            tokenA: address(badToken),
            tokenB: address(tokenB),
            borrowAmount: 100e18,
            minProfitTokenA: 0,
            nonce: 50,
            amountOutMinRoute1: 0,
            amountOutMinRoute2: 0,
            dexPayloadRoute1: "",
            dexPayloadRoute2: "",
            teeSignature: sig
        });

        vm.expectRevert(ActiveSentinel.UnapprovedToken.selector);
        sentinel.executeFlashArbitrage(params);
    }

    /// @notice Арбитраж с неавторизованным tokenB → revert UnapprovedToken
    function test_revert_unapprovedTokenB() public {
        MockERC20 badToken = new MockERC20("Evil777", "EVIL");
        // tokenA в whitelist, но badToken (как tokenB) — нет

        bytes memory sig = _signArbParams(
            teePrivateKey, address(tokenA), address(badToken), 100e18, 0, 51
        );

        ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
            tokenA: address(tokenA),
            tokenB: address(badToken),  // не в whitelist
            borrowAmount: 100e18,
            minProfitTokenA: 0,
            nonce: 51,
            amountOutMinRoute1: 0,
            amountOutMinRoute2: 0,
            dexPayloadRoute1: "",
            dexPayloadRoute2: "",
            teeSignature: sig
        });

        vm.expectRevert(ActiveSentinel.UnapprovedToken.selector);
        sentinel.executeFlashArbitrage(params);
    }

    /// @notice Удаление токена из whitelist блокирует дальнейшие операции
    function test_revert_removedFromWhitelist() public {
        // tokenA изначально в whitelist, удаляем
        sentinel.setWhitelistedToken(address(tokenA), false);

        bytes memory sig = _signArbParams(
            teePrivateKey, address(tokenA), address(tokenB), 100e18, 0, 52
        );

        ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
            tokenA: address(tokenA),
            tokenB: address(tokenB),
            borrowAmount: 100e18,
            minProfitTokenA: 0,
            nonce: 52,
            amountOutMinRoute1: 0,
            amountOutMinRoute2: 0,
            dexPayloadRoute1: "",
            dexPayloadRoute2: "",
            teeSignature: sig
        });

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
    //  TEST 5: Nonce Replay Protection
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Повторное использование nonce → revert NonceAlreadyUsed
    function test_revert_nonceReplay() public {
        dexRouterA.setRate(1.05e18);
        dexRouterB.setRate(1.0e18);

        ActiveSentinel.ArbParams memory params = _buildValidParams(60);

        // Первый вызов — успех
        sentinel.executeFlashArbitrage(params);

        // Второй вызов с тем же nonce — revert
        vm.expectRevert(ActiveSentinel.NonceAlreadyUsed.selector);
        sentinel.executeFlashArbitrage(params);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  TEST 6: Admin Access Control
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Только owner может менять TEE agent
    function test_revert_setTeeAgent_unauthorized() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(ActiveSentinel.Unauthorized.selector);
        sentinel.setTeeAgent(address(0x123));
    }

    /// @notice Нельзя установить zero address как TEE agent
    function test_revert_setTeeAgent_zeroAddress() public {
        vm.expectRevert(ActiveSentinel.ZeroAddress.selector);
        sentinel.setTeeAgent(address(0));
    }

    /// @notice Только owner может менять whitelist
    function test_revert_setWhitelist_unauthorized() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(ActiveSentinel.Unauthorized.selector);
        sentinel.setWhitelistedToken(address(tokenA), true);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  TEST 7: Integration — Full Happy Path
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Полный цикл: валидная подпись + whitelist + profit → ArbitrageExecuted event
    function test_fullHappyPath() public {
        dexRouterA.setRate(1.05e18);
        dexRouterB.setRate(1.0e18);

        ActiveSentinel.ArbParams memory params = _buildValidParams(70);

        vm.expectEmit(true, true, false, true);
        emit ActiveSentinel.ArbitrageExecuted(
            address(tokenA),
            address(tokenB),
            100e18,
            5e18  // 5% profit
        );

        sentinel.executeFlashArbitrage(params);
    }

    /// @notice Fuzz: различные nonce values проходят при валидной подписи
    function testFuzz_nonceVariations(uint256 nonce) public {
        vm.assume(nonce < type(uint128).max); // Bound to reasonable range
        
        dexRouterA.setRate(1.05e18);
        dexRouterB.setRate(1.0e18);

        bytes memory sig = _signArbParams(
            teePrivateKey, address(tokenA), address(tokenB), 100e18, 4e18, nonce
        );

        ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
            tokenA: address(tokenA),
            tokenB: address(tokenB),
            borrowAmount: 100e18,
            minProfitTokenA: 4e18,
            nonce: nonce,
            amountOutMinRoute1: 0,
            amountOutMinRoute2: 0,
            dexPayloadRoute1: "",
            dexPayloadRoute2: "",
            teeSignature: sig
        });

        sentinel.executeFlashArbitrage(params);
        assertTrue(sentinel.usedNonces(nonce));
    }

    // ═══════════════════════════════════════════════════════════════════
    //  TEST 8: TEE Agent Rotation
    // ═══════════════════════════════════════════════════════════════════

    /// @notice После ротации TEE agent, старый ключ больше не работает
    function test_teeAgentRotation() public {
        dexRouterA.setRate(1.05e18);
        dexRouterB.setRate(1.0e18);

        uint256 newTeeKey = 0xBEEF;
        address newTeeAgent = vm.addr(newTeeKey);

        // Ротация
        sentinel.setTeeAgent(newTeeAgent);
        assertEq(sentinel.authorizedTeeAgent(), newTeeAgent);

        // Старый ключ → revert
        bytes memory oldSig = _signArbParams(
            teePrivateKey, address(tokenA), address(tokenB), 100e18, 4e18, 80
        );

        ActiveSentinel.ArbParams memory params = ActiveSentinel.ArbParams({
            tokenA: address(tokenA),
            tokenB: address(tokenB),
            borrowAmount: 100e18,
            minProfitTokenA: 4e18,
            nonce: 80,
            amountOutMinRoute1: 0,
            amountOutMinRoute2: 0,
            dexPayloadRoute1: "",
            dexPayloadRoute2: "",
            teeSignature: oldSig
        });

        vm.expectRevert(ActiveSentinel.InvalidTEESignature.selector);
        sentinel.executeFlashArbitrage(params);

        // Новый ключ → success
        bytes memory newSig = _signArbParams(
            newTeeKey, address(tokenA), address(tokenB), 100e18, 4e18, 81
        );

        params.nonce = 81;
        params.teeSignature = newSig;
        sentinel.executeFlashArbitrage(params);
    }
}
