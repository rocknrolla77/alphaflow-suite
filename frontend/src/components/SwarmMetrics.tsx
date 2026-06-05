// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/components/SwarmMetrics.tsx
// Swarm Economy Panel — Byreal Worker Balances + Dispatcher Pool
//
// Visualizes the micro-funding economy:
//   - MicroFundingDispatcher pool balance (MNT)
//   - 3 Byreal worker wallet balances (growing via refunds)
//   - Race winner history
//
// Data sources:
//   - BFF HTTP API: /api/swarm/balances (polling every 10s)
//   - WebSocket: real-time race results
// ═══════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback } from "react";
import { useWebSocket } from "../providers/WebSocketProvider.tsx";

// ─── Types ────────────────────────────────────────────────────────────────────

interface WorkerBalance {
  id: string;
  address: string;
  balance: string; // MNT as string (formatted)
  relayCount: number;
}

interface SwarmState {
  dispatcherBalance: string;
  workers: WorkerBalance[];
  lastRaceWinner: string | null;
  lastRaceTxHash: string | null;
  totalRaces: number;
  loading: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BFF_URL = import.meta.env.VITE_BFF_HTTP_URL ?? "http://localhost:3001";
const POLL_INTERVAL_MS = 10_000;

// Fallback worker addresses (from env or defaults for demo)
const WORKER_ADDRESSES: { id: string; address: string }[] = [
  { id: "byreal-worker-1", address: import.meta.env.VITE_WORKER_1_ADDRESS ?? "0x???1" },
  { id: "byreal-worker-2", address: import.meta.env.VITE_WORKER_2_ADDRESS ?? "0x???2" },
  { id: "byreal-worker-3", address: import.meta.env.VITE_WORKER_3_ADDRESS ?? "0x???3" },
];

// ─── Component ────────────────────────────────────────────────────────────────

export function SwarmMetrics() {
  const { latestInsight } = useWebSocket();

  const [state, setState] = useState<SwarmState>({
    dispatcherBalance: "—",
    workers: WORKER_ADDRESSES.map((w) => ({
      ...w,
      balance: "—",
      relayCount: 0,
    })),
    lastRaceWinner: null,
    lastRaceTxHash: null,
    totalRaces: 0,
    loading: true,
  });

  // ─── Poll Balances from BFF ─────────────────────────────────────────────────

  const fetchBalances = useCallback(async () => {
    try {
      const res = await fetch(`${BFF_URL}/api/swarm/balances`);
      if (res.ok) {
        const data = await res.json();
        setState((prev) => ({
          ...prev,
          dispatcherBalance: data.dispatcherBalance ?? prev.dispatcherBalance,
          workers: data.workers ?? prev.workers,
          loading: false,
        }));
      } else {
        setState((prev) => ({ ...prev, loading: false }));
      }
    } catch {
      // BFF unavailable — use defaults
      setState((prev) => ({ ...prev, loading: false }));
    }
  }, []);

  useEffect(() => {
    fetchBalances();
    const timer = setInterval(fetchBalances, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [fetchBalances]);

  // ─── Track Race Winners from WebSocket ──────────────────────────────────────

  useEffect(() => {
    if (!latestInsight?.workerRace) return;
    const race = latestInsight.workerRace;

    if (race.status === "won" && race.winner) {
      setState((prev) => ({
        ...prev,
        lastRaceWinner: race.winner!,
        lastRaceTxHash: race.txHash ?? null,
        totalRaces: prev.totalRaces + 1,
        workers: prev.workers.map((w) =>
          w.id === race.winner
            ? { ...w, relayCount: w.relayCount + 1 }
            : w
        ),
      }));
    }
  }, [latestInsight]);

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      <h2 className="text-neonCyan text-sm font-bold uppercase tracking-wider mb-4">
        ⚡ Swarm Economy
      </h2>

      {/* Dispatcher Pool */}
      <div className="mb-4 p-3 border border-neonCyan/20 rounded bg-bgDark/30">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-[#9ca3af] uppercase">
            MicroFundingDispatcher Pool
          </span>
          <span className="text-xs text-[#6b7280]">Funds Worker Gas</span>
        </div>
        <div className="text-2xl font-bold text-neonCyan font-mono">
          {state.dispatcherBalance} <span className="text-sm text-[#6b7280]">MNT</span>
        </div>
      </div>

      {/* Worker Balances */}
      <div className="space-y-2 flex-1">
        <span className="text-xs text-[#6b7280] uppercase">Byreal Workers</span>
        {state.workers.map((worker) => (
          <WorkerRow
            key={worker.id}
            worker={worker}
            isWinner={state.lastRaceWinner === worker.id}
          />
        ))}
      </div>

      {/* Race Stats */}
      <div className="mt-4 pt-3 border-t border-neonCyan/10 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-[#6b7280]">Total Races</span>
          <span className="text-[#E0E0E0] font-mono">{state.totalRaces}</span>
        </div>

        {state.lastRaceWinner && (
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-terminalGreen opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-terminalGreen" />
            </span>
            <span className="text-xs text-terminalGreen">
              Last winner: <span className="font-mono">{state.lastRaceWinner}</span>
            </span>
          </div>
        )}

        {state.lastRaceTxHash && (
          <a
            href={`https://mantlescan.xyz/tx/${state.lastRaceTxHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-neonCyan/60 hover:text-neonCyan underline truncate block"
          >
            {state.lastRaceTxHash.slice(0, 20)}...{state.lastRaceTxHash.slice(-8)}
          </a>
        )}
      </div>
    </div>
  );
}

// ─── Worker Row Sub-component ─────────────────────────────────────────────────

function WorkerRow({
  worker,
  isWinner,
}: {
  worker: WorkerBalance;
  isWinner: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between p-2 rounded text-xs border ${
        isWinner
          ? "border-terminalGreen/40 bg-terminalGreen/5"
          : "border-neonCyan/10 bg-bgDark/20"
      }`}
    >
      <div className="flex items-center gap-2">
        {isWinner && (
          <span className="text-terminalGreen animate-pulse">★</span>
        )}
        <div>
          <span className={`font-mono ${isWinner ? "text-terminalGreen" : "text-[#E0E0E0]"}`}>
            {worker.id}
          </span>
          <div className="text-[10px] text-[#4b5563] truncate max-w-[140px]">
            {worker.address}
          </div>
        </div>
      </div>

      <div className="text-right">
        <div className="font-mono text-[#E0E0E0]">
          {worker.balance} <span className="text-[#6b7280]">MNT</span>
        </div>
        <div className="text-[10px] text-[#6b7280]">
          {worker.relayCount} relays
        </div>
      </div>
    </div>
  );
}
