// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — agent-tee/src/test/circuitBreaker.test.ts
// Unit tests for TEE Circuit Breaker module
// ═══════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from "vitest";
import { CircuitBreaker, CriticalHaltError, type MarketConditions } from "../services/circuitBreaker.js";

describe("CircuitBreaker", () => {
    let breaker: CircuitBreaker;

    beforeEach(() => {
        breaker = new CircuitBreaker("https://rpc.mantle.xyz");
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //                        SLIPPAGE CHECKS
    // ═══════════════════════════════════════════════════════════════════════════

    describe("Slippage validation", () => {
        it("should PASS when slippage is within threshold (2%)", async () => {
            const result = await breaker.validateMarketConditions({
                estimatedSlippage: 0.02, // 2% < 3% MAX
                currentGasPriceWei: 100_000_000n, // 0.1 gwei (low)
            });

            expect(result.passed).toBe(true);
            expect(result.checks.slippage.passed).toBe(true);
            expect(result.checks.slippage.value).toBe(0.02);
            expect(result.checks.slippage.threshold).toBe(0.03);
        });

        it("should PASS at exactly 3% (boundary)", async () => {
            const result = await breaker.validateMarketConditions({
                estimatedSlippage: 0.03, // exactly MAX
                currentGasPriceWei: 100_000_000n,
            });

            expect(result.passed).toBe(true);
            expect(result.checks.slippage.passed).toBe(true);
        });

        it("should HALT when slippage exceeds 3%", async () => {
            await expect(
                breaker.validateMarketConditions({
                    estimatedSlippage: 0.05, // 5% > 3% MAX
                    currentGasPriceWei: 100_000_000n,
                })
            ).rejects.toThrow(CriticalHaltError);

            try {
                await breaker.validateMarketConditions({
                    estimatedSlippage: 0.05,
                    currentGasPriceWei: 100_000_000n,
                });
            } catch (err) {
                expect(err).toBeInstanceOf(CriticalHaltError);
                const halt = err as CriticalHaltError;
                expect(halt.message).toContain("CRITICAL_HALT");
                expect(halt.reason).toContain("Slippage");
                expect(halt.reason).toContain("5.00%");
                expect(halt.details.checks.slippage.passed).toBe(false);
            }
        });

        it("should HALT with extreme slippage (10%)", async () => {
            await expect(
                breaker.validateMarketConditions({
                    estimatedSlippage: 0.10,
                    currentGasPriceWei: 100_000_000n,
                })
            ).rejects.toThrow("CRITICAL_HALT");
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //                        GAS SPIKE CHECKS
    // ═══════════════════════════════════════════════════════════════════════════

    describe("Gas spike detection", () => {
        it("should PASS during bootstrapping period (< 5 samples)", async () => {
            // First call — no history yet
            const result = await breaker.validateMarketConditions({
                estimatedSlippage: 0.01,
                currentGasPriceWei: 50_000_000_000n, // 50 gwei
            });

            expect(result.passed).toBe(true);
            expect(result.checks.gasSpike.passed).toBe(true);
            expect(result.checks.gasSpike.baselineGwei).toContain("bootstrapping");
        });

        it("should PASS when gas is stable (within 1.5x)", async () => {
            const baseGas = 100_000_000_000n; // 100 gwei baseline

            // Seed history with 6 samples at stable price
            for (let i = 0; i < 6; i++) {
                await breaker.validateMarketConditions({
                    estimatedSlippage: 0.01,
                    currentGasPriceWei: baseGas,
                });
            }

            // Check with 1.3x — should pass
            const result = await breaker.validateMarketConditions({
                estimatedSlippage: 0.01,
                currentGasPriceWei: 130_000_000_000n, // 130 gwei = 1.3x
            });

            expect(result.passed).toBe(true);
            expect(result.checks.gasSpike.passed).toBe(true);
            expect(result.checks.gasSpike.multiplier).toBeCloseTo(1.3, 1);
        });

        it("should HALT when gas spikes > 1.5x median", async () => {
            const baseGas = 100_000_000_000n; // 100 gwei

            // Seed with stable history
            for (let i = 0; i < 6; i++) {
                await breaker.validateMarketConditions({
                    estimatedSlippage: 0.01,
                    currentGasPriceWei: baseGas,
                });
            }

            // Spike to 2x — should HALT
            await expect(
                breaker.validateMarketConditions({
                    estimatedSlippage: 0.01,
                    currentGasPriceWei: 200_000_000_000n, // 200 gwei = 2x
                })
            ).rejects.toThrow(CriticalHaltError);
        });

        it("should PASS at exactly 1.5x boundary", async () => {
            const baseGas = 100_000_000_000n;

            for (let i = 0; i < 6; i++) {
                await breaker.validateMarketConditions({
                    estimatedSlippage: 0.01,
                    currentGasPriceWei: baseGas,
                });
            }

            // Exactly 1.5x — should pass (<=)
            const result = await breaker.validateMarketConditions({
                estimatedSlippage: 0.01,
                currentGasPriceWei: 150_000_000_000n,
            });

            expect(result.passed).toBe(true);
            expect(result.checks.gasSpike.multiplier).toBeCloseTo(1.5, 1);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //                    ORACLE DEVIATION CHECKS
    // ═══════════════════════════════════════════════════════════════════════════

    describe("Oracle price deviation", () => {
        it("should PASS when prices are aligned (< 2%)", async () => {
            const result = await breaker.validateMarketConditions({
                estimatedSlippage: 0.01,
                currentGasPriceWei: 100_000_000n,
                oraclePrice: 1000.0, // $1000 oracle
                spotPrice: 1015.0,   // $1015 spot = 1.5% deviation
            });

            expect(result.passed).toBe(true);
            expect(result.checks.oracleDeviation.passed).toBe(true);
            expect(result.checks.oracleDeviation.deviation).toBeCloseTo(0.015, 3);
        });

        it("should HALT when oracle deviation exceeds 2%", async () => {
            await expect(
                breaker.validateMarketConditions({
                    estimatedSlippage: 0.01,
                    currentGasPriceWei: 100_000_000n,
                    oraclePrice: 1000.0,
                    spotPrice: 1030.0, // 3% deviation > 2% MAX
                })
            ).rejects.toThrow(CriticalHaltError);
        });

        it("should detect downward deviation (spot < oracle)", async () => {
            await expect(
                breaker.validateMarketConditions({
                    estimatedSlippage: 0.01,
                    currentGasPriceWei: 100_000_000n,
                    oraclePrice: 1000.0,
                    spotPrice: 970.0, // -3% deviation
                })
            ).rejects.toThrow("CRITICAL_HALT");
        });

        it("should PASS when oracle/spot prices not provided (skip)", async () => {
            const result = await breaker.validateMarketConditions({
                estimatedSlippage: 0.01,
                currentGasPriceWei: 100_000_000n,
                // No oracle/spot prices — skipped
            });

            expect(result.passed).toBe(true);
            expect(result.checks.oracleDeviation.passed).toBe(true);
            expect(result.checks.oracleDeviation.deviation).toBe(0);
        });

        it("should PASS at exactly 2% boundary", async () => {
            const result = await breaker.validateMarketConditions({
                estimatedSlippage: 0.01,
                currentGasPriceWei: 100_000_000n,
                oraclePrice: 1000.0,
                spotPrice: 1020.0, // exactly 2%
            });

            expect(result.passed).toBe(true);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //                    COMBINED / MULTI-VIOLATION
    // ═══════════════════════════════════════════════════════════════════════════

    describe("Multi-violation scenarios", () => {
        it("should report all violations in HALT reason", async () => {
            // Seed gas history first
            for (let i = 0; i < 6; i++) {
                await breaker.validateMarketConditions({
                    estimatedSlippage: 0.01,
                    currentGasPriceWei: 100_000_000_000n,
                });
            }

            try {
                await breaker.validateMarketConditions({
                    estimatedSlippage: 0.05,             // 5% > 3% (FAIL)
                    currentGasPriceWei: 200_000_000_000n, // 2x > 1.5x (FAIL)
                    oraclePrice: 1000.0,
                    spotPrice: 1050.0,                   // 5% > 2% (FAIL)
                });
                expect.fail("Should have thrown");
            } catch (err) {
                const halt = err as CriticalHaltError;
                expect(halt.reason).toContain("Slippage");
                expect(halt.reason).toContain("Gas spike");
                expect(halt.reason).toContain("Oracle deviation");
            }
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //                    METRICS & STATE
    // ═══════════════════════════════════════════════════════════════════════════

    describe("Metrics tracking", () => {
        it("should track total checks and halts", async () => {
            // One passing check
            await breaker.validateMarketConditions({
                estimatedSlippage: 0.01,
                currentGasPriceWei: 100_000_000n,
            });

            // One failing check
            try {
                await breaker.validateMarketConditions({
                    estimatedSlippage: 0.05,
                    currentGasPriceWei: 100_000_000n,
                });
            } catch { /* expected */ }

            const metrics = breaker.getMetrics();
            expect(metrics.totalChecks).toBe(2);
            expect(metrics.haltsTriggered).toBe(1);
            expect(metrics.slippageHalts).toBe(1);
            expect(metrics.lastHaltReason).toContain("Slippage");
        });

        it("should report cooldown state after halt", async () => {
            expect(breaker.isInCooldown()).toBe(false);

            try {
                await breaker.validateMarketConditions({
                    estimatedSlippage: 0.10,
                    currentGasPriceWei: 100_000_000n,
                });
            } catch { /* expected */ }

            expect(breaker.isInCooldown()).toBe(true);
        });

        it("should reset gas history on demand", async () => {
            await breaker.validateMarketConditions({
                estimatedSlippage: 0.01,
                currentGasPriceWei: 100_000_000_000n,
            });

            expect(breaker.getMetrics().gasHistoryLength).toBe(1);

            breaker.resetGasHistory();
            expect(breaker.getMetrics().gasHistoryLength).toBe(0);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //                    ERROR TYPE VERIFICATION
    // ═══════════════════════════════════════════════════════════════════════════

    describe("CriticalHaltError shape", () => {
        it("should have correct name and structure", async () => {
            try {
                await breaker.validateMarketConditions({
                    estimatedSlippage: 0.10,
                    currentGasPriceWei: 100_000_000n,
                });
                expect.fail("Should throw");
            } catch (err) {
                expect(err).toBeInstanceOf(CriticalHaltError);
                expect(err).toBeInstanceOf(Error);
                const halt = err as CriticalHaltError;
                expect(halt.name).toBe("CriticalHaltError");
                expect(halt.details).toBeDefined();
                expect(halt.details.passed).toBe(false);
                expect(halt.details.checkedAt).toBeGreaterThan(0);
            }
        });
    });
});
