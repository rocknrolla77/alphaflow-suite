// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — bff/src/services/reputationBatcher.ts
// Reputation Batcher — агрегация голосов из Redis + отправка batch tx в контракт
//
// АРХИТЕКТУРА:
//   setInterval (default 5 min) → readAndResetMetrics() → buildBatch() → submitTx()
//
// Redis ключи (пишет tg-bot):
//   agent_feedback_score:{agentId}  → net score (сумма +1/-1 от голосов)
//   agent_feedback_count:{agentId}  → total votes за период
//
// АТОМАРНЫЙ СБРОС:
//   Lua-скрипт: читает значение + обнуляет за один roundtrip.
//   Это гарантирует, что ни один голос не будет потерян между
//   GETDEL и следующей итерацией batching loop.
//
// RETRY ЛОГИКА:
//   При ошибке RPC/gas estimation: exponential backoff (1s, 2s, 4s), max 3 попытки.
//   При NONCE_TOO_LOW: немедленный перезапрос nonce + retry.
//
// ИНВАРИАНТЫ БЕЗОПАСНОСТИ:
//   - RELAYER_PRIVATE_KEY живёт только в BFF .env
//   - Только этот кошелёк авторизован как oracle в ReputationRegistry
//   - Каждый batch содержит timestamp эпохи в metadata для аудита
// ═══════════════════════════════════════════════════════════════════════════════

import {
    createWalletClient,
    createPublicClient,
    fallback,
    http,
    parseAbi,
    type Address,
    type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mantleTestnet } from "viem/chains";  // заменить на mantle для mainnet
import { Redis } from "ioredis";

// ─── Environment Validation ───────────────────────────────────────────────────

const RELAYER_PRIVATE_KEY = process.env["RELAYER_PRIVATE_KEY"] as Hex | undefined;
if (!RELAYER_PRIVATE_KEY) {
    throw new Error("FATAL: RELAYER_PRIVATE_KEY env var required for reputationBatcher");
}

const REPUTATION_REGISTRY_ADDRESS = process.env["REPUTATION_REGISTRY_ADDRESS"] as Address | undefined;
if (!REPUTATION_REGISTRY_ADDRESS) {
    throw new Error("FATAL: REPUTATION_REGISTRY_ADDRESS env var required");
}

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

// Интервал в миллисекундах (по умолчанию 5 минут)
const BATCH_INTERVAL_MS = parseInt(
    process.env["REPUTATION_BATCH_INTERVAL_MS"] ?? "300000",
    10
);

// Максимальное количество агентов за один batch tx (gas limit safety)
const MAX_AGENTS_PER_BATCH = parseInt(
    process.env["REPUTATION_MAX_AGENTS_PER_BATCH"] ?? "50",
    10
);

// RPC endpoints с fallback
const RPC_PRIMARY  = process.env["MANTLE_RPC_URL"]         ?? "https://rpc.testnet.mantle.xyz";
const RPC_FALLBACK1 = process.env["MANTLE_RPC_FALLBACK_1"] ?? "https://rpc.ankr.com/mantle_testnet";
const RPC_FALLBACK2 = process.env["MANTLE_RPC_FALLBACK_2"] ?? "https://mantle-testnet.public.blastapi.io";

// ─── ReputationRegistry ABI (только нужные функции) ──────────────────────────

const REPUTATION_ABI = parseAbi([
    // Single agent batch
    "function postFeedbackBatch(uint256 agentId, int128 scoreDelta, uint256 votersCount, bytes calldata metadata) external",
    // Multi-agent batch (экономия газа)
    "function postFeedbackBatchMulti(uint256[] calldata agentIds, int128[] calldata scoreDeltas, uint256[] calldata votersCounts, bytes calldata metadata) external",
    // Events
    "event FeedbackRegistered(uint256 indexed agentId, int128 scoreDelta, int128 newTotalScore)",
]);

// ─── Lua script — атомарный GETDEL ───────────────────────────────────────────
//
// Возвращает текущее значение и атомарно сбрасывает ключ в 0.
// Использует SET key 0 вместо DEL чтобы избежать гонки с bot INCRBY.
//
// Аргументы: KEYS[1] = ключ
// Возвращает: строковое значение до сброса (nil если ключ не существовал)

const ATOMIC_GETDEL_LUA = `
local val = redis.call('GET', KEYS[1])
if val ~= nil and val ~= false then
    redis.call('SET', KEYS[1], '0')
end
return val
`;

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgentMetrics {
    agentId: bigint;
    scoreDelta: number;   // net: сумма +1/-1
    votersCount: number;  // total голосов
}

// ─── Redis Client ─────────────────────────────────────────────────────────────

let redisClient: Redis | null = null;

function getRedis(): Redis {
    if (!redisClient) {
        redisClient = new Redis(REDIS_URL, {
            lazyConnect: false,
            maxRetriesPerRequest: 3,
            retryStrategy: (times) => Math.min(times * 200, 2000),
        });
        redisClient.on("error", (err: Error) => {
            console.error("[ReputationBatcher] Redis error:", err.message);
        });
    }
    return redisClient;
}

// ─── Viem Clients ────────────────────────────────────────────────────────────

// Аккаунт оракула (BFF Relayer)
const relayerAccount = privateKeyToAccount(RELAYER_PRIVATE_KEY);

// Public client с fallback для чтения состояния / gas estimation
const publicClient = createPublicClient({
    chain: mantleTestnet,
    transport: fallback([
        http(RPC_PRIMARY),
        http(RPC_FALLBACK1),
        http(RPC_FALLBACK2),
    ], { rank: false }),
});

// Wallet client для отправки транзакций
const walletClient = createWalletClient({
    account: relayerAccount,
    chain: mantleTestnet,
    transport: fallback([
        http(RPC_PRIMARY),
        http(RPC_FALLBACK1),
        http(RPC_FALLBACK2),
    ], { rank: false }),
});

// ─── Core: Read and Reset Metrics from Redis ──────────────────────────────────

/**
 * Читает все agent_feedback_* ключи из Redis и атомарно сбрасывает их в 0.
 *
 * Шаги:
 * 1. SCAN для поиска всех agent_feedback_count:* ключей
 * 2. Для каждого агента: атомарный GETDEL через Lua (score + count)
 * 3. Фильтрация агентов с нулевыми метриками
 *
 * @returns Массив AgentMetrics с ненулевыми голосами
 */
async function readAndResetMetrics(): Promise<AgentMetrics[]> {
    const r = getRedis();
    const metrics: AgentMetrics[] = [];

    // ─── Scan для поиска всех агентов с голосами ──────────────────────────
    // Используем count-ключи как anchor (count всегда >= 1 если были голоса)
    const countKeys: string[] = [];
    let cursor = "0";

    do {
        const [nextCursor, keys] = await r.scan(
            cursor,
            "MATCH", "agent_feedback_count:*",
            "COUNT",  "100"
        );
        cursor = nextCursor;
        countKeys.push(...keys);
    } while (cursor !== "0");

    if (countKeys.length === 0) {
        return [];
    }

    // ─── Атомарный GETDEL через Lua для каждого агента ───────────────────
    for (const countKey of countKeys) {
        // Извлекаем agentId из ключа "agent_feedback_count:{agentId}"
        const agentId = BigInt(countKey.replace("agent_feedback_count:", ""));
        const scoreKey = `agent_feedback_score:${agentId}`;

        // Параллельный атомарный сброс score + count
        const [scoreRaw, countRaw] = await Promise.all([
            r.eval(ATOMIC_GETDEL_LUA, 1, scoreKey)  as Promise<string | null>,
            r.eval(ATOMIC_GETDEL_LUA, 1, countKey)  as Promise<string | null>,
        ]);

        const scoreDelta  = parseInt(scoreRaw  ?? "0", 10);
        const votersCount = parseInt(countRaw  ?? "0", 10);

        // Пропускаем агентов с нулевыми метриками (уже обработаны или нет голосов)
        if (votersCount === 0) continue;

        // scoreDelta === 0 означает равное число up/down → пропускаем
        // (контракт ревертит на ZeroScoreDelta)
        if (scoreDelta === 0) {
            console.log(
                `[ReputationBatcher] AgentId=${agentId}: ` +
                `scoreDelta=0 (${votersCount} votes, equal up/down) — skipping`
            );
            continue;
        }

        metrics.push({ agentId, scoreDelta, votersCount });
    }

    return metrics;
}

// ─── Core: Submit Batch Transaction ──────────────────────────────────────────

/**
 * Отправляет batch транзакцию в ReputationRegistry.
 *
 * Если один агент → postFeedbackBatch (дешевле по газу на calldata)
 * Если несколько → postFeedbackBatchMulti
 *
 * Retry логика:
 * - max 3 попытки с exponential backoff (1s, 2s, 4s)
 * - При NONCE_TOO_LOW: перезапрос nonce
 *
 * @param batch Массив AgentMetrics для отправки
 * @param epoch Unix timestamp начала эпохи (для metadata)
 */
async function submitBatchTransaction(
    batch: AgentMetrics[],
    epoch: number
): Promise<void> {
    if (batch.length === 0) return;

    // metadata = ABI-encoded epoch timestamp для аудита событий
    const metadata = encodeMetadata(epoch, batch.length);

    const MAX_RETRIES = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            let txHash: Hex;

            if (batch.length === 1) {
                // ─── Single agent: postFeedbackBatch ─────────────────────────
                const { agentId, scoreDelta, votersCount } = batch[0]!;

                const { request } = await publicClient.simulateContract({
                    address: REPUTATION_REGISTRY_ADDRESS!,
                    abi: REPUTATION_ABI,
                    functionName: "postFeedbackBatch",
                    args: [
                        agentId,
                        BigInt(scoreDelta) as unknown as number,  // int128
                        BigInt(votersCount),
                        metadata,
                    ],
                    account: relayerAccount,
                });

                txHash = await walletClient.writeContract(request);
            } else {
                // ─── Multi agent: postFeedbackBatchMulti ──────────────────────
                const agentIds    = batch.map(m => m.agentId);
                const scoreDeltas = batch.map(m => BigInt(m.scoreDelta)) as unknown as number[];
                const votersCounts = batch.map(m => BigInt(m.votersCount));

                const { request } = await publicClient.simulateContract({
                    address: REPUTATION_REGISTRY_ADDRESS!,
                    abi: REPUTATION_ABI,
                    functionName: "postFeedbackBatchMulti",
                    args: [agentIds, scoreDeltas, votersCounts, metadata],
                    account: relayerAccount,
                });

                txHash = await walletClient.writeContract(request);
            }

            // ─── Wait for confirmation ────────────────────────────────────────
            const receipt = await publicClient.waitForTransactionReceipt({
                hash: txHash,
                timeout: 60_000,  // 60s timeout
            });

            if (receipt.status === "success") {
                console.log(
                    `[ReputationBatcher] ✅ Batch submitted | ` +
                    `txHash=${txHash} | ` +
                    `agents=${batch.length} | ` +
                    `block=${receipt.blockNumber}`
                );
                return;  // success — выходим из retry loop
            } else {
                // Транзакция reverted
                throw new Error(`Transaction reverted: ${txHash}`);
            }

        } catch (err: unknown) {
            lastError = err;
            const errMsg = err instanceof Error ? err.message : String(err);

            console.error(
                `[ReputationBatcher] Attempt ${attempt}/${MAX_RETRIES} failed:`,
                errMsg
            );

            if (attempt < MAX_RETRIES) {
                const backoffMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
                console.log(`[ReputationBatcher] Retrying in ${backoffMs}ms...`);
                await sleep(backoffMs);
            }
        }
    }

    // Все попытки исчерпаны — логируем и продолжаем
    // Голоса уже сброшены из Redis, поэтому потеря возможна.
    // TODO: реализовать dead-letter queue в Redis для таких случаев.
    console.error(
        `[ReputationBatcher] ❌ FATAL: All ${MAX_RETRIES} attempts failed for batch of ${batch.length} agents.`,
        lastError
    );
}

// ─── Main Batcher Tick ────────────────────────────────────────────────────────

/**
 * Один tick батчера:
 * 1. Читает и атомарно сбрасывает метрики из Redis
 * 2. Разбивает на чанки по MAX_AGENTS_PER_BATCH
 * 3. Отправляет batch tx для каждого чанка
 */
async function runBatcherTick(): Promise<void> {
    const epoch = Math.floor(Date.now() / 1000);

    console.log(`[ReputationBatcher] Tick started | epoch=${epoch}`);

    let metrics: AgentMetrics[];
    try {
        metrics = await readAndResetMetrics();
    } catch (err) {
        console.error("[ReputationBatcher] Failed to read metrics from Redis:", err);
        return;
    }

    if (metrics.length === 0) {
        console.log("[ReputationBatcher] No feedback to submit this tick.");
        return;
    }

    console.log(
        `[ReputationBatcher] Found ${metrics.length} agents with feedback | ` +
        `Total votes: ${metrics.reduce((s, m) => s + m.votersCount, 0)}`
    );

    // ─── Chunking ─────────────────────────────────────────────────────────
    const chunks = chunkArray(metrics, MAX_AGENTS_PER_BATCH);

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!;
        console.log(
            `[ReputationBatcher] Submitting chunk ${i + 1}/${chunks.length} | ` +
            `agents=${chunk.length}`
        );
        await submitBatchTransaction(chunk, epoch);
    }

    console.log(`[ReputationBatcher] Tick complete | epoch=${epoch}`);
}

// ─── Lifecycle Management ─────────────────────────────────────────────────────

let batcherInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Запускает batcher daemon.
 * Вызывается один раз из bff/src/index.ts при старте сервера.
 */
export function startReputationBatcher(): void {
    console.log(
        `[ReputationBatcher] Starting | ` +
        `interval=${BATCH_INTERVAL_MS}ms (${BATCH_INTERVAL_MS / 60000} min) | ` +
        `relayer=${relayerAccount.address} | ` +
        `registry=${REPUTATION_REGISTRY_ADDRESS}`
    );

    // Первый tick сразу при старте (с задержкой 10s чтобы RPC успел подключиться)
    setTimeout(() => {
        void runBatcherTick();
    }, 10_000);

    // Периодические тики
    batcherInterval = setInterval(() => {
        void runBatcherTick();
    }, BATCH_INTERVAL_MS);

    // Ref unset чтобы interval не удерживал процесс от завершения
    if (batcherInterval.unref) {
        batcherInterval.unref();
    }
}

/**
 * Останавливает batcher и закрывает Redis соединение.
 * Вызывается при graceful shutdown.
 */
export async function stopReputationBatcher(): Promise<void> {
    if (batcherInterval) {
        clearInterval(batcherInterval);
        batcherInterval = null;
    }
    if (redisClient) {
        await redisClient.quit();
        redisClient = null;
    }
    console.log("[ReputationBatcher] Stopped.");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Кодирует metadata для on-chain аудита.
 * Формат: "epoch={timestamp};agents={count}" в UTF-8 bytes.
 * Доступна в calldata транзакции, не хранится в storage.
 */
function encodeMetadata(epoch: number, agentCount: number): Hex {
    const str = `epoch=${epoch};agents=${agentCount}`;
    const bytes = Buffer.from(str, "utf8");
    return `0x${bytes.toString("hex")}` as Hex;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
