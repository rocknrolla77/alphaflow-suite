// Файл: devops/src/tg-bot/index.ts
// Telegram HITL Bot — Human-in-the-Loop для AlphaFlow Suite
// Транспортный уровень: доставляет Proposals от TEE к пользователю,
// НЕ имеет доступа к приватным ключам.

import { Telegraf, Markup, Context } from "telegraf";
import { Redis } from "ioredis";
import { loadConfig } from "./config";
import { ProposalStore, StoredProposal } from "./proposalStore";

// ═══════════════════════════════════════════════════════════════════════
//                        INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════

const config = loadConfig();
const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
const redis = new Redis(config.REDIS_URL);
const subscriber = new Redis(config.REDIS_URL); // Отдельное соединение для Pub/Sub

const store = new ProposalStore(
    redis,
    config.PROPOSAL_HMAC_SECRET,
    config.PROPOSAL_TTL_SEC
);

// Разрешённый пользователь (один владелец)
const OWNER_CHAT_ID = config.TARGET_CHAT_ID;

// ═══════════════════════════════════════════════════════════════════════
//                   SECURITY: OWNER-ONLY MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Middleware: отклоняет все сообщения от неавторизованных пользователей.
 * Предотвращает Web2 атаку: даже если бот token утёк, чужой chat_id блокируется.
 */
function ownerOnly(ctx: Context, next: () => Promise<void>) {
    const chatId = ctx.chat?.id?.toString();
    if (chatId !== OWNER_CHAT_ID) {
        console.warn(`⚠️ Unauthorized access attempt from chat_id: ${chatId}`);
        return; // Молча игнорируем — не раскрываем наличие бота
    }
    return next();
}

bot.use(ownerOnly);

// ═══════════════════════════════════════════════════════════════════════
//                   REDIS PUB/SUB — PROPOSAL INGESTION
// ═══════════════════════════════════════════════════════════════════════

subscriber.subscribe("tee_proposals", (err) => {
    if (err) {
        console.error("❌ Redis subscription failed:", err.message);
        process.exit(1);
    }
    console.log("✅ Subscribed to tee_proposals channel");
});

subscriber.on("message", async (_channel, message) => {
    try {
        const proposalData = JSON.parse(message);

        // Валидация минимальной структуры
        if (!proposalData.asset || !proposalData.reasoningHash || !proposalData.deadline) {
            console.error("❌ Invalid proposal structure:", proposalData);
            return;
        }

        // Сохранение с nullifier protection
        const result = await store.store({
            asset: proposalData.asset,
            action: proposalData.action,
            amount: proposalData.recommendedAmount,
            deadline: proposalData.deadline,
            reasoningHash: proposalData.reasoningHash,
            proofOfReasoning: proposalData.proofOfReasoning,
            teeSignerAddress: proposalData.teeSignerAddress,
            priceAtGeneration: proposalData.priceAtGeneration || 0,
            maxSlippagePct: proposalData.maxSlippagePct || 2,
        });

        if (!result.stored) {
            console.warn(`⚠️ Proposal rejected: ${result.reason}`);
            return;
        }

        // Отправка уведомления пользователю
        await sendProposalNotification(result.id!, result.hmac!, proposalData);
    } catch (err: any) {
        console.error("❌ Error processing proposal:", err.message);
    }
});

// ═══════════════════════════════════════════════════════════════════════
//                     PROPOSAL NOTIFICATION
// ═══════════════════════════════════════════════════════════════════════

async function sendProposalNotification(
    proposalId: string,
    hmac: string,
    data: any
): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const timeToExpiry = Math.floor((data.deadline - now) / 60);

    // Экранирование для HTML parse_mode
    const sanitizedAsset = escapeHtml(data.asset);
    const sanitizedAction = escapeHtml(data.action);
    const amountFormatted = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
    }).format(data.recommendedAmount);

    const text = [
        "🟢 <b>Smart Money Proposal</b>",
        "",
        `<b>Action:</b> ${sanitizedAction}`,
        `<b>Asset:</b> <code>${sanitizedAsset}</code>`,
        `<b>Volume (S_user):</b> ${amountFormatted}`,
        `<b>Weight (W):</b> ${(data.weight * 100).toFixed(3)}%`,
        `<b>Confidence:</b> ${(data.confidence * 100).toFixed(1)}%`,
        `<b>Source:</b> ${escapeHtml(data.sourceTag || "Unknown")}`,
        "",
        `⏱ <b>Expires in:</b> ${timeToExpiry} minutes`,
        `<i>Hash: ${data.reasoningHash.substring(0, 18)}...</i>`,
        "",
        "⚠️ <i>Price will be re-checked at approval time</i>",
    ].join("\n");

    // Deep-link: proposalId + HMAC в URL параметрах TMA
    // HMAC предотвращает URL injection / parameter tampering
    const tmaUrl = buildSecureTmaUrl(proposalId, hmac);

    const keyboard = Markup.inlineKeyboard([
        [
            Markup.button.webApp("✅ Approve & Sign (TMA)", tmaUrl),
        ],
        [
            Markup.button.callback("❌ Reject", `reject:${proposalId}:${hmac.substring(0, 16)}`),
            Markup.button.callback("📊 Details", `details:${proposalId}:${hmac.substring(0, 16)}`),
        ],
    ]);

    await bot.telegram.sendMessage(OWNER_CHAT_ID, text, {
        parse_mode: "HTML",
        ...keyboard,
    });
}

/**
 * Строит безопасный URL для Telegram Mini App.
 * HMAC предотвращает подделку proposalId в URL.
 * proposalId и hmac передаются как startapp parameter (base64url encoded).
 */
function buildSecureTmaUrl(proposalId: string, hmac: string): string {
    // Кодируем в base64url для безопасной передачи через URL
    const payload = Buffer.from(
        JSON.stringify({ pid: proposalId, sig: hmac })
    ).toString("base64url");

    // Telegram Mini App URL с параметром
    return `${config.MINI_APP_URL}?startapp=${payload}`;
}

// ═══════════════════════════════════════════════════════════════════════
//                   CALLBACK HANDLERS (Inline Buttons)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Reject callback — отклонение proposal.
 */
bot.action(/^reject:(.+):(.+)$/, async (ctx) => {
    const proposalId = ctx.match[1];
    const hmacPrefix = ctx.match[2];

    // Восстанавливаем полный HMAC из store для проверки
    const proposal = await redis.get(`proposal:${proposalId}`);
    if (!proposal) {
        await ctx.answerCbQuery("⏰ Proposal expired");
        return;
    }

    const parsed = JSON.parse(proposal) as StoredProposal;
    if (!parsed.hmacSignature.startsWith(hmacPrefix)) {
        await ctx.answerCbQuery("❌ Invalid signature");
        return;
    }

    const rejected = await store.reject(proposalId, parsed.hmacSignature);
    if (rejected) {
        await ctx.answerCbQuery("❌ Rejected");
        await ctx.editMessageReplyMarkup(undefined);
        await ctx.editMessageText(
            ctx.callbackQuery?.message && "text" in ctx.callbackQuery.message
                ? ctx.callbackQuery.message.text + "\n\n❌ <b>REJECTED</b>"
                : "❌ Rejected",
            { parse_mode: "HTML" }
        );
    } else {
        await ctx.answerCbQuery("⚠️ Already processed");
    }
});

/**
 * Details callback — показывает расширенную информацию.
 */
bot.action(/^details:(.+):(.+)$/, async (ctx) => {
    const proposalId = ctx.match[1];

    const proposal = await redis.get(`proposal:${proposalId}`);
    if (!proposal) {
        await ctx.answerCbQuery("⏰ Proposal expired");
        return;
    }

    const parsed = JSON.parse(proposal) as StoredProposal;
    const detailsText = [
        "📊 <b>Proposal Details</b>",
        "",
        `<b>ID:</b> <code>${parsed.id}</code>`,
        `<b>Status:</b> ${parsed.status}`,
        `<b>TEE Signer:</b> <code>${parsed.teeSignerAddress}</code>`,
        `<b>Price @ Gen:</b> $${parsed.priceAtGeneration.toFixed(4)}`,
        `<b>Max Slippage:</b> ${parsed.maxSlippagePct}%`,
        `<b>Created:</b> ${new Date(parsed.createdAt * 1000).toISOString()}`,
        `<b>Deadline:</b> ${new Date(parsed.deadline * 1000).toISOString()}`,
        "",
        `<b>Proof-of-Reasoning:</b>`,
        `<code>${parsed.proofOfReasoning.substring(0, 42)}...</code>`,
    ].join("\n");

    await ctx.answerCbQuery();
    await ctx.reply(detailsText, { parse_mode: "HTML" });
});

// ═══════════════════════════════════════════════════════════════════════
//                    OPERATOR COMMANDS
// ═══════════════════════════════════════════════════════════════════════

bot.command("status", async (ctx) => {
    const pending = await store.getPendingProposals();
    const text = [
        "📈 <b>AlphaFlow Status</b>",
        "",
        `<b>Pending Proposals:</b> ${pending.length}`,
        `<b>Redis:</b> ${redis.status}`,
        "",
        ...pending.slice(0, 5).map(
            (p, i) =>
                `${i + 1}. ${p.action} ${p.asset.substring(0, 10)}... — $${p.amount.toFixed(0)}`
        ),
    ].join("\n");

    await ctx.reply(text, { parse_mode: "HTML" });
});

bot.command("unblock", async (ctx) => {
    // Публикует команду разблокировки rate limiter через Redis
    await redis.publish("hitl_commands", JSON.stringify({ action: "force_unblock" }));
    await ctx.reply("🔓 Force unblock signal sent to TEE agent");
});

bot.command("pause", async (ctx) => {
    await redis.publish("hitl_commands", JSON.stringify({ action: "pause" }));
    await ctx.reply("⏸ Pause signal sent — agent will stop generating proposals");
});

bot.command("resume", async (ctx) => {
    await redis.publish("hitl_commands", JSON.stringify({ action: "resume" }));
    await ctx.reply("▶️ Resume signal sent — agent will resume operation");
});

// ═══════════════════════════════════════════════════════════════════════
//                    HELPERS
// ═══════════════════════════════════════════════════════════════════════

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// ═══════════════════════════════════════════════════════════════════════
//                    STARTUP & RECOVERY
// ═══════════════════════════════════════════════════════════════════════

async function startup() {
    console.log("🚀 AlphaFlow Telegram HITL Bot starting...");

    // Recovery: проверяем pending proposals после рестарта
    const pending = await store.getPendingProposals();
    if (pending.length > 0) {
        console.log(`📋 Found ${pending.length} pending proposals from previous session`);
        await bot.telegram.sendMessage(
            OWNER_CHAT_ID,
            `⚠️ Bot restarted. Found ${pending.length} pending proposals.\nUse /status to review.`,
            { parse_mode: "HTML" }
        );
    }

    await bot.launch();
    console.log("✅ Bot launched successfully");
}

startup().catch((err) => {
    console.error("❌ Fatal error:", err);
    process.exit(1);
});

// Graceful shutdown
process.once("SIGINT", () => {
    bot.stop("SIGINT");
    redis.disconnect();
    subscriber.disconnect();
});
process.once("SIGTERM", () => {
    bot.stop("SIGTERM");
    redis.disconnect();
    subscriber.disconnect();
});
