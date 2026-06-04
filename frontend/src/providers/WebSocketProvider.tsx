// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/providers/WebSocketProvider.tsx
// Singleton WebSocket State Manager via React Context
//
// ИНВАРИАНТЫ:
// - Один WSS-коннект на всё приложение (singleton через Context)
// - Exponential backoff reconnect (max 5 attempts)
// - JWT передаётся как query param ?token=<JWT>
// - Дочерние компоненты получают данные через useWebSocket() без дублирования
// ═══════════════════════════════════════════════════════════════════════════════

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentInsight {
  id: string;
  type: "ARBITRAGE" | "SIGNAL" | "ALERT" | "HEARTBEAT";
  asset?: string;
  action?: "BUY" | "SELL";
  confidence?: number;
  reasoning?: string;
  timestamp: number;
  [key: string]: unknown;
}

interface WebSocketState {
  /** Whether the WSS connection is currently open */
  isConnected: boolean;
  /** Most recent parsed insight from the TEE agent */
  latestInsight: AgentInsight | null;
  /** Reconnect attempt counter (0 = connected or initial) */
  reconnectAttempt: number;
}

interface WebSocketContextValue extends WebSocketState {
  /** Manually trigger reconnection */
  reconnect: () => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1000; // 1s, 2s, 4s, 8s, 16s

// ─── Context ──────────────────────────────────────────────────────────────────

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

interface WebSocketProviderProps {
  children: ReactNode;
  /** JWT token for authentication */
  token: string | null;
}

export function WebSocketProvider({ children, token }: WebSocketProviderProps) {
  const [state, setState] = useState<WebSocketState>({
    isConnected: false,
    latestInsight: null,
    reconnectAttempt: 0,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const mountedRef = useRef(true);

  // ─── Connection Logic ─────────────────────────────────────────────────────

  const connect = useCallback(() => {
    if (!token) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    // Close existing connection if any
    if (wsRef.current) {
      wsRef.current.close(1000, "reconnecting");
      wsRef.current = null;
    }

    const baseUrl =
      import.meta.env.VITE_BFF_WSS_URL ?? "wss://bff.alphaflow.suite/ws";
    const url = `${baseUrl}?token=${encodeURIComponent(token)}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      attemptRef.current = 0;
      setState((prev) => ({
        ...prev,
        isConnected: true,
        reconnectAttempt: 0,
      }));
    };

    ws.onmessage = (event: MessageEvent) => {
      if (!mountedRef.current) return;
      try {
        const insight = JSON.parse(event.data as string) as AgentInsight;
        setState((prev) => ({
          ...prev,
          latestInsight: insight,
        }));
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = (event: CloseEvent) => {
      if (!mountedRef.current) return;

      setState((prev) => ({ ...prev, isConnected: false }));

      // Don't reconnect on intentional close (code 1000) or unmount
      if (event.code === 1000) return;

      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after onerror — reconnect logic lives there
      ws.close();
    };
  }, [token]);

  // ─── Exponential Backoff Reconnect ────────────────────────────────────────

  const scheduleReconnect = useCallback(() => {
    if (attemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
      return; // Give up after max attempts
    }

    const delay = BASE_BACKOFF_MS * Math.pow(2, attemptRef.current);
    attemptRef.current += 1;

    setState((prev) => ({
      ...prev,
      reconnectAttempt: attemptRef.current,
    }));

    reconnectTimerRef.current = setTimeout(() => {
      if (mountedRef.current) {
        connect();
      }
    }, delay);
  }, [connect]);

  // ─── Manual Reconnect ─────────────────────────────────────────────────────

  const reconnect = useCallback(() => {
    attemptRef.current = 0;
    setState((prev) => ({ ...prev, reconnectAttempt: 0 }));
    connect();
  }, [connect]);

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;

      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      if (wsRef.current) {
        wsRef.current.close(1000, "unmount");
        wsRef.current = null;
      }
    };
  }, [connect]);

  // ─── Render ───────────────────────────────────────────────────────────────

  const value: WebSocketContextValue = {
    ...state,
    reconnect,
  };

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Access the singleton WebSocket state.
 * Multiple components calling this hook share the same TCP connection.
 *
 * @returns { isConnected, latestInsight, reconnectAttempt, reconnect }
 */
export function useWebSocket(): WebSocketContextValue {
  const ctx = useContext(WebSocketContext);
  if (!ctx) {
    throw new Error(
      "useWebSocket() must be called within a <WebSocketProvider>"
    );
  }
  return ctx;
}
