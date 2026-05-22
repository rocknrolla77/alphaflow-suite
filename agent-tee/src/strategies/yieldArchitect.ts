// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — agent-tee/src/strategies/yieldArchitect.ts
// Стратегический модуль TEE-агента: расчёт объёмов + EIP-712 подпись
// Phase 2: + Insight Hashing (Proof-of-Alpha)
// ═══════════════════════════════════════════════════════════════════════════════

import { ethers, type Wallet, type HDNodeWallet, type TypedDataDomain, type TypedDataField } from "ethers";
import type {
    SmartMoneySignal,
    UserRiskProfile,
    Proposal,
    SignedProposal,
} from "../types/index.js";

/**
 * EIP-712 Type Definitions для Proposal.
 * Используется ethers.Wallet.signTypedData для формирования подписи.
 */
const PROPOSAL_TYPES: Record<string, TypedDataField[]> = {
    Proposal: [
        { name: "asset", type: "address" },
        { name: "action", type: "string" },
        { name: "recommendedAmount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "reasoningHash", type: "bytes32" },
        { name: "insightHash", type: "bytes32" },
    ],
};

/**
 * YieldArchitect — стратегический движок TEE-агента.
 *
 * Обязанности:
 * 1. Расчёт объёма по формуле Smart Money Weight
 * 2. Валидация входных данных (bounds checking)
 * 3. Формирование reasoningHash (доказательство вычислимости)
 * 4. Формирование insightHash (детерминированный Proof-of-Alpha)
 * 5. EIP-712 подпись Proposal ключом анклава
 *
 * ИНВАРИАНТ: приватный ключ (this.signer) НИКОГДА не покидает этот класс.
 * Единственный экспортируемый артефакт — SignedProposal (данные + подпись).
 */
export class YieldArchitect {
    private readonly signer: Wallet | HDNodeWallet;
    private readonly domain: TypedDataDomain;
    private nonce: number;

    /**
     * @param signer — Wallet (in-memory ECDSA key, создан в main.ts)
     * @param chainId — ID цепи (5000 для Mantle mainnet)
     * @param initialNonce — начальное значение счётчика (из Redis при restart)
     */
    constructor(signer: Wallet | HDNodeWallet, chainId: number, initialNonce: number = 0) {
        this.signer = signer;
        this.nonce = initialNonce;

        this.domain = {
            name: "AlphaFlow_TEE",
            version: "1",
            chainId: chainId,
        };
    }

    /**
     * Публичный адрес TEE-signer.
     * Единственная информация о ключе, доступная извне.
     */
    public get signerAddress(): string {
        return this.signer.address;
    }

    /**
     * Текущий nonce (для мониторинга).
     */
    public get currentNonce(): number {
        return this.nonce;
    }

    /**
     * Расчёт рекомендуемого объёма по формуле Smart Money Weight.
     *
     * Формула:
     *   W = S_smart / V_smart           (conviction weight)
     *   S_user = V_user × W × K_risk    (user-scaled volume)
     *
     * Где:
     *   S_smart = объём сделки Smart Money (tradeVolume)
     *   V_smart = общий портфель Smart Money (totalPortfolioValue)
     *   V_user  = доступный баланс пользователя (availableBalance)
     *   K_risk  = коэффициент консерватизма [0.1, 1.0]
     *
     * @param signal — сигнал от Nansen MCP
     * @param profile — риск-профиль пользователя
     * @returns рекомендуемый объём в wei (bigint)
     * @throws Error если входные данные невалидны
     */
    public calculateVolume(signal: SmartMoneySignal, profile: UserRiskProfile): bigint {
        // ─── Валидация входных данных ─────────────────────────────────────
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

        // ─── Математика ──────────────────────────────────────────────────
        // W = S_smart / V_smart
        // Используем scaled arithmetic для сохранения precision:
        // W_scaled = (S_smart * PRECISION) / V_smart
        const PRECISION = 10n ** 18n;

        const wScaled: bigint = (signal.tradeVolume * PRECISION) / signal.totalPortfolioValue;

        // S_user = V_user × W × K_risk
        // K_risk нормализуем: 0.5 → 5000/10000
        const kRiskScaled: bigint = BigInt(Math.round(profile.riskCoefficient * 10000));
        const K_RISK_DENOMINATOR = 10000n;

        const recommendedAmount: bigint =
            (profile.availableBalance * wScaled * kRiskScaled) /
            (PRECISION * K_RISK_DENOMINATOR);

        // ─── Верхняя граница: не более 100% баланса ──────────────────────
        if (recommendedAmount > profile.availableBalance) {
            return profile.availableBalance;
        }

        // ─── Нижняя граница: отбрасываем dust (< 1000 wei) ──────────────
        if (recommendedAmount < 1000n) {
            throw new Error("SKIP: calculated amount below dust threshold (< 1000 wei)");
        }

        return recommendedAmount;
    }

    /**
     * Генерация reasoningHash — криптографическое доказательство того,
     * что рекомендация вычислена на основе конкретных входных данных.
     *
     * hash = keccak256(abi.encode(
     *   signal.walletAddress,
     *   signal.asset,
     *   signal.tradeVolume,
     *   signal.totalPortfolioValue,
     *   signal.detectedAt,
     *   profile.accountAddress,
     *   profile.availableBalance,
     *   profile.riskCoefficient_scaled,
     *   recommendedAmount
     * ))
     *
     * Любой аудитор может повторить вычисление и сверить хэш.
     */
    public computeReasoningHash(
        signal: SmartMoneySignal,
        profile: UserRiskProfile,
        recommendedAmount: bigint
    ): string {
        const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
            [
                "address",  // signal.walletAddress
                "address",  // signal.asset
                "uint256",  // signal.tradeVolume
                "uint256",  // signal.totalPortfolioValue
                "uint256",  // signal.detectedAt
                "address",  // profile.accountAddress
                "uint256",  // profile.availableBalance
                "uint256",  // profile.riskCoefficient (scaled to 10000)
                "uint256",  // recommendedAmount
            ],
            [
                signal.walletAddress,
                signal.asset,
                signal.tradeVolume,
                signal.totalPortfolioValue,
                signal.detectedAt,
                profile.accountAddress,
                profile.availableBalance,
                BigInt(Math.round(profile.riskCoefficient * 10000)),
                recommendedAmount,
            ]
        );

        return ethers.keccak256(encoded);
    }

    /**
     * Вычисление детерминированного insightHash для Proof-of-Alpha.
     *
     * Формула:
     *   insightHash = keccak256(abi.encode(
     *       ['address', 'string', 'uint256', 'uint256'],
     *       [asset, action, recommendedAmount, timestamp]
     *   ))
     *
     * ИНВАРИАНТ: хэш детерминирован — одинаковые входные данные = одинаковый хэш.
     * Это позволяет верифицировать on-chain коммит: subgraph/indexer может
     * воспроизвести хэш из данных proposal и сверить с event log.
     *
     * @param asset — адрес целевого актива (ERC-20)
     * @param action — действие ("BUY" или "SELL")
     * @param recommendedAmount — рекомендуемый объём (в wei)
     * @param timestamp — Unix timestamp генерации инсайта
     * @returns bytes32 hex-encoded keccak256 hash
     */
    public computeInsightHash(
        asset: string,
        action: string,
        recommendedAmount: bigint,
        timestamp: number
    ): string {
        const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "string", "uint256", "uint256"],
            [asset, action, recommendedAmount, BigInt(timestamp)]
        );

        return ethers.keccak256(encoded);
    }

    /**
     * Генерация и подпись Proposal.
     *
     * Полный pipeline:
     * 1. calculateVolume → рекомендуемый объём
     * 2. computeReasoningHash → доказательство вычислимости
     * 3. computeInsightHash → детерминированный Proof-of-Alpha hash
     * 4. EIP-712 signTypedData → подпись ключом анклава
     * 5. Инкремент nonce (monotonic, replay protection)
     *
     * ВАЖНО: insightHash и commitTxHash заполняются НА ЭТОМ этапе как placeholder.
     * Pipeline (main.ts) отвечает за:
     *   - on-chain commit insightHash → AlphaAuditor
     *   - получение commitTxHash
     *   - сборку финального SignedProposal
     *
     * @param signal — сигнал Smart Money от Nansen MCP
     * @param profile — риск-профиль пользователя
     * @param ttlSeconds — время жизни proposal (default 300 = 5 мин)
     * @param commitTxHash — hash tx коммита в AlphaAuditor (передаётся из pipeline)
     * @returns SignedProposal готовый к публикации в Redis
     */
    public async generateProposal(
        signal: SmartMoneySignal,
        profile: UserRiskProfile,
        ttlSeconds: number = 300,
        commitTxHash: `0x${string}` = "0x0000000000000000000000000000000000000000000000000000000000000000"
    ): Promise<SignedProposal> {
        // ─── Step 1: Расчёт объёма ───────────────────────────────────────
        const recommendedAmount = this.calculateVolume(signal, profile);

        // ─── Step 2: Reasoning Hash ─────────────────────────────────────
        const reasoningHash = this.computeReasoningHash(signal, profile, recommendedAmount);

        // ─── Step 3: Insight Hash (Proof-of-Alpha) ──────────────────────
        const timestamp = Math.floor(Date.now() / 1000);
        const insightHash = this.computeInsightHash(
            signal.asset,
            signal.action,
            recommendedAmount,
            timestamp
        );

        // ─── Step 4: Формирование Proposal ───────────────────────────────
        const currentNonce = this.nonce;
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

        // ─── Step 5: EIP-712 подпись ─────────────────────────────────────
        // signTypedData использует приватный ключ ТОЛЬКО в памяти.
        // Ключ никогда не сериализуется и не передаётся за пределы процесса.
        const signature = await this.signer.signTypedData(
            this.domain,
            PROPOSAL_TYPES,
            {
                asset: proposal.asset,
                action: proposal.action,
                recommendedAmount: proposal.recommendedAmount,
                nonce: proposal.nonce,
                deadline: proposal.deadline,
                reasoningHash: proposal.reasoningHash,
                insightHash: proposal.insightHash,
            }
        );

        // ─── Step 6: Инкремент nonce (монотонный, необратимый) ───────────
        this.nonce++;

        // ─── Step 7: Сборка SignedProposal ───────────────────────────────
        const signedProposal: SignedProposal = {
            ...proposal,
            signature: signature,
            signerAddress: this.signer.address,
            generatedAt: timestamp,
        };

        return signedProposal;
    }

    /**
     * Верификация подписи Proposal (статический метод).
     * Используется BFF и аудиторами для проверки без доступа к ключу.
     *
     * @param proposal — Proposal для верификации
     * @param signature — EIP-712 подпись (hex)
     * @param expectedSigner — ожидаемый адрес подписанта
     * @param chainId — ID цепи
     * @returns true если подпись валидна и принадлежит expectedSigner
     */
    public static verifyProposal(
        proposal: Proposal,
        signature: string,
        expectedSigner: string,
        chainId: number = 5000
    ): boolean {
        const domain: TypedDataDomain = {
            name: "AlphaFlow_TEE",
            version: "1",
            chainId: chainId,
        };

        const recoveredAddress = ethers.verifyTypedData(
            domain,
            PROPOSAL_TYPES,
            {
                asset: proposal.asset,
                action: proposal.action,
                recommendedAmount: proposal.recommendedAmount,
                nonce: proposal.nonce,
                deadline: proposal.deadline,
                reasoningHash: proposal.reasoningHash,
                insightHash: proposal.insightHash,
            },
            signature
        );

        return recoveredAddress.toLowerCase() === expectedSigner.toLowerCase();
    }
}
