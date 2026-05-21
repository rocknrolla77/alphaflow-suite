// Файл: frontend/src/config/constants.ts
// Конфигурация сети Mantle и адреса контрактов

export const MANTLE_CHAIN_ID = 5000;
export const MANTLE_RPC_URL = "https://rpc.mantle.xyz";
export const MANTLE_TESTNET_RPC_URL = "https://rpc.sepolia.mantle.xyz";
export const MANTLE_TESTNET_CHAIN_ID = 5003;

// Bundler и Paymaster endpoints (ZeroDev)
export const ZERODEV_PROJECT_ID = process.env.ZERODEV_PROJECT_ID || "";
export const BUNDLER_URL = `https://rpc.zerodev.app/api/v2/bundler/${ZERODEV_PROJECT_ID}`;
export const PAYMASTER_URL = `https://rpc.zerodev.app/api/v2/paymaster/${ZERODEV_PROJECT_ID}`;

// Session Key Policies
export const SESSION_KEY_VALIDITY_SECONDS = 86400; // 24 часа
export const GAS_LIMIT_PER_CALL = 500_000n; // 500k gas max per UserOp
export const MAX_FEE_PER_GAS_WEI = 50_000_000_000n; // 50 gwei cap (Mantle обычно <1 gwei, это safety)
export const GAS_VAULT_LIMIT_MNT = 10n * 10n ** 18n; // 10 MNT total gas budget

// Контракты (заполняются после деплоя)
export const ACTIVE_SENTINEL_ADDRESS = process.env.ACTIVE_SENTINEL_ADDRESS as `0x${string}` || "0x0000000000000000000000000000000000000000";

// Селектор executeFlashArbitrage(ArbParams)
// keccak256("executeFlashArbitrage((address,address,uint256,uint256,uint256,uint256,bytes,bytes))")[:4]
export const EXECUTE_FLASH_ARB_SELECTOR = "0x" as `0x${string}`; // Вычисляется при деплое
