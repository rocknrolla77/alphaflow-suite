// ═══════════════════════════════════════════════════════════════════════════════
// DEPRECATED — Phase 3 Observer Mode removes SIWE authentication
// This file is kept for reference only. Not imported anywhere.
// ═══════════════════════════════════════════════════════════════════════════════

export function useAuthJWT() {
  return { token: null, isAuthenticating: false, error: null, logout: () => {} };
}
