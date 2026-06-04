// ═══════════════════════════════════════════════════════════════════════════════
// AlphaFlow Suite — frontend/src/hooks/useAuthJWT.ts
// SIWE (EIP-4361) Authentication → BFF JWT
//
// FLOW:
//   1. Wallet connects → useAccount fires
//   2. Construct EIP-4361 SIWE message
//   3. Sign with EOA via useSignMessage
//   4. POST { message, signature, address } → /auth/verify
//   5. BFF returns { token: "jwt..." }
//   6. Store JWT in memory + localStorage
//   7. WebSocketProvider initializes only when jwt !== null
//
// SECURITY:
//   - Nonce fetched from BFF to prevent replay attacks
//   - JWT stored with key "alphaflow_jwt" in localStorage
//   - Token cleared on disconnect
// ═══════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback, useRef } from "react";
import { useAccount, useSignMessage, useChainId } from "wagmi";
import { SiweMessage } from "siwe";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuthState {
  /** JWT token (null = not authenticated) */
  jwt: string | null;
  /** Auth flow in progress */
  isAuthenticating: boolean;
  /** Error message if auth fails */
  error: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BFF_BASE_URL = import.meta.env.VITE_BFF_HTTP_URL ?? "https://bff.alphaflow.suite";
const JWT_STORAGE_KEY = "alphaflow_jwt";

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useAuthJWT() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { signMessageAsync } = useSignMessage();

  const [state, setState] = useState<AuthState>({
    jwt: localStorage.getItem(JWT_STORAGE_KEY),
    isAuthenticating: false,
    error: null,
  });

  const authInFlightRef = useRef(false);
  const prevAddressRef = useRef<string | undefined>(undefined);

  // ─── Fetch Nonce from BFF ───────────────────────────────────────────────────

  const fetchNonce = useCallback(async (): Promise<string> => {
    const res = await fetch(`${BFF_BASE_URL}/auth/nonce`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!res.ok) {
      throw new Error(`Nonce fetch failed: ${res.status}`);
    }

    const data = await res.json();
    return data.nonce as string;
  }, []);

  // ─── SIWE Sign + Verify ─────────────────────────────────────────────────────

  const authenticate = useCallback(async () => {
    if (!address || !isConnected) return;
    if (authInFlightRef.current) return;

    authInFlightRef.current = true;
    setState((prev) => ({ ...prev, isAuthenticating: true, error: null }));

    try {
      // 1. Get nonce from BFF
      const nonce = await fetchNonce();

      // 2. Construct SIWE message (EIP-4361)
      const siweMessage = new SiweMessage({
        domain: window.location.host,
        address,
        statement: "Sign in to AlphaFlow Suite",
        uri: window.location.origin,
        version: "1",
        chainId,
        nonce,
        issuedAt: new Date().toISOString(),
      });

      const messageString = siweMessage.prepareMessage();

      // 3. Sign with wallet
      const signature = await signMessageAsync({ message: messageString });

      // 4. Verify on BFF → get JWT
      const verifyRes = await fetch(`${BFF_BASE_URL}/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: messageString,
          signature,
          address,
        }),
      });

      if (!verifyRes.ok) {
        const body = await verifyRes.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `Verify failed: ${verifyRes.status}`
        );
      }

      const { token } = (await verifyRes.json()) as { token: string };

      // 5. Store JWT
      localStorage.setItem(JWT_STORAGE_KEY, token);
      setState({ jwt: token, isAuthenticating: false, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Authentication failed";

      // If user rejected the signature, don't show scary error
      const isUserRejection =
        message.includes("User rejected") ||
        message.includes("user rejected") ||
        message.includes("ACTION_REJECTED");

      setState({
        jwt: null,
        isAuthenticating: false,
        error: isUserRejection ? "Signature rejected by user" : message,
      });

      localStorage.removeItem(JWT_STORAGE_KEY);
    } finally {
      authInFlightRef.current = false;
    }
  }, [address, isConnected, chainId, signMessageAsync, fetchNonce]);

  // ─── Logout ─────────────────────────────────────────────────────────────────

  const logout = useCallback(() => {
    localStorage.removeItem(JWT_STORAGE_KEY);
    setState({ jwt: null, isAuthenticating: false, error: null });
  }, []);

  // ─── Auto-authenticate on connect / clear on disconnect ─────────────────────

  useEffect(() => {
    if (isConnected && address) {
      // New address or first connect → authenticate
      if (prevAddressRef.current !== address) {
        prevAddressRef.current = address;

        // Check if existing JWT is still for this address
        const existingJwt = localStorage.getItem(JWT_STORAGE_KEY);
        if (!existingJwt) {
          authenticate();
        } else {
          // Validate stored JWT belongs to current address (decode payload)
          try {
            const payload = JSON.parse(atob(existingJwt.split(".")[1]));
            if (payload.address?.toLowerCase() !== address.toLowerCase()) {
              // JWT is for a different address → re-auth
              localStorage.removeItem(JWT_STORAGE_KEY);
              setState((prev) => ({ ...prev, jwt: null }));
              authenticate();
            }
          } catch {
            // Malformed JWT → re-auth
            localStorage.removeItem(JWT_STORAGE_KEY);
            authenticate();
          }
        }
      }
    } else {
      // Disconnected → clear state
      prevAddressRef.current = undefined;
      logout();
    }
  }, [isConnected, address, authenticate, logout]);

  return { token: state.jwt, isAuthenticating: state.isAuthenticating, error: state.error, logout };
}
