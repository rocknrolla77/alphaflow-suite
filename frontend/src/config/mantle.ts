// Файл: frontend/src/config/mantle.ts
// Определение цепочки Mantle для viem

import { defineChain } from "viem";

export const mantle = defineChain({
    id: 5000,
    name: "Mantle",
    nativeCurrency: {
        name: "Mantle",
        symbol: "MNT",
        decimals: 18,
    },
    rpcUrls: {
        default: {
            http: ["https://rpc.mantle.xyz"],
        },
    },
    blockExplorers: {
        default: {
            name: "Mantlescan",
            url: "https://mantlescan.xyz",
        },
    },
});

export const mantleTestnet = defineChain({
    id: 5003,
    name: "Mantle Sepolia",
    nativeCurrency: {
        name: "Mantle",
        symbol: "MNT",
        decimals: 18,
    },
    rpcUrls: {
        default: {
            http: ["https://rpc.sepolia.mantle.xyz"],
        },
    },
    blockExplorers: {
        default: {
            name: "Mantlescan Sepolia",
            url: "https://sepolia.mantlescan.xyz",
        },
    },
    testnet: true,
});
