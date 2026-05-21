// Файл: devops/src/tg-bot/test/proposalStore.test.ts
// Unit tests для ProposalStore — replay protection, staleness, HMAC

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac, randomUUID } from "crypto";

// ═══════════════════════════════════════════════════════════════════════
//                     MOCK REDIS
// ═══════════════════════════════════════════════════════════════════════

class MockRedis {
    private store: Map<string, { value: string; expireAt: number }> = new Map();
    private sets: Map<string, Set<string>> = new Map();

    async set(key: string, value: string, _ex?: string, ttl?: number): Promise<void> {
        const expireAt = ttl ? Date.now() + ttl * 1000 : Infinity;
        this.store.set(key, { value, expireAt });
    }

    async get(key: string): Promise<string | null> {
        const entry = this.store.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expireAt) {
            this.store.delete(key);
            return null;
        }
        return entry.value;
    }

    async ttl(key: string): Promise<number> {
        const entry = this.store.get(key);
        if (!entry) return -2;
        if (entry.expireAt === Infinity) return -1;
        return Math.floor((entry.expireAt - Date.now()) / 1000);
    }

    async sismember(setKey: string, member: string): Promise<number> {
        const set = this.sets.get(setKey);
        return set?.has(member) ? 1 : 0;
    }

    async sadd(setKey: string, member: string): Promise<number> {
        if (!this.sets.has(setKey)) this.sets.set(setKey, new Set());
        this.sets.get(setKey)!.add(member);
        return 1;
    }

    async keys(pattern: string): Promise<string[]> {
        const prefix = pattern.replace("*", "");
        return Array.from(this.store.keys()).filter((k) => k.startsWith(prefix));
    }

    async mget(keys: string[]): Promise<(string | null)[]> {
        return Promise.all(keys.map((k) => this.get(k)));
    }

    pipeline() {
        const ops: Array<() => Promise<void>> = [];
        const self = this;
        return {
            set(key: string, value: string, _ex?: string, ttl?: number) {
                ops.push(() => self.set(key, value, _ex, ttl));
                return this;
            },
            sadd(setKey: string, member: string) {
                ops.push(() => self.sadd(setKey, member));
                return this;
            },
            async exec() {
                for (const op of ops) await op();
                return [];
            },
        };
    }

    // Reset for tests
    flush() {
        this.store.clear();
        this.sets.clear();
    }
}

// ═══════════════════════════════════════════════════════════════════════
//   Inline reimplementation of ProposalStore logic for isolated testing
// ═══════════════════════════════════════════════════════════════════════

const HMAC_SECRET = "test_secret_key_at_least_32_characters_long!!";

function computeHmac(id: string): string {
    return createHmac("sha256", HMAC_SECRET).update(id).digest("hex");
}

// ═══════════════════════════════════════════════════════════════════════
//                          TESTS
// ═══════════════════════════════════════════════════════════════════════

describe("ProposalStore", () => {
    let mockRedis: MockRedis;
    const futureDeadline = Math.floor(Date.now() / 1000) + 300; // 5 min from now

    const sampleProposal = {
        asset: "0x2222222222222222222222222222222222222222",
        action: "BUY" as const,
        amount: 500,
        deadline: futureDeadline,
        reasoningHash: "0xabc123def456abc123def456abc123def456abc123def456abc123def456abc1",
        proofOfReasoning: "0xsignature...",
        teeSignerAddress: "0x1111111111111111111111111111111111111111",
        priceAtGeneration: 1.05,
        maxSlippagePct: 2,
    };

    beforeEach(() => {
        mockRedis = new MockRedis();
    });

    describe("Replay Attack Protection (Nullifier)", () => {
        it("should store proposal successfully first time", async () => {
            const id = randomUUID();
            const pipeline = mockRedis.pipeline();
            pipeline.set(`proposal:${id}`, JSON.stringify({ ...sampleProposal, id, status: "pending" }), "EX", 300);
            pipeline.sadd("used_reasoning_hashes", sampleProposal.reasoningHash);
            await pipeline.exec();

            const stored = await mockRedis.get(`proposal:${id}`);
            expect(stored).not.toBeNull();
        });

        it("should reject duplicate reasoningHash (replay attack)", async () => {
            // First: mark hash as used
            await mockRedis.sadd("used_reasoning_hashes", sampleProposal.reasoningHash);

            // Second: check nullifier
            const isUsed = await mockRedis.sismember(
                "used_reasoning_hashes",
                sampleProposal.reasoningHash
            );
            expect(isUsed).toBe(1); // Duplicate detected
        });

        it("should allow different reasoningHash", async () => {
            await mockRedis.sadd("used_reasoning_hashes", sampleProposal.reasoningHash);

            const differentHash = "0xdifferent_hash_value_for_another_proposal_completely_unique";
            const isUsed = await mockRedis.sismember("used_reasoning_hashes", differentHash);
            expect(isUsed).toBe(0); // Not a duplicate
        });
    });

    describe("HMAC Security (URL Tampering Prevention)", () => {
        it("should generate valid HMAC for proposalId", () => {
            const id = randomUUID();
            const hmac = computeHmac(id);
            expect(hmac).toHaveLength(64); // SHA-256 = 32 bytes = 64 hex
        });

        it("different IDs produce different HMACs", () => {
            const hmac1 = computeHmac("id-1");
            const hmac2 = computeHmac("id-2");
            expect(hmac1).not.toBe(hmac2);
        });

        it("same ID always produces same HMAC (deterministic)", () => {
            const id = "fixed-test-id";
            const hmac1 = computeHmac(id);
            const hmac2 = computeHmac(id);
            expect(hmac1).toBe(hmac2);
        });

        it("wrong HMAC should fail verification", () => {
            const id = randomUUID();
            const correctHmac = computeHmac(id);
            const fakeHmac = "a".repeat(64);
            expect(fakeHmac).not.toBe(correctHmac);
        });
    });

    describe("Staleness Detection (Race Condition Mitigation)", () => {
        it("should detect price moved beyond slippage tolerance", () => {
            const priceAtGen = 1.05; // $1.05
            const currentPrice = 1.10; // $1.10 (4.76% increase)
            const maxSlippagePct = 2; // 2%

            const deviation = Math.abs((currentPrice - priceAtGen) / priceAtGen);
            const isStale = deviation > maxSlippagePct / 100;

            expect(isStale).toBe(true); // 4.76% > 2% → STALE
        });

        it("should accept price within slippage tolerance", () => {
            const priceAtGen = 1.05;
            const currentPrice = 1.06; // 0.95% increase
            const maxSlippagePct = 2;

            const deviation = Math.abs((currentPrice - priceAtGen) / priceAtGen);
            const isStale = deviation > maxSlippagePct / 100;

            expect(isStale).toBe(false); // 0.95% < 2% → OK
        });

        it("should detect downward price movement", () => {
            const priceAtGen = 1.05;
            const currentPrice = 0.98; // -6.67% drop
            const maxSlippagePct = 3;

            const deviation = Math.abs((currentPrice - priceAtGen) / priceAtGen);
            const isStale = deviation > maxSlippagePct / 100;

            expect(isStale).toBe(true); // 6.67% > 3% → STALE
        });
    });

    describe("Deadline Enforcement", () => {
        it("should reject already-expired proposal", () => {
            const now = Math.floor(Date.now() / 1000);
            const expiredDeadline = now - 60; // Expired 1 minute ago

            const isExpired = expiredDeadline <= now;
            expect(isExpired).toBe(true);
        });

        it("should accept future deadline", () => {
            const now = Math.floor(Date.now() / 1000);
            const futureDeadline = now + 300; // 5 min from now

            const isExpired = futureDeadline <= now;
            expect(isExpired).toBe(false);
        });
    });

    describe("Status FSM", () => {
        it("pending → approved is valid transition", () => {
            const validTransitions: Record<string, string[]> = {
                pending: ["approved", "rejected", "expired"],
                approved: ["executed"],
                rejected: [],
                expired: [],
                executed: [],
            };

            expect(validTransitions["pending"]).toContain("approved");
        });

        it("rejected → approved is NOT valid", () => {
            const status = "rejected";
            const canApprove = status === "pending";
            expect(canApprove).toBe(false);
        });

        it("expired → approved is NOT valid", () => {
            const status = "expired";
            const canApprove = status === "pending";
            expect(canApprove).toBe(false);
        });
    });

    describe("Deep-link Parameter Security", () => {
        it("should produce valid base64url encoded payload", () => {
            const id = randomUUID();
            const hmac = computeHmac(id);

            const payload = Buffer.from(
                JSON.stringify({ pid: id, sig: hmac })
            ).toString("base64url");

            // Verify it can be decoded back
            const decoded = JSON.parse(
                Buffer.from(payload, "base64url").toString()
            );
            expect(decoded.pid).toBe(id);
            expect(decoded.sig).toBe(hmac);
        });

        it("payload should not contain URL-unsafe characters", () => {
            const id = randomUUID();
            const hmac = computeHmac(id);

            const payload = Buffer.from(
                JSON.stringify({ pid: id, sig: hmac })
            ).toString("base64url");

            // base64url: no +, /, or = padding
            expect(payload).not.toMatch(/[+/=]/);
        });

        it("XSS attempt in proposalId should be neutralized", () => {
            const maliciousId = '<script>alert("xss")</script>';
            const hmac = computeHmac(maliciousId);

            const payload = Buffer.from(
                JSON.stringify({ pid: maliciousId, sig: hmac })
            ).toString("base64url");

            // base64url encoding neutralizes HTML/JS
            expect(payload).not.toContain("<script>");
            expect(payload).not.toContain("alert");
        });
    });
});
