// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — agent-tee/src/services/remoteAttestation.ts
// Phase 3: TEE Remote Attestation — включает Bloom Filter hash в reportData
//
// ИЗМЕНЕНИЯ PHASE 3:
//   ✓ buildReportData() теперь принимает bloomFilterHash
//   ✓ reportData = keccak256(abi.encode(proposalHash, bloomFilterHash))
//   ✓ Это привязывает конфигурацию фильтра к attestation quote
//
// Доказывает: код agent-tee исполняется в настоящем анклаве,
// не модифицирован администратором сервера, И использует конкретную
// конфигурацию Bloom Filter (битовый массив N, хэш-функций K).
// ═══════════════════════════════════════════════════════════════════════════════

import { createHash } from "crypto";
import { keccak256, encodePacked, type Hex } from "viem";

// ═══════════════════════════════════════════════════════════════════════════════
//                          TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface AttestationQuote {
    /** Raw SGX Quote (hex-encoded) */
    rawQuote: string;
    /** MRENCLAVE — hash of the enclave code */
    mrenclave: string;
    /** MRSIGNER — hash of the enclave signing key */
    mrsigner: string;
    /** User Report Data (custom payload embedded in quote) */
    reportData: string;
    /** Timestamp of quote generation */
    timestamp: number;
    /** Platform: sgx, tdx, sev (AMD) */
    platform: "sgx" | "tdx" | "sev";
}

export interface AttestationVerification {
    isValid: boolean;
    mrenclave: string;
    mrsigner: string;
    reportData: string;
    /** Intel Attestation Service response (for SGX) */
    iasResponse?: string;
    /** DCAP verification result (for TDX/DStack) */
    dcapResult?: string;
}

/**
 * Phase 3: Параметры для построения reportData.
 */
export interface ReportDataParams {
    /** keccak256 hash предложения (proposal) */
    proposalHash: Hex;
    /** keccak256 hash конфигурации Bloom Filter (из BloomFilter.getFilterConfigHash()) */
    bloomFilterHash: Hex;
}

// ═══════════════════════════════════════════════════════════════════════════════
//                 PHALA DSTACK ATTESTATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Генерирует Remote Attestation Quote через Phala DStack API.
 *
 * В CVM (Confidential Virtual Machine) доступен специальный endpoint:
 * http://localhost:8090/prpc/Phala.GetRemoteAttestation
 *
 * Phase 3 ИЗМЕНЕНИЕ:
 *   reportData = keccak256(abi.encode(proposalHash, bloomFilterHash))
 *   Это гарантирует:
 *     1. Attestation привязана к конкретному Proposal
 *     2. Attestation доказывает конфигурацию Bloom Filter
 *        (следовательно — детерминизм решений фильтрации)
 */
export class PhalaAttestationService {
    private dstackEndpoint: string;

    constructor(dstackEndpoint: string = "http://localhost:8090") {
        this.dstackEndpoint = dstackEndpoint;
    }

    /**
     * Генерирует SGX/TDX Quote с пользовательским reportData.
     *
     * @param reportData — 64 bytes hex (комбинированный hash)
     * @returns Raw attestation quote
     */
    async generateQuote(reportData: string): Promise<AttestationQuote> {
        // Validate reportData format (64 bytes = 128 hex chars)
        if (!/^[0-9a-f]{128}$/i.test(reportData)) {
            throw new Error("reportData must be 64 bytes (128 hex chars)");
        }

        try {
            const response = await fetch(
                `${this.dstackEndpoint}/prpc/Phala.GetRemoteAttestation`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        report_data: reportData,
                    }),
                }
            );

            if (!response.ok) {
                throw new Error(`DStack attestation failed: ${response.status}`);
            }

            const result = await response.json() as any;

            return {
                rawQuote: result.quote,
                mrenclave: result.mrenclave || this.extractMrenclave(result.quote),
                mrsigner: result.mrsigner || this.extractMrsigner(result.quote),
                reportData,
                timestamp: Math.floor(Date.now() / 1000),
                platform: result.platform || "tdx",
            };
        } catch (err) {
            // Fallback: если не в CVM (development mode)
            if ((err as Error).message.includes("ECONNREFUSED")) {
                console.warn("[Attestation] Not running in CVM — returning mock quote");
                return this.generateMockQuote(reportData);
            }
            throw err;
        }
    }

    /**
     * Phase 3: Создаёт reportData с комбинированным хэшем.
     *
     * ФОРМУЛА: keccak256(abi.encode(proposalHash, bloomFilterHash))
     *
     * proposalHash — привязывает attestation к конкретному предложению.
     * bloomFilterHash — доказывает конфигурацию фильтра (bitSize, hashCount).
     *
     * Результат обрезается до 64 bytes (128 hex chars) для SGX/TDX reportData.
     *
     * @param params.proposalHash — bytes32 hash предложения
     * @param params.bloomFilterHash — bytes32 hash конфигурации Bloom Filter
     * @returns 128 hex chars (64 bytes) для reportData
     */
    buildReportData(params: ReportDataParams): string {
        const { proposalHash, bloomFilterHash } = params;

        // Validate inputs
        if (!proposalHash || !proposalHash.startsWith("0x") || proposalHash.length !== 66) {
            throw new Error(
                `Invalid proposalHash: expected bytes32, got ${proposalHash}`
            );
        }
        if (!bloomFilterHash || !bloomFilterHash.startsWith("0x") || bloomFilterHash.length !== 66) {
            throw new Error(
                `Invalid bloomFilterHash: expected bytes32, got ${bloomFilterHash}`
            );
        }

        // keccak256(abi.encode(proposalHash, bloomFilterHash))
        const combinedHash = keccak256(
            encodePacked(
                ["bytes32", "bytes32"],
                [proposalHash, bloomFilterHash]
            )
        );

        // reportData = 64 bytes. combinedHash = 32 bytes (64 hex chars).
        // Pad to 64 bytes (128 hex chars) with zeros.
        const reportData = combinedHash.slice(2).padEnd(128, "0");

        console.log(
            `[Attestation] buildReportData:` +
            `\n  proposalHash:    ${proposalHash}` +
            `\n  bloomFilterHash: ${bloomFilterHash}` +
            `\n  combinedHash:    ${combinedHash}` +
            `\n  reportData:      ${reportData.slice(0, 32)}...`
        );

        return reportData;
    }

    /**
     * @deprecated Phase 2 legacy — используйте buildReportData(params: ReportDataParams)
     *
     * Оставлен для обратной совместимости.
     * Создаёт reportData БЕЗ bloomFilterHash (старый формат).
     */
    buildReportDataLegacy(
        reasoningHash: string,
        teeSignerAddress: string,
        nonce: number
    ): string {
        const packed = Buffer.concat([
            Buffer.from(reasoningHash.replace("0x", ""), "hex"),
            Buffer.from(teeSignerAddress.replace("0x", ""), "hex"),
            Buffer.from(nonce.toString(16).padStart(64, "0"), "hex"),
        ]);
        return createHash("sha256").update(packed).digest("hex").padEnd(128, "0");
    }

    /**
     * Верифицирует attestation quote через DCAP (on-chain или IAS).
     *
     * В продакшене: вызов on-chain DCAP Attestation contract на Phala.
     * Для Intel SGX: запрос к Intel Attestation Service (IAS).
     */
    async verifyQuote(quote: AttestationQuote): Promise<AttestationVerification> {
        try {
            // Option 1: Phala on-chain DCAP verification
            const dcapResult = await this.verifyViaDcap(quote);
            return dcapResult;
        } catch {
            // Option 2: Intel Attestation Service (IAS) — SGX only
            if (quote.platform === "sgx") {
                return this.verifyViaIas(quote);
            }
            throw new Error("No attestation verification method available");
        }
    }

    /**
     * Phase 3: Полный flow — buildReportData + generateQuote.
     *
     * Convenience method для Pipeline:
     *   1. Вычислить combined reportData
     *   2. Запросить SGX/TDX quote с этим reportData
     *   3. Вернуть готовый AttestationQuote
     */
    async attestProposal(params: ReportDataParams): Promise<AttestationQuote> {
        const reportData = this.buildReportData(params);
        return this.generateQuote(reportData);
    }

    // ─── Private: Verification Methods ────────────────────────────────────────

    private async verifyViaDcap(quote: AttestationQuote): Promise<AttestationVerification> {
        const response = await fetch(
            `${this.dstackEndpoint}/prpc/Phala.VerifyAttestation`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ quote: quote.rawQuote }),
            }
        );

        if (!response.ok) {
            throw new Error(`DCAP verification failed: ${response.status}`);
        }

        const result = await response.json() as any;

        return {
            isValid: result.is_valid === true,
            mrenclave: quote.mrenclave,
            mrsigner: quote.mrsigner,
            reportData: quote.reportData,
            dcapResult: JSON.stringify(result),
        };
    }

    private async verifyViaIas(quote: AttestationQuote): Promise<AttestationVerification> {
        const IAS_URL = "https://api.trustedservices.intel.com/sgx/dev/attestation/v4/report";
        const IAS_API_KEY = process.env.IAS_API_KEY;

        if (!IAS_API_KEY) {
            throw new Error("IAS_API_KEY not configured");
        }

        const response = await fetch(IAS_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Ocp-Apim-Subscription-Key": IAS_API_KEY,
            },
            body: JSON.stringify({ isvEnclaveQuote: quote.rawQuote }),
        });

        const iasResponse = await response.text();

        return {
            isValid: response.ok && iasResponse.includes('"isvEnclaveQuoteStatus":"OK"'),
            mrenclave: quote.mrenclave,
            mrsigner: quote.mrsigner,
            reportData: quote.reportData,
            iasResponse,
        };
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    private extractMrenclave(rawQuote: string): string {
        const quoteBytes = Buffer.from(rawQuote, "hex");
        if (quoteBytes.length < 144) return "unknown";
        return quoteBytes.subarray(112, 144).toString("hex");
    }

    private extractMrsigner(rawQuote: string): string {
        const quoteBytes = Buffer.from(rawQuote, "hex");
        if (quoteBytes.length < 208) return "unknown";
        return quoteBytes.subarray(176, 208).toString("hex");
    }

    private generateMockQuote(reportData: string): AttestationQuote {
        return {
            rawQuote: "MOCK_DEVELOPMENT_QUOTE_" + reportData.substring(0, 32),
            mrenclave: createHash("sha256").update("alphaflow-agent-tee:latest").digest("hex"),
            mrsigner: createHash("sha256").update("development-signer").digest("hex"),
            reportData,
            timestamp: Math.floor(Date.now() / 1000),
            platform: "tdx",
        };
    }
}
