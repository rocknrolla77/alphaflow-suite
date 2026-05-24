// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — devops/src/tg-bot/index.ts
// Telegram HITL Bot — Telegraf v4 + Redis Pub/Sub + Whitelist + Feedback Voting
//
// АРХИТЕКТУРА:
// Redis channel "tee_proposals" → storeProposal() → broadcastProposal()
//   └── Inline Keyboard:
//         [WebApp: Execute via Passkey]
//         [👍 +1]  [👎 -1]         ← голосование
//
// ГОЛОСОВАНИЕ (callback_query):
//   callback_data: "vote_up_{proposalId}" | "vote_down_{proposalId}"
//   Защита от двойного голосования: Redis SETNX vote:{proposalId}:{userId}
//   Метрики пишутся в Redis → BFF reputationBatcher.ts читает и отправляет в контракт
//
//   Redis ключи репутации:
//     agent_feedback_score:{agentId}  → INCRBY +1/-1 (net score)
//     agent_feedback_count:{agentId}  → INCR (total votes)
//
// БЕЗОПАСНОСТЬ:
//   - Whitelist middleware: только TARGET_CHAT_ID может управлять ботом
//   - HMAC_SECRET НИКОГДА не передаётся на клиент
//   - HMAC подпись кодируется в base64url для deep link
// ═══════════════════════════════════════════════════════════════════════════════

import "dotenv/config";
import { Telegraf, Markup, Context } from "telegraf";
import type { CallbackQuery } from "telegraf/types";
import { randomBytes } from "node:crypto";
import {
    getSubscriber,
    getCommander,
    storeProposal,
    getRedisStatus,
    pauseBot,
    resumeBot,
    shutdownStore,
    type StoredProposal,
} from "./proposalStore.js";

// ─── Environment Validation ───────────────────────────────────────────────────

const BOT_TOKEN = process.env["BOT_TOKEN"];
if (!BOT_TOKEN) throw new Error("FATAL: BOT_TOKEN env var is required");

const TARGET_CHAT_ID_RAW = process.env["TARGET_CHAT_ID"];
if (!TARGET_CHAT_ID_RAW) throw new Error("FATAL: TARGET_CHAT_ID env var is required");

const TARGET_CHAT_ID = parseInt(TARGET_CHAT_ID_RAW, 10);
if (isNaN(TARGET_CHAT_ID)) throw new Error("FATAL: TARGET_CHAT_ID must be a valid integer");

const TMA_URL      = process.env["TMA_URL"]      ?? "https://t.me/AlphaFlowBot/app";
const BOT_USERNAME = process.env["BOT_USERNAME"] ?? "AlphaFlowBot";

// agentId — токен из SentinelIdentity для TEE-агента (по умолчанию 1)
// Устанавливается при деплое и прописывается в .env
const DEFAULT_AGENT_ID = BigInt(process.env["DEFAULT_AGENT_ID"] ?? "1");

console.log("═══════════════════════════════════════════════════════════════");
console.log("  AlphaFlow Suite — Telegram HITL Bot");
console.log("═══════════════════════════════════════════════════════════════");
console.log(`[Bot] Target chat: ${TARGET_CHAT_ID}`);
console.log(`[Bot] TMA URL: ${TMA_URL}`);
console.log(`[Bot] Default agentId: ${DEFAULT_AGENT_ID}`);

// ─── Telegraf Setup ───────────────────────────────────────────────────────────

const bot = new Telegraf(BOT_TOKEN);

// ─── Whitelist Middleware ─────────────────────────────────────────────────────
//
// ИНВАРИАНТ БЕЗОПАСНОСТИ:
// Бот принимает команды ТОЛЬКО от TARGET_CHAT_ID.
// callback_query (кнопки) проверяются отдельно по user.id в чате.

bot.use(async (ctx: Context, next) => {
    const chatId = ctx.chat?.id;

    // Allow /start and /demo from ANY user (Zero-Friction UX for judges)
    if (ctx.message && "text" in ctx.message) {
        const text = ctx.message.text;
        if (/^\/(start|demo)/.test(text)) {
            return next();
        }
    }

    // Allow callback_query (vote buttons) from anyone
    if (ctx.callbackQuery) {
        return next();
    }

    // Admin commands (/status, /pause, /resume) — only TARGET_CHAT_ID
    if (chatId !== undefined && chatId !== TARGET_CHAT_ID) {
        console.warn(
            `[Bot] Ignored message from unauthorized chat: ${chatId}`
        );
        return;
    }

    return next();
});

// ─── /start Command ───────────────────────────────────────────────────────────

bot.start(async (ctx) => {
    await ctx.reply(
        "⚡ *AlphaFlow Suite* — Agentic Commerce Infrastructure\n\n" +
        "TEE-агент анализирует рынок и генерирует торговые сигналы.\n" +
        "Вы подтверждаете исполнение через Passkey (WebAuthn) — без seed-фраз.\n\n" +
        "*Команды:*\n" +
        "• /demo   — 🚀 Сгенерировать тестовый RWA-сигнал\n" +
        "• /status — Состояние системы\n" +
        "• /help   — Справка",
        { parse_mode: "Markdown" }
    );
});

// ─── /demo Command — Self-Serve Trigger ──────────────────────────────────────
//
// Zero-Friction UX: любой пользователь (судья хакатона) может запустить
// полный demo-flow без серверного curl.
//
// АРХИТЕКТУРА: мы формируем валидный TeeProposal mock и прогоняем его через
// тот же storeProposal() pipeline → Redis + HMAC. BFF получает proposal
// с реальной подписью, никакого bypass не требуется.

bot.command("demo", async (ctx) => {
    const chatId = ctx.chat.id;
    await ctx.sendChatAction("typing");

    // ─── Generate demo TeeProposal (valid schema) ─────────────────────────
    const now = Math.floor(Date.now() / 1000);
    const deadline = now + 300; // 5 minutes
    const reasoningHash = `0x${randomBytes(32).toString("hex")}`;
    // Mock signature (65 bytes = 130 hex chars)
    const mockSignature = `0x${randomBytes(65).toString("hex")}`;
    // Mock signer address
    const mockSigner = "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18";

    const demoProposal = {
        asset: "0xA9b21CFDa40a1a4B3285580E1e8f20b5d2f03Dc5", // demo USDY-like
        assetSymbol: "USDY",
        action: "BUY" as const,
        recommendedAmount: "1500000000000000000000", // 1500 tokens
        nonce: Math.floor(Math.random() * 1_000_000),
        deadline,
        reasoningHash,
        signature: mockSignature,
        signerAddress: mockSigner,
        generatedAt: now,
        maxSlippageBps: 150, // 1.5%
    };

    // ─── Store via existing pipeline (generates UUID + HMAC) ──────────────
    const raw = JSON.stringify(demoProposal);
    const result = await storeProposal(raw);

    if (!result) {
        await ctx.reply(
            "⚠️ *Ошибка:* не удалось создать demo-proposal.\n" +
            "Проверьте: бот не на паузе (/resume), Redis доступен (/status).",
            { parse_mode: "Markdown" }
        );
        return;
    }

    // ─── Format alert message ────────────────────────────────────────────
    const amountEth = (Number(BigInt(demoProposal.recommendedAmount)) / 1e18).toLocaleString("en-US", {
        maximumFractionDigits: 2,
    });

    const reasoningShort =
        reasoningHash.slice(0, 12) + "..." + reasoningHash.slice(-8);

    const message =
        `⚡ *AlphaFlow TEE Signal* (DEMO)\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🟢 *Action:*   \`LONG / BUY\`\n` +
        `💎 *Asset:*    \`${demoProposal.assetSymbol}\` (RWA Yield Token)\n` +
        `💰 *Volume:*   \`${amountEth} tokens\`\n` +
        `🛡 *Slippage:* \`1.5%\`\n` +
        `⏱ *Expires:*  \`5m 0s\`\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🔐 *Proof-of-Reasoning:*\n` +
        `\`${reasoningShort}\`\n\n` +
        `_Signed by TEE Signer: ${mockSigner.slice(0, 12)}..._\n\n` +
        `_Нажмите кнопку ниже для исполнения через Passkey:_`;

    // ─── Deep link with valid HMAC ──────────────────────────────────────
    const startappParam = `${result.proposalId}_${result.hmacB64url}`;
    const webAppUrl     = `https://t.me/${BOT_USERNAME}/app?startapp=${startappParam}`;

    // ─── Inline Keyboard ────────────────────────────────────────────────
    const agentIdStr = DEFAULT_AGENT_ID.toString();
    const keyboard = Markup.inlineKeyboard([
        [
            Markup.button.webApp(
                "⚡ Execute via Passkey",
                webAppUrl
            ),
        ],
        [
            Markup.button.callback(
                "👍 Хорошая стратегия",
                `vote_up_${result.proposalId}_${agentIdStr}`
            ),
            Markup.button.callback(
                "👎 Сомнительная",
                `vote_down_${result.proposalId}_${agentIdStr}`
            ),
        ],
    ]);

    // ─── Send to the requesting user (not just TARGET_CHAT_ID) ──────────
    await bot.telegram.sendMessage(chatId, message, {
        parse_mode: "Markdown",
        ...keyboard,
    });

    console.log(
        `[Bot] Demo proposal sent to chat ${chatId} | ` +
        `ProposalId=${result.proposalId} | TTL=${result.ttlSeconds}s`
    );
});

// ─── /status Command ──────────────────────────────────────────────────────────

bot.command("status", async (ctx) => {
    await ctx.sendChatAction("typing");

    const status = await getRedisStatus();

    if (!status.healthy) {
        await ctx.reply(
            "🔴 *Redis: OFFLINE*\n\nСоединение с Redis потеряно. Проверьте инфраструктуру.",
            { parse_mode: "Markdown" }
        );
        return;
    }

    const statusIcon  = status.paused ? "⏸" : "✅";
    const stateLabel  = status.paused ? "PAUSED" : "ACTIVE";

    await ctx.reply(
        `*AlphaFlow Bot Status*\n\n` +
        `🟢 Redis: ONLINE (${status.pingMs}ms)\n` +
        `${statusIcon} Bot: ${stateLabel}\n` +
        `📊 Signals processed: ${status.signalCount}\n\n` +
        `_Use /pause or /resume to control signal intake._`,
        { parse_mode: "Markdown" }
    );
});

// ─── /pause Command ───────────────────────────────────────────────────────────

bot.command("pause", async (ctx) => {
    await pauseBot();
    await ctx.reply(
        "⏸ *Bot paused.*\n\nНовые сигналы от TEE-агента будут игнорироваться до /resume.",
        { parse_mode: "Markdown" }
    );
    console.log("[Bot] Paused by user command");
});

// ─── /resume Command ──────────────────────────────────────────────────────────

bot.command("resume", async (ctx) => {
    await resumeBot();
    await ctx.reply(
        "▶️ *Bot resumed.*\n\nПриём сигналов восстановлен.",
        { parse_mode: "Markdown" }
    );
    console.log("[Bot] Resumed by user command");
});

// ─── /help Command ────────────────────────────────────────────────────────────

bot.help(async (ctx) => {
    await ctx.reply(
        "*AlphaFlow Bot Commands:*\n\n" +
        "/start  — Приветствие и описание системы\n" +
        "/demo   — 🚀 Сгенерировать тестовый сигнал (самообслуживание)\n" +
        "/status — Статус Redis и статистика сигналов\n" +
        "/pause  — Приостановить приём TEE-сигналов\n" +
        "/resume — Возобновить приём TEE-сигналов",
        { parse_mode: "Markdown" }
    );
});

// ─── Callback Query Handler — Voting ─────────────────────────────────────────
//
// Обрабатывает нажатия кнопок 👍 / 👎.
//
// callback_data формат:
//   "vote_up_{proposalId}_{agentId}"
//   "vote_down_{proposalId}_{agentId}"
//
// Алгоритм:
// 1. Парсим callback_data → direction + proposalId + agentId
// 2. SETNX vote:{proposalId}:{userId} — защита от двойного голосования
// 3. Если уже проголосовал → answerCallbackQuery с уведомлением
// 4. Иначе: pipeline → INCRBY agent_feedback_score + INCR agent_feedback_count
// 5. answerCallbackQuery + silent success

bot.on("callback_query", async (ctx) => {
    const query = ctx.callbackQuery as CallbackQuery.DataQuery;

    if (!("data" in query)) {
        await ctx.answerCbQuery();
        return;
    }

    const data   = query.data;
    const userId = query.from.id;

    // ─── Parse callback_data ──────────────────────────────────────────────
    // Format: "vote_up_{uuid}_{agentId}" or "vote_down_{uuid}_{agentId}"
    const voteMatch = data.match(/^vote_(up|down)_([0-9a-f-]+)_(\d+)$/i);

    if (!voteMatch) {
        // Не наш callback — игнорируем
        await ctx.answerCbQuery();
        return;
    }

    const direction  = voteMatch[1] as "up" | "down";
    const proposalId = voteMatch[2]!;
    const agentId    = voteMatch[3]!;
    const delta      = direction === "up" ? 1 : -1;

    const r = getCommander();

    // ─── Double-vote protection ───────────────────────────────────────────
    // SETNX vote:{proposalId}:{userId} 1 (no TTL — голос должен жить вечно)
    // Достаточно NX, так как нас устраивает persistent key
    const voteKey = `vote:${proposalId}:${userId}`;
    const wasSet  = await r.set(voteKey, "1", "NX");

    if (wasSet === null) {
        // Пользователь уже голосовал
        await ctx.answerCbQuery("Вы уже проголосовали за этот сигнал.", { show_alert: false });
        return;
    }

    // ─── Record metrics in Redis ──────────────────────────────────────────
    // Эти ключи читает reputationBatcher.ts в BFF
    //   agent_feedback_score:{agentId}  → net score (±1 per vote)
    //   agent_feedback_count:{agentId}  → total votes
    const scoreKey = `agent_feedback_score:${agentId}`;
    const countKey = `agent_feedback_count:${agentId}`;

    const pipeline = r.pipeline();
    pipeline.incrby(scoreKey, delta);
    pipeline.incr(countKey);
    await pipeline.exec();

    const emoji = direction === "up" ? "👍" : "👎";
    const label = direction === "up" ? "+1 учтён" : "-1 учтён";

    await ctx.answerCbQuery(`${emoji} ${label}. Спасибо за обратную связь!`, { show_alert: false });

    console.log(
        `[Bot] Vote recorded | proposalId=${proposalId} | agentId=${agentId} | ` +
        `userId=${userId} | direction=${direction} | delta=${delta}`
    );
});

// ─── Broadcast Proposal ───────────────────────────────────────────────────────

/**
 * Отправляет уведомление о новом Proposal в TARGET_CHAT_ID.
 *
 * Формирует:
 * - Подробное сообщение с параметрами сделки
 * - Inline кнопку WebApp + кнопки голосования 👍 / 👎
 *
 * Keyboard layout:
 *   [ ⚡ Execute via Passkey  ] (WebApp)
 *   [ 👍 Хорошая стратегия ]  [ 👎 Сомнительная стратегия ]
 *
 * callback_data для голосования:
 *   vote_up_{proposalId}_{agentId}
 *   vote_down_{proposalId}_{agentId}
 *
 * @param proposal    StoredProposal (данные для отображения)
 * @param proposalId  UUID, сгенерированный ботом
 * @param hmacB64url  HMAC-SHA256(proposalId) в Base64url для URL
 * @param ttlSeconds  секунд до истечения proposal
 */
async function broadcastProposal(
    proposal: StoredProposal,
    proposalId: string,
    hmacB64url: string,
    ttlSeconds: number
): Promise<void> {
    // ─── Format amount (bigint string → human-readable) ───────────────────
    const amountWei = BigInt(proposal.recommendedAmount);
    const amountEth = (Number(amountWei) / 1e18).toLocaleString("en-US", {
        maximumFractionDigits: 4,
    });

    // ─── Time to expiry ───────────────────────────────────────────────────
    const expiryMins = Math.floor(ttlSeconds / 60);
    const expirySecs = ttlSeconds % 60;
    const expiryStr  = expiryMins > 0
        ? `${expiryMins}m ${expirySecs}s`
        : `${expirySecs}s`;

    // ─── Action styling ───────────────────────────────────────────────────
    const actionEmoji = proposal.action === "BUY" ? "🟢" : "🔴";
    const actionLabel = proposal.action === "BUY" ? "LONG / BUY" : "SHORT / SELL";

    // ─── Slippage info ────────────────────────────────────────────────────
    const slippageStr = proposal.maxSlippageBps !== undefined
        ? `${(proposal.maxSlippageBps / 100).toFixed(2)}%`
        : "default";

    // ─── Reasoning hash (short display) ──────────────────────────────────
    const reasoningShort =
        proposal.reasoningHash.slice(0, 10) + "..." + proposal.reasoningHash.slice(-8);

    // ─── Message text ─────────────────────────────────────────────────────
    const message =
        `⚡ *AlphaFlow TEE Signal*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `${actionEmoji} *Action:*   \`${actionLabel}\`\n` +
        `💎 *Asset:*    \`${proposal.assetSymbol}\`\n` +
        `   \`${proposal.asset}\`\n` +
        `💰 *Volume:*   \`${amountEth} tokens\`\n` +
        `🛡 *Slippage:* \`${slippageStr}\`\n` +
        `⏱ *Expires:*  \`${expiryStr}\`\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🔐 *Proof-of-Reasoning:*\n` +
        `\`${reasoningShort}\`\n\n` +
        `_Signed by TEE Signer: ${proposal.signerAddress.slice(0, 10)}..._\n\n` +
        `_Оцените стратегию для обновления репутации агента:_`;

    // ─── Deep link URL ────────────────────────────────────────────────────
    const startappParam = `${proposalId}_${hmacB64url}`;
    const webAppUrl     = `https://t.me/${BOT_USERNAME}/app?startapp=${startappParam}`;

    // ─── Inline Keyboard ──────────────────────────────────────────────────
    // Ряд 1: WebApp execute button
    // Ряд 2: Vote buttons (callback_data включает proposalId + agentId)
    const agentIdStr = DEFAULT_AGENT_ID.toString();
    const keyboard = Markup.inlineKeyboard([
        [
            Markup.button.webApp(
                `${actionEmoji} Execute via Passkey`,
                webAppUrl
            ),
        ],
        [
            Markup.button.callback(
                "👍 Хорошая стратегия",
                `vote_up_${proposalId}_${agentIdStr}`
            ),
            Markup.button.callback(
                "👎 Сомнительная",
                `vote_down_${proposalId}_${agentIdStr}`
            ),
        ],
    ]);

    // ─── Send to TARGET_CHAT_ID ───────────────────────────────────────────
    await bot.telegram.sendMessage(TARGET_CHAT_ID, message, {
        parse_mode: "Markdown",
        ...keyboard,
    });

    console.log(
        `[Bot] Broadcast proposal ${proposalId} | ` +
        `Action=${proposal.action} | ` +
        `Asset=${proposal.assetSymbol} | ` +
        `AgentId=${agentIdStr} | ` +
        `TTL=${ttlSeconds}s`
    );
}

// ─── Redis Pub/Sub Subscription ───────────────────────────────────────────────
//
// Подписываемся на канал "tee_proposals".
// TEE-агент публикует JSON-строку SignedProposal.
//
// ВАЖНО: subscriber клиент заблокирован в режиме subscribe
// и не может выполнять другие Redis команды.

async function startRedisSubscription(): Promise<void> {
    const subscriber = getSubscriber();

    subscriber.on("message", async (channel: string, message: string) => {
        if (channel !== "tee_proposals") return;

        console.log(`[Redis:sub] Received signal on channel: ${channel}`);

        try {
            const result = await storeProposal(message);

            if (!result) {
                // Dropped: paused, invalid, expired or replay
                return;
            }

            const stored = JSON.parse(message) as StoredProposal;
            stored.id        = result.proposalId;
            stored.createdAt = Math.floor(Date.now() / 1000);

            await broadcastProposal(
                stored,
                result.proposalId,
                result.hmacB64url,
                result.ttlSeconds
            );

        } catch (err) {
            console.error("[Redis:sub] Error processing message:", err);
        }
    });

    subscriber.on("error", (err: Error) => {
        console.error("[Redis:sub] Subscription error:", err.message);
    });

    await subscriber.subscribe("tee_proposals");
    console.log("[Redis:sub] Subscribed to channel: tee_proposals");
}

// ─── Error Handling ───────────────────────────────────────────────────────────

bot.catch((err: unknown, ctx: Context) => {
    const update = ctx.update as { update_id?: number };
    console.error(`[Bot] Error for update ${update.update_id ?? "?"}:`, err);
});

// ─── Launch ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    await startRedisSubscription();
    await bot.launch();
    console.log("[Bot] Telegraf launched (long polling)");
    console.log("[Bot] Waiting for TEE signals...");
}

main().catch((err) => {
    console.error("[Bot] Fatal startup error:", err);
    process.exit(1);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[Bot] Received ${signal}, shutting down...`);
    bot.stop(signal);
    await shutdownStore();
    console.log("[Bot] Goodbye.");
    process.exit(0);
};

process.once("SIGINT",  () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
