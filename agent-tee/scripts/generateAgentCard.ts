/**
 * @file generateAgentCard.ts
 * @description Генератор AgentCard JSON для стандарта ERC-8004.
 *
 * AgentCard — декларация возможностей AI-агента, хранимая в децентрализованном хранилище.
 * Этот скрипт формирует JSON-структуру, валидирует обязательные поля, и опционально
 * загружает результат на IPFS через Pinata/web3.storage.
 *
 * ОБЯЗАТЕЛЬНЫЕ ПОЛЯ (ERC-8004 Agent Card Standard):
 *   - name: Человекочитаемое имя агента
 *   - description: Описание функций агента
 *   - capabilities: Массив строк (обязательно включает "MCP")
 *   - endpoints: Объект с URI для взаимодействия (MCP endpoint, health check, etc.)
 *   - paymentAddresses: Объект с адресами приёма платежей (chain → address)
 *
 * ИСПОЛЬЗОВАНИЕ:
 *   npx tsx agent-tee/scripts/generateAgentCard.ts
 *   npx tsx agent-tee/scripts/generateAgentCard.ts --output ./agent-card.json
 *   npx tsx agent-tee/scripts/generateAgentCard.ts --upload
 *
 * ENV VARIABLES:
 *   AGENT_NAME          — Имя агента (default: "AlphaFlow Sentinel")
 *   AGENT_DESCRIPTION   — Описание
 *   MCP_ENDPOINT        — MCP endpoint URI
 *   PAYMENT_ADDRESS     — Адрес оплаты на Mantle
 *   PINATA_JWT          — JWT для загрузки на Pinata IPFS (для --upload)
 */

import { writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

// ═══════════════════════════════════════════════════════════════════
//                       TYPES
// ═══════════════════════════════════════════════════════════════════

/** ERC-8004 AgentCard JSON Schema */
interface AgentCard {
  /** Версия схемы AgentCard */
  schemaVersion: string;
  /** Человекочитаемое имя агента */
  name: string;
  /** Описание функций агента */
  description: string;
  /** Массив возможностей (capabilities). ОБЯЗАТЕЛЬНО включает "MCP" */
  capabilities: string[];
  /** URI эндпоинтов для взаимодействия */
  endpoints: {
    /** Model Context Protocol endpoint */
    mcp: string;
    /** Health check endpoint */
    health?: string;
    /** WebSocket endpoint для real-time updates */
    ws?: string;
    /** REST API endpoint */
    rest?: string;
  };
  /** Адреса приёма платежей (протокол x402) */
  paymentAddresses: {
    /** Формат: "chainName" → "0x..." */
    [chain: string]: string;
  };
  /** Метаданные TEE (Trusted Execution Environment) */
  tee?: {
    /** Тип TEE (SGX, TDX, SEV) */
    type: string;
    /** Remote Attestation endpoint */
    attestationEndpoint?: string;
    /** MRENCLAVE/MRTD значение */
    measurement?: string;
  };
  /** Зависимости от других агентов (Agent-to-Agent) */
  dependencies?: {
    /** tokenId зависимого агента → описание зависимости */
    [agentId: string]: string;
  };
  /** Временная метка генерации */
  generatedAt: string;
  /** Версия агента */
  version: string;
}

// ═══════════════════════════════════════════════════════════════════
//                       VALIDATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Валидация AgentCard на соответствие ERC-8004.
 * Бросает ошибку если обязательные поля отсутствуют.
 */
function validateAgentCard(card: AgentCard): void {
  const errors: string[] = [];

  if (!card.name || card.name.trim().length === 0) {
    errors.push("'name' is required and must be non-empty");
  }

  if (!card.description || card.description.trim().length === 0) {
    errors.push("'description' is required and must be non-empty");
  }

  if (!Array.isArray(card.capabilities) || card.capabilities.length === 0) {
    errors.push("'capabilities' must be a non-empty array");
  }

  if (!card.capabilities.includes("MCP")) {
    errors.push("'capabilities' MUST include 'MCP' per ERC-8004 standard");
  }

  if (!card.endpoints || typeof card.endpoints !== "object") {
    errors.push("'endpoints' is required and must be an object");
  }

  if (!card.endpoints?.mcp) {
    errors.push("'endpoints.mcp' is required (Model Context Protocol URI)");
  }

  if (!card.paymentAddresses || Object.keys(card.paymentAddresses).length === 0) {
    errors.push("'paymentAddresses' must contain at least one entry");
  }

  // Валидация формата адресов
  for (const [chain, addr] of Object.entries(card.paymentAddresses)) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      errors.push(`paymentAddresses['${chain}']: invalid Ethereum address format`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `AgentCard validation failed:\n${errors.map((e) => `  ✗ ${e}`).join("\n")}`
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
//                       GENERATOR
// ═══════════════════════════════════════════════════════════════════

/**
 * Генерация AgentCard JSON из environment variables и defaults.
 */
function generateAgentCard(): AgentCard {
  const card: AgentCard = {
    schemaVersion: "1.0.0",
    name: process.env.AGENT_NAME || "AlphaFlow Sentinel",
    description:
      process.env.AGENT_DESCRIPTION ||
      "Autonomous flash-arbitrage agent on Mantle Network. " +
        "Monitors INIT Capital, Merchant Moe, and Agni Finance for cross-DEX " +
        "arbitrage opportunities. Operates within TEE (Phala DStack) for " +
        "secure key management and execution privacy.",
    capabilities: [
      "MCP",                    // Model Context Protocol — обязательно
      "flash-arbitrage",        // Основная функция: flash loan арбитраж
      "cross-dex-monitoring",   // Мониторинг нескольких DEX
      "tee-execution",          // Исполнение в TEE среде
      "wallet-clustering",      // Dynamic watchlist + clustering engine
      "nansen-integration",     // Nansen MCP для whale tracking
      "zerodev-aa",             // Account Abstraction через ZeroDev
    ],
    endpoints: {
      mcp:
        process.env.MCP_ENDPOINT ||
        "https://alphaflow-sentinel.phala.network/mcp",
      health:
        process.env.HEALTH_ENDPOINT ||
        "https://alphaflow-sentinel.phala.network/health",
      ws:
        process.env.WS_ENDPOINT ||
        "wss://alphaflow-sentinel.phala.network/ws",
      rest:
        process.env.REST_ENDPOINT ||
        "https://alphaflow-sentinel.phala.network/api/v1",
    },
    paymentAddresses: {
      mantle:
        process.env.PAYMENT_ADDRESS ||
        "0x0000000000000000000000000000000000000000", // ЗАМЕНИТЬ НА РЕАЛЬНЫЙ
      ethereum:
        process.env.PAYMENT_ADDRESS_ETH ||
        "0x0000000000000000000000000000000000000000", // ЗАМЕНИТЬ НА РЕАЛЬНЫЙ
    },
    tee: {
      type: "TDX", // Intel TDX через Phala DStack
      attestationEndpoint:
        process.env.ATTESTATION_ENDPOINT ||
        "https://alphaflow-sentinel.phala.network/attestation",
      measurement: process.env.TEE_MEASUREMENT || undefined,
    },
    dependencies: {},
    generatedAt: new Date().toISOString(),
    version: process.env.AGENT_VERSION || "2.0.0",
  };

  return card;
}

// ═══════════════════════════════════════════════════════════════════
//                       IPFS UPLOAD (OPTIONAL)
// ═══════════════════════════════════════════════════════════════════

/**
 * Загрузка AgentCard на IPFS через Pinata.
 * Требует PINATA_JWT в environment.
 * @returns CID загруженного файла
 */
async function uploadToIPFS(card: AgentCard): Promise<string> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    throw new Error("PINATA_JWT environment variable is required for IPFS upload");
  }

  const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      pinataContent: card,
      pinataMetadata: {
        name: `AgentCard-${card.name}-${card.version}`,
      },
      pinataOptions: {
        cidVersion: 1,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Pinata upload failed: ${response.status} ${error}`);
  }

  const result = (await response.json()) as { IpfsHash: string };
  return result.IpfsHash;
}

// ═══════════════════════════════════════════════════════════════════
//                       MAIN
// ═══════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║       ERC-8004 AgentCard Generator — AlphaFlow Suite    ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // 1. Generate
  const card = generateAgentCard();
  console.log("✓ AgentCard generated");

  // 2. Validate
  validateAgentCard(card);
  console.log("✓ AgentCard validated (ERC-8004 compliant)");

  // 3. Determine output path
  const args = process.argv.slice(2);
  const outputIdx = args.indexOf("--output");
  const outputPath =
    outputIdx !== -1 && args[outputIdx + 1]
      ? resolve(args[outputIdx + 1])
      : resolve(process.cwd(), "agent-card.json");

  // 4. Write to file
  const dir = dirname(outputPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const json = JSON.stringify(card, null, 2);
  writeFileSync(outputPath, json, "utf-8");
  console.log(`✓ Written to: ${outputPath}`);
  console.log(`  Size: ${Buffer.byteLength(json)} bytes`);

  // 5. Optional IPFS upload
  if (args.includes("--upload")) {
    console.log("\n⟳ Uploading to IPFS via Pinata...");
    const cid = await uploadToIPFS(card);
    console.log(`✓ Uploaded to IPFS`);
    console.log(`  CID: ${cid}`);
    console.log(`  URI: ipfs://${cid}`);
    console.log(`  Gateway: https://gateway.pinata.cloud/ipfs/${cid}`);
    console.log(`\n  Use this as agentCardURI in IdentityRegistry.registerAgent()`);
  }

  // 6. Print summary
  console.log("\n── AgentCard Preview ─────────────────────────────────────");
  console.log(json);
  console.log("──────────────────────────────────────────────────────────\n");
}

main().catch((err) => {
  console.error("✗ Error:", err.message);
  process.exit(1);
});
