// Файл: frontend/src/utils/sessionKeySetup.ts
// Инициализация Session Key для TEE-агента Active Sentinel
// Интеграция ZeroDev Kernel v3 + Session Key Validator

import { createPublicClient, http, parseAbiItem, toFunctionSelector, encodeFunctionData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createKernelAccountClient, createKernelAccount } from "@zerodev/sdk";
import { signerToSessionKeyValidator, ParamCondition } from "@zerodev/session-key";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { ENTRYPOINT_ADDRESS_V07 } from "permissionless";
import { mantle } from "../config/mantle";
import {
    SESSION_KEY_VALIDITY_SECONDS,
    GAS_LIMIT_PER_CALL,
    MAX_FEE_PER_GAS_WEI,
    BUNDLER_URL,
    PAYMASTER_URL,
} from "../config/constants";

// ABI для ActiveSentinel.executeFlashArbitrage
const ACTIVE_SENTINEL_ABI = [
    parseAbiItem(
        "function executeFlashArbitrage((address tokenA, address tokenB, uint256 borrowAmount, uint256 minProfitTokenA, uint256 amountOutMinRoute1, uint256 amountOutMinRoute2, bytes dexPayloadRoute1, bytes dexPayloadRoute2) params)"
    ),
    parseAbiItem("function rescue(address token, uint256 amount)"),
    parseAbiItem("function rescueNative()"),
] as const;

export interface SessionKeyResult {
    /** Приватный ключ сессии — передаётся в TEE-анклав */
    sessionPrivateKey: `0x${string}`;
    /** Адрес сессионного ключа */
    sessionAddress: `0x${string}`;
    /** Адрес смарт-аккаунта Kernel */
    kernelAddress: `0x${string}`;
    /** Время истечения (unix timestamp) */
    validUntil: number;
    /** Сериализованные данные для восстановления сессии агентом */
    serializedSession: string;
}

export interface SessionKeyConfig {
    /** Адрес развёрнутого ActiveSentinel */
    activeSentinelAddress: `0x${string}`;
    /** Время жизни ключа в секундах (по умолчанию 24ч) */
    validitySeconds?: number;
    /** Лимит газа на один вызов */
    gasLimitPerCall?: bigint;
    /** Максимальная цена газа (защита от газ-дрейна) */
    maxFeePerGas?: bigint;
}

/**
 * Создаёт сессионный ключ для TEE-агента со строгими политиками.
 *
 * Политики безопасности:
 * 1. Target Policy: ТОЛЬКО адрес ActiveSentinel
 * 2. Function Selector Policy: ТОЛЬКО executeFlashArbitrage (rescue, rescueNative заблокированы)
 * 3. Value Policy: valueLimit = 0 (запрет передачи MNT)
 * 4. Gas Policy: ограничение gasLimit и maxFeePerGas
 * 5. Time Policy: validUntil = now + 24h
 *
 * @param ownerPrivateKey Приватный ключ владельца (для подписи установки сессии)
 * @param config Конфигурация сессионного ключа
 */
export async function createSentinelSessionKey(
    ownerPrivateKey: `0x${string}`,
    config: SessionKeyConfig
): Promise<SessionKeyResult> {
    const {
        activeSentinelAddress,
        validitySeconds = SESSION_KEY_VALIDITY_SECONDS,
        gasLimitPerCall = GAS_LIMIT_PER_CALL,
        maxFeePerGas = MAX_FEE_PER_GAS_WEI,
    } = config;

    // ─── Public Client ───────────────────────────────────────────────
    const publicClient = createPublicClient({
        chain: mantle,
        transport: http(),
    });

    // ─── Owner Account ───────────────────────────────────────────────
    const ownerAccount = privateKeyToAccount(ownerPrivateKey);

    // ─── Owner Validator (ECDSA) ─────────────────────────────────────
    const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
        signer: ownerAccount,
        entryPoint: ENTRYPOINT_ADDRESS_V07,
    });

    // ─── Generate Session Key Pair (для TEE) ─────────────────────────
    const sessionPrivateKey = generatePrivateKey();
    const sessionSigner = privateKeyToAccount(sessionPrivateKey);

    // ─── Вычисляем временные границы ─────────────────────────────────
    const now = Math.floor(Date.now() / 1000);
    const validUntil = now + validitySeconds;
    const validAfter = now;

    // ─── Session Key Validator с жёсткими Policy ─────────────────────
    const sessionKeyValidator = await signerToSessionKeyValidator(publicClient, {
        signer: sessionSigner,
        entryPoint: ENTRYPOINT_ADDRESS_V07,
        validatorData: {
            // Временные границы
            validAfter,
            validUntil,
            // Строгие разрешения
            permissions: [
                {
                    // ТОЛЬКО контракт ActiveSentinel
                    target: activeSentinelAddress,
                    // ТОЛЬКО функция executeFlashArbitrage
                    abi: ACTIVE_SENTINEL_ABI,
                    functionName: "executeFlashArbitrage",
                    // Запрет на передачу нативного MNT
                    valueLimit: 0n,
                },
            ],
            // Ограничение газа (paymaster policies)
            paymaster: {
                // Лимит на callGasLimit для одного UserOp
                gasLimit: gasLimitPerCall,
                // Максимальная цена газа — защита от gas drain attack
                maxFeePerGas: maxFeePerGas,
            },
        },
    });

    // ─── Создание Kernel Account с Session Key ───────────────────────
    const kernelAccount = await createKernelAccount(publicClient, {
        entryPoint: ENTRYPOINT_ADDRESS_V07,
        plugins: {
            sudo: ecdsaValidator,
            regular: sessionKeyValidator,
        },
    });

    // ─── Сериализация для передачи в TEE ─────────────────────────────
    const serializedSession = JSON.stringify({
        sessionPrivateKey,
        kernelAddress: kernelAccount.address,
        activeSentinelAddress,
        validUntil,
        validAfter,
        chainId: mantle.id,
        entryPoint: ENTRYPOINT_ADDRESS_V07,
    });

    return {
        sessionPrivateKey,
        sessionAddress: sessionSigner.address,
        kernelAddress: kernelAccount.address,
        validUntil,
        serializedSession,
    };
}

/**
 * Создаёт Kernel Account Client для TEE-агента.
 * Используется агентом для отправки UserOperations через Bundler.
 *
 * @param sessionPrivateKey Приватный ключ сессии (из TEE secure storage)
 * @param kernelAddress Адрес смарт-аккаунта
 */
export async function createAgentClient(
    sessionPrivateKey: `0x${string}`,
    kernelAddress: `0x${string}`
) {
    const publicClient = createPublicClient({
        chain: mantle,
        transport: http(),
    });

    const sessionSigner = privateKeyToAccount(sessionPrivateKey);

    const sessionKeyValidator = await signerToSessionKeyValidator(publicClient, {
        signer: sessionSigner,
        entryPoint: ENTRYPOINT_ADDRESS_V07,
        validatorData: {
            // Validator восстанавливает permissions из on-chain state
            permissions: [],
        },
    });

    const kernelAccount = await createKernelAccount(publicClient, {
        entryPoint: ENTRYPOINT_ADDRESS_V07,
        address: kernelAddress,
        plugins: {
            regular: sessionKeyValidator,
        },
    });

    const kernelClient = createKernelAccountClient({
        account: kernelAccount,
        chain: mantle,
        entryPoint: ENTRYPOINT_ADDRESS_V07,
        bundlerTransport: http(BUNDLER_URL),
        middleware: {
            sponsorUserOperation: async ({ userOperation }) => {
                // Paymaster sponsorship (опционально, для gasless UX)
                // В продакшене: подключить ZeroDev Paymaster
                return userOperation;
            },
        },
    });

    return kernelClient;
}

/**
 * Ротация сессионного ключа.
 * Вызывается по расписанию (каждые 24ч) или при подозрении на компрометацию.
 *
 * @param ownerPrivateKey Ключ владельца
 * @param config Конфигурация
 * @returns Новый набор ключей
 */
export async function rotateSessionKey(
    ownerPrivateKey: `0x${string}`,
    config: SessionKeyConfig
): Promise<SessionKeyResult> {
    // Просто создаём новый ключ — старый автоматически истекает по validUntil
    // Для немедленной инвалидации: вызвать Kernel.disablePlugin(oldValidator)
    return createSentinelSessionKey(ownerPrivateKey, config);
}
