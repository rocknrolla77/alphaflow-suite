// Файл: devops/src/tg-bot/config.ts
// Конфигурация Telegram HITL бот

import { z } from "zod";

/**
 * Валидация environment variables через Zod.
 * Гарантирует, что бот не запустится без корректной конфигурации.
 */
const envSchema = z.object({
    TELEGRAM_BOT_TOKEN: z.string().min(20),
    REDIS_URL: z.string().url(),
    TARGET_CHAT_ID: z.string().regex(/^-?\d+$/),
    MINI_APP_URL: z.string().url(),
    
    // Безопасность: HMAC ключ для верификации proposalId
    PROPOSAL_HMAC_SECRET: z.string().min(32),
    
    // Время жизни proposal в Redis (секунды)
    PROPOSAL_TTL_SEC: z.coerce.number().default(300), // 5 минут
    
    // Максимальная задержка между генерацией и approve (секунды)
    MAX_APPROVE_DELAY_SEC: z.coerce.number().default(120), // 2 минуты
    
    // 2FA TOTP secret для критических действий
    TOTP_SECRET: z.string().min(16).optional(),
});

export type BotConfig = z.infer<typeof envSchema>;

export function loadConfig(): BotConfig {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
        console.error("❌ Invalid bot configuration:");
        console.error(result.error.format());
        process.exit(1);
    }
    return result.data;
}
