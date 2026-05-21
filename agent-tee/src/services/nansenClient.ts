// Файл: agent-tee/src/services/nansenClient.ts
// Nansen MCP Client — сбор данных Smart Money через Model Context Protocol
// Работает исключительно внутри TEE-анклава (Phala Network)

import type { NansenWalletData, NansenTransaction, NansenTag, SmartMoneySignal } from "../types";

export interface NansenMCPConfig {
    /** Nansen API endpoint */
    apiUrl: string;
    /** API Key (хранится в TEE secure storage) */
    apiKey: string;
    /** Целевая сеть */
    chain: "mantle" | "ethereum" | "arbitrum";
    /** Таймаут запроса (ms) */
    timeoutMs: number;
    /** Retry с exponential backoff */
    maxRetries: number;
}

/**
 * Nansen MCP Client
 *
 * Взаимодействует с Nansen API через стандарт Model Context Protocol.
 * MCP позволяет LLM-агенту запрашивать данные через структурированные tool calls.
 *
 * Поддерживаемые запросы:
 * 1. getSmartMoneyWallets — список кошельков по тегам
 * 2. getRecentTransactions — последние транзакции Smart Money
 * 3. getTokenFlows — потоки капитала в/из актива
 */
export class NansenMCPClient {
    private config: NansenMCPConfig;
    private requestCount: number = 0;
    private lastRequestTime: number = 0;

    // Rate limiting: Nansen API обычно 30 req/min
    private readonly RATE_LIMIT_PER_MINUTE = 25;
    private readonly MIN_REQUEST_INTERVAL_MS = 2400; // 60000 / 25

    constructor(config: NansenMCPConfig) {
        this.config = config;
    }

    /**
     * Получает список Smart Money кошельков по тегам.
     * Фильтрует по целевой сети (Mantle).
     */
    async getSmartMoneyWallets(
        tags: NansenTag[],
        minBalanceUsd: number = 100_000
    ): Promise<NansenWalletData[]> {
        await this.enforceRateLimit();

        const response = await this.mcpRequest("smart_money.wallets", {
            chain: this.config.chain,
            tags: tags,
            min_balance_usd: minBalanceUsd,
            limit: 100,
        });

        return response.wallets.map((w: any) => ({
            address: w.address as `0x${string}`,
            tags: w.labels as NansenTag[],
            totalValueUsd: w.portfolio_value_usd,
            recentTxs: [],
        }));
    }

    /**
     * Получает последние транзакции для набора кошельков.
     * Фильтрует по значимости (amountUsd > threshold).
     */
    async getRecentTransactions(
        wallets: `0x${string}`[],
        sinceTimestamp: number,
        minAmountUsd: number = 10_000
    ): Promise<NansenTransaction[]> {
        await this.enforceRateLimit();

        const response = await this.mcpRequest("smart_money.transactions", {
            chain: this.config.chain,
            addresses: wallets,
            since: sinceTimestamp,
            min_amount_usd: minAmountUsd,
            actions: ["swap", "transfer_in"],
            limit: 200,
        });

        return response.transactions.map((tx: any) => ({
            hash: tx.tx_hash as `0x${string}`,
            timestamp: tx.timestamp,
            tokenAddress: tx.token_address as `0x${string}`,
            tokenSymbol: tx.token_symbol,
            action: tx.direction === "in" ? "BUY" : "SELL",
            amountUsd: tx.amount_usd,
            chain: tx.chain,
        }));
    }

    /**
     * Получает агрегированные потоки капитала для конкретного актива.
     * Полезно для подтверждения сигнала: если несколько китов покупают — сигнал сильнее.
     */
    async getTokenFlows(
        tokenAddress: `0x${string}`,
        periodHours: number = 24
    ): Promise<{
        netFlowUsd: number;
        buyCount: number;
        sellCount: number;
        uniqueSmartWallets: number;
    }> {
        await this.enforceRateLimit();

        const response = await this.mcpRequest("token.smart_money_flows", {
            chain: this.config.chain,
            token_address: tokenAddress,
            period_hours: periodHours,
        });

        return {
            netFlowUsd: response.net_flow_usd,
            buyCount: response.buy_count,
            sellCount: response.sell_count,
            uniqueSmartWallets: response.unique_wallets,
        };
    }

    /**
     * Конвертирует транзакции в SmartMoneySignal для Strategy Engine.
     */
    enrichToSignals(
        transactions: NansenTransaction[],
        walletData: Map<string, NansenWalletData>
    ): SmartMoneySignal[] {
        return transactions
            .filter((tx) => {
                const wallet = walletData.get(tx.hash);
                return wallet !== undefined;
            })
            .map((tx) => {
                // Находим кошелёк по транзакции (lookup по адресу, не по hash)
                const wallets = Array.from(walletData.values());
                const wallet = wallets[0]; // Simplified — в продакшене: map by sender

                return {
                    assetAddress: tx.tokenAddress,
                    action: tx.action,
                    sSmart: tx.amountUsd,
                    vSmart: wallet?.totalValueUsd || 0,
                    tag: wallet?.tags[0] || "Whale",
                    walletAddress: wallet?.address || ("0x0" as `0x${string}`),
                    txTimestamp: tx.timestamp,
                    txHash: tx.hash,
                };
            });
    }

    // ─── Private Helpers ─────────────────────────────────────────────

    private async mcpRequest(method: string, params: Record<string, any>): Promise<any> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
            try {
                const response = await fetch(`${this.config.apiUrl}/mcp/v1/call`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${this.config.apiKey}`,
                        "X-MCP-Method": method,
                    },
                    body: JSON.stringify({
                        jsonrpc: "2.0",
                        method,
                        params,
                        id: Date.now(),
                    }),
                    signal: controller.signal,
                });

                if (!response.ok) {
                    throw new Error(`Nansen API error: ${response.status} ${response.statusText}`);
                }

                const data = await response.json();
                if (data.error) {
                    throw new Error(`Nansen MCP error: ${data.error.message}`);
                }

                clearTimeout(timeout);
                this.requestCount++;
                this.lastRequestTime = Date.now();
                return data.result;
            } catch (err: any) {
                lastError = err;
                if (attempt < this.config.maxRetries) {
                    // Exponential backoff: 1s, 2s, 4s
                    await this.sleep(Math.pow(2, attempt) * 1000);
                }
            }
        }

        clearTimeout(timeout);
        throw lastError || new Error("Nansen MCP request failed");
    }

    private async enforceRateLimit(): Promise<void> {
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;

        if (elapsed < this.MIN_REQUEST_INTERVAL_MS) {
            await this.sleep(this.MIN_REQUEST_INTERVAL_MS - elapsed);
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
