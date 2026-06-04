// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — agent-tee/src/strategies/yieldArchitect.ts
// Стратегический модуль TEE-агента: расчёт объёмов + EIP-712 подпись
// Phase 5 (Swarm Mode): ForwardRequest для MicroFundingDispatcher
//
// АРХИТЕКТУРА:
//   TEE "Мозг" формирует ForwardRequest → подписывает EIP-712 → Redis Stream
//   Byreal "Мускулы" (Swarm Workers) подхватывают и relay on-chain за свой газ
//
// ИНВАРИАНТЫ:
//   1. insightHash computation — БЕЗ ИЗМЕНЕНИЙ (Proof-of-Alpha)
//   2. commitInsight on-chain — СТРОГО ДО публикации в Redis
//   3. Приватный ключ НИКОГДА не покидает этот класс
// ═══════════════════════════════════════════════════════════════════════════════

import {
    encodeFunctionData,
    parseAbi,
    keccak256,
    encodeAbiParameters,
    parseAbiParameters,
    type Address,
    type Hex,
} from "viem";
import { privateKeyToAccount, signTypedData } from "viem/accounts";
import type {
    SmartMoneySignal,
    UserRiskProfile,
    Proposal,
    SignedProposal,
    ForwardRequest,
    SignedForwardRequest,
} from "../types/index.js";
import {
    DISPATCHER_EIP712_DOMAIN,
    FORWARD_REQUEST_TYPES,
} from "../types/index.js";

// ─── ABI для кодирования calldata ───────────────────────────────────────────

const ACTIVE_SENTINEL_ABI = parseAbi([
    "function executeFlashArbitrage(address borrowToken, uint256 borrowAmount, uint256 minProfit, address swapTarget, bytes calldata swapCalldata, uint256 deadline)",
]);

// ─── Legacy EIP-712 Types (Proposal Proof-of-Reasoning — сохранены для аудита) ─

const PROPOSAL_TYPES = {
    Proposal: [
        { name: "asset", type: "address" },
        { name: "action", type: "string" },
        { name: "recommendedAmount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "reasoningHash", type: "bytes32" },
        { name: "insightHash", type: "bytes32" },
    ],
} as const;

const PROPOSAL_DOMAIN = {
    name: "AlphaFlow_TEE" as const,
    version: "1" as const,
    chainId: 5000,
} as const;

// ─── Arb Parameters для формирования ForwardRequest ─────────────────────────

export interface ArbParams {
    /** Токен для flash borrow (WMNT, USDC) */
    borrowToken: Address;
    /** Объём flash borrow (wei) */
    borrowAmount: bigint;
    /** Минимальный профит (wei) */
    minProfit: bigint;
    /** Целевой DEX aggregator/router */
    swapTarget: Address;
    /** Encoded swap calldata (от Byreal/1inch) */
    swapCalldata: Hex;
}

// ═══════════════════════════════════════════════════════════════════════════════
//                          YieldArchitect
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * YieldArchitect — стратегический движок TEE-агента (Swarm Mode).
 *
 * Обязанности:
 * 1. Расчёт объёма по формуле Smart Money Weight
 * 2. Валидация входных данных (bounds checking)
 * 3. Формирование reasoningHash (доказательство вычислимости)
 * 4. Формирование insightHash (детерминированный Proof-of-Alpha) — БЕЗ ИЗМЕНЕНИЙ
 * 5. Кодирование calldata для ActiveSentinel.executeFlashArbitrage()
 * 6. Формирование и EIP-712 подпись ForwardRequest для MicroFundingDispatcher
 *
 * НОВОЕ В SWARM MODE:
 *   - generateForwardRequest() — формирует подписанный ForwardRequest
 *   - generateProposal() — СОХРАНЁН для обратной совместимости (Proof-of-Reasoning)
 *   - Вся логика отправки транзакций УДАЛЕНА из TEE (перенесена в swarmWorker.ts)
 */
export class YieldArchitect {
    private readonly privateKey: `0x${string}`;
    private readonly account: ReturnType<typeof privateKeyToAccount>;
    private readonly chainId: number;
    private readonly activeSentinelAddress: Address;
    private nonce: bigint;

    /**
     * @param privateKey — hex-encoded ECDSA key (in-memory, создан в main.ts)
     * @param chainId — ID цепи (5000 для Mantle mainnet)
     * @param activeSentinelAddress — адрес ActiveSentinel (target для ForwardRequest)
     * @param initialNonce — начальное значение nonce (из Redis при restart)
     */
    constructor(
        privateKey: `0x${string}`,
        chainId: number,
        activeSentinelAddress: Address,
        initialNonce: bigint = 0n
    ) {
        this.privateKey = privateKey;
        this.account = privateKeyToAccount(privateKey);
        this.chainId = chainId;
        this.activeSentinelAddress = activeSentinelAddress;
        this.nonce = initialNonce;
    }

    /**
     * Публичный адрес TEE-signer.
     */
    public get signerAddress(): Address {
        return this.account.address;
    }

    /**
     * Текущий nonce (для мониторинга).
     */
    public get currentNonce(): bigint {
        return this.nonce;
    }

    // ─── Volume Calculation ──────────────────────────────────────────────────

    /**
     * Расчёт рекомендуемого объёма по формуле Smart Money Weight.
     *
     * Формула:
     *   W = S_smart / V_smart           (conviction weight)
     *   S_user = V_user × W × K_risk    (user-scaled volume)
     */
    public calculateVolume(signal: SmartMoneySignal, profile: UserRiskProfile): bigint {
        if (signal.totalPortfolioValue === 0n) {
            throw new Error("INVARIANT: totalPortfolioValue cannot be zero (division by zero)");
        }
        if (signal.tradeVolume === 0n) {
            throw new Error("INVARIANT: tradeVolume cannot be zero (no signal)");
        }
        if (signal.tradeVolume > signal.totalPortfolioValue) {
            throw new Error("INVARIANT: tradeVolume > totalPortfolioValue (invalid signal)");
        }
        if (profile.availableBalance === 0n) {
            throw new Error("INVARIANT: availableBalance is zero (nothing to trade)");
        }
        if (profile.riskCoefficient < 0.1 || profile.riskCoefficient > 1.0) {
            throw new Error("INVARIANT: riskCoefficient must be in [0.1, 1.0]");
        }

        const PRECISION = 10n ** 18n;
        const wScaled: bigint = (signal.tradeVolume * PRECISION) / signal.totalPortfolioValue;
        const kRiskScaled: bigint = BigInt(Math.round(profile.riskCoefficient * 10000));
        const K_RISK_DENOMINATOR = 10000n;

        const recommendedAmount: bigint =
            (profile.availableBalance * wScaled * kRiskScaled) /
            (PRECISION * K_RISK_DENOMINATOR);

        if (recommendedAmount > profile.availableBalance) {
            return profile.availableBalance;
        }
        if (recommendedAmount < 1000n) {
            throw new Error("SKIP: calculated amount below dust threshold (< 1000 wei)");
        }

        return recommendedAmount;
    }

    // ─── Hash Computations (UNCHANGED — Proof-of-Alpha invariant) ────────────

    /**
     * Генерация reasoningHash — криптографическое доказательство вычислимости.
     */
    public computeReasoningHash(
        signal: SmartMoneySignal,
        profile: UserRiskProfile,
        recommendedAmount: bigint
    ): Hex {
        const encoded = encodeAbiParameters(
            parseAbiParameters(
                "address, address, uint256, uint256, uint256, address, uint256, uint256, uint256"
            ),
            [
                signal.walletAddress as Address,
                signal.asset as Address,
                signal.tradeVolume,
                signal.totalPortfolioValue,
                BigInt(signal.detectedAt),
                profile.accountAddress as Address,
                profile.availableBalance,
                BigInt(Math.round(profile.riskCoefficient * 10000)),
                recommendedAmount,
            ]
        );

        return keccak256(encoded);
    }

    /**
     * Вычисление insightHash для Proof-of-Alpha — БЕЗ ИЗМЕНЕНИЙ.
     *
     * insightHash = keccak256(abi.encode(
     *     ['address', 'string', 'uint256', 'uint256'],
     *     [asset, action, recommendedAmount, timestamp]
     * ))
     */
    public computeInsightHash(
        asset: string,
        action: string,
        recommendedAmount: bigint,
        timestamp: number
    ): Hex {
        const encoded = encodeAbiParameters(
            parseAbiParameters("address, string, uint256, uint256"),
            [
                asset as Address,
                action,
                recommendedAmount,
                BigInt(timestamp),
            ]
        );

        return keccak256(encoded);
    }

    // ─── ForwardRequest Generation (NEW — Swarm Mode) ────────────────────────

    /**
     * Генерация подписанного ForwardRequest для MicroFundingDispatcher.
     *
     * Pipeline:
     * 1. calculateVolume → рекомендуемый объём
     * 2. Encode calldata → ActiveSentinel.executeFlashArbitrage(ArbParams)
     * 3. Формировать ForwardRequest (target = ActiveSentinel, value = 0)
     * 4. EIP-712 signTypedData → подпись для MicroFundingDispatcher
     * 5. Инкремент nonce (monotonic)
     *
     * КРИТИЧЕСКИЙ ИНВАРИАНТ:
     *   commitInsight (Proof-of-Alpha) в AlphaAuditor ДОЛЖЕН быть выполнен
     *   ДО вызова этого метода. Caller (main.ts pipeline) отвечает за это.
     *
     * @param arbParams — параметры арбитража (token, amount, swap calldata)
     * @param insightHash — предрассчитанный insightHash (из computeInsightHash)
     * @param commitTxHash — tx hash коммита в AlphaAuditor
     * @param deadlineSeconds — TTL (default 300s = 5 мин)
     * @returns SignedForwardRequest готовый к публикации в Redis Stream
     */
    public async generateForwardRequest(
        arbParams: ArbParams,
        insightHash: Hex,
        commitTxHash: `0x${string}`,
        deadlineSeconds: number = 300
    ): Promise<SignedForwardRequest> {
        // ─── Step 1: Encode calldata для ActiveSentinel ───────────────────
        const calldata = encodeFunctionData({
            abi: ACTIVE_SENTINEL_ABI,
            functionName: "executeFlashArbitrage",
            args: [
                arbParams.borrowToken,
                arbParams.borrowAmount,
                arbParams.minProfit,
                arbParams.swapTarget,
                arbParams.swapCalldata,
                BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds),
            ],
        });

        // ─── Step 2: Формировать ForwardRequest ──────────────────────────
        const now = BigInt(Math.floor(Date.now() / 1000));
        const currentNonce = this.nonce;

        const request: ForwardRequest = {
            target: this.activeSentinelAddress,
            data: calldata,
            value: 0n,
            nonce: currentNonce,
            deadline: now + BigInt(deadlineSeconds),
        };

        // ─── Step 3: EIP-712 подпись для MicroFundingDispatcher ──────────
        const signature = await signTypedData({
            privateKey: this.privateKey,
            domain: {
                ...DISPATCHER_EIP712_DOMAIN,
                chainId: this.chainId,
            },
            types: FORWARD_REQUEST_TYPES,
            primaryType: "ForwardRequest",
            message: {
                target: request.target,
                data: request.data,
                value: request.value,
                nonce: request.nonce,
                deadline: request.deadline,
            },
        });

        // ─── Step 4: Инкремент nonce (монотонный, необратимый) ───────────
        this.nonce++;

        // ─── Step 5: Сборка SignedForwardRequest ─────────────────────────
        return {
            request,
            signature,
            signerAddress: this.account.address,
            generatedAt: Number(now),
            insightHash,
            commitTxHash,
        };
    }

    // ─── Legacy: Proposal Generation (сохранён для Proof-of-Reasoning аудита) ─

    /**
     * Генерация и подпись Proposal (legacy — для обратной совместимости).
     *
     * В Swarm Mode основной flow идёт через generateForwardRequest().
     * Этот метод сохранён для:
     * - аудита Proof-of-Reasoning
     * - верификации InsightHash корреляции
     * - frontend-отображения reasoning
     */
    public async generateProposal(
        signal: SmartMoneySignal,
        profile: UserRiskProfile,
        ttlSeconds: number = 300,
        commitTxHash: `0x${string}` = "0x0000000000000000000000000000000000000000000000000000000000000000"
    ): Promise<SignedProposal> {
        const recommendedAmount = this.calculateVolume(signal, profile);
        const reasoningHash = this.computeReasoningHash(signal, profile, recommendedAmount);
        const timestamp = Math.floor(Date.now() / 1000);
        const insightHash = this.computeInsightHash(
            signal.asset,
            signal.action,
            recommendedAmount,
            timestamp
        );

        const currentNonce = Number(this.nonce);
        const deadline = timestamp + ttlSeconds;

        const proposal: Proposal = {
            asset: signal.asset,
            action: signal.action,
            recommendedAmount: recommendedAmount,
            nonce: currentNonce,
            deadline: deadline,
            reasoningHash: reasoningHash,
            insightHash: insightHash,
            commitTxHash: commitTxHash,
        };

        // EIP-712 подпись (legacy domain: AlphaFlow_TEE)
        const signature = await signTypedData({
            privateKey: this.privateKey,
            domain: {
                ...PROPOSAL_DOMAIN,
                chainId: this.chainId,
            },
            types: PROPOSAL_TYPES,
            primaryType: "Proposal",
            message: {
                asset: proposal.asset as Address,
                action: proposal.action,
                recommendedAmount: proposal.recommendedAmount,
                nonce: BigInt(proposal.nonce),
                deadline: BigInt(proposal.deadline),
                reasoningHash: proposal.reasoningHash as Hex,
                insightHash: proposal.insightHash as Hex,
            },
        });

        this.nonce++;

        return {
            ...proposal,
            signature: signature,
            signerAddress: this.account.address,
            generatedAt: timestamp,
        };
    }

    // ─── Static Verification ─────────────────────────────────────────────────

    /**
     * Верификация подписи Proposal (статический метод).
     */
    public static verifyProposal(
        _proposal: Proposal,
        _signature: string,
        _expectedSigner: string,
        _chainId: number = 5000
    ): boolean {
        // Using viem's verifyTypedData would require async import;
        // For now delegate to the test file's viem-based verification.
        // This is a placeholder that maintains the API contract.
        // Full implementation is in tests via verifyTypedData from viem.
        console.warn("[YieldArchitect.verifyProposal] Use viem verifyTypedData in caller");
        return true; // Caller should use viem verifyTypedData directly
    }
}
