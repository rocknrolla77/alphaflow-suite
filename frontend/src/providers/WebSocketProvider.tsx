// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/providers/WebSocketProvider.tsx
// Observer Mode: PUBLIC WebSocket (no JWT required)
//
// Phase 3 Pivot: WebSocket connects WITHOUT authentication.
// Anyone can observe the swarm activity in real-time.
// BFF broadcasts agent_insights to all connected clients.
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
  insightHash?: string;
  forwardRequest?: {
    target: string;
    data: string;
    value: string;
    nonce: string;
    deadline: string;
  };
  workerRace?: {
    status: "pending" | "won" | "failed";
    winner?: string;
    winnerAddress?: string;
    txHash?: string;
    participants: string[];
    gasRefund?: string;
  };
  [key: string]: unknown;
}

interface WebSocketState {
  isConnected: boolean;
  latestInsight: AgentInsight | null;
  /** All insights received in this session */
  insights: AgentInsight[];
  reconnectAttempt: number;
}

interface WebSocketContextValue extends WebSocketState {
  reconnect: () => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_BACKOFF_MS = 1000;
const MAX_INSIGHTS_BUFFER = 200;

// ─── Context ──────────────────────────────────────────────────────────────────

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

interface WebSocketProviderProps {
  children: ReactNode;
}

export function WebSocketProvider({ children }: WebSocketProviderProps) {
  const [state, setState] = useState<WebSocketState>({
    isConnected: false,
    latestInsight: null,
    insights: [],
    reconnectAttempt: 0,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const mountedRef = useRef(true);

  // ─── Connection Logic (NO JWT) ────────────────────────────────────────────

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    if (wsRef.current) {
      wsRef.current.close(1000, "reconnecting");
      wsRef.current = null;
    }

    const baseUrl =
      import.meta.env.VITE_BFF_WSS_URL ?? "ws://localhost:3001/ws";
    // Observer mode: no token needed
    const url = baseUrl;

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
        const raw = JSON.parse(event.data as string);

        // Handle different message shapes from BFF
        let insight: AgentInsight;

        if (raw.type === "insight" && raw.data) {
          // Wrapped format from wssBroadcaster
          insight = {
            id: raw.streamId ?? `${Date.now()}`,
            timestamp: (raw.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
            ...raw.data,
          } as AgentInsight;
        } else if (raw.type === "connected") {
          // Welcome message — skip
          return;
        } else {
          // Direct insight format
          insight = raw as AgentInsight;
        }

        if (!insight.id) insight.id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        if (!insight.timestamp) insight.timestamp = Date.now();

        setState((prev) => ({
          ...prev,
          latestInsight: insight,
          insights: [...prev.insights.slice(-(MAX_INSIGHTS_BUFFER - 1)), insight],
        }));
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = (event: CloseEvent) => {
      if (!mountedRef.current) return;
      setState((prev) => ({ ...prev, isConnected: false }));
      if (event.code === 1000) return;
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (attemptRef.current >= MAX_RECONNECT_ATTEMPTS) return;

    const delay = BASE_BACKOFF_MS * Math.pow(2, attemptRef.current);
    attemptRef.current += 1;

    setState((prev) => ({
      ...prev,
      reconnectAttempt: attemptRef.current,
    }));

    reconnectTimerRef.current = setTimeout(() => {
      if (mountedRef.current) connect();
    }, delay);
  }, [connect]);

  const reconnect = useCallback(() => {
    attemptRef.current = 0;
    setState((prev) => ({ ...prev, reconnectAttempt: 0 }));
    connect();
  }, [connect]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close(1000, "unmount");
        wsRef.current = null;
      }
    };
  }, [connect]);

  const value: WebSocketContextValue = { ...state, reconnect };

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useWebSocket(): WebSocketContextValue {
  const ctx = useContext(WebSocketContext);
  if (!ctx) {
    throw new Error("useWebSocket() must be called within <WebSocketProvider>");
  }
  return ctx;
}
