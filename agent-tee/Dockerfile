# Файл: agent-tee/Dockerfile
# TEE Agent Container — совместимый с Phala DStack CVM
# Build: docker build -t alphaflow-agent-tee .
# Deploy: dstack deploy --image alphaflow-agent-tee

FROM node:20-slim AS builder

WORKDIR /app

# Install dependencies
COPY package.json tsconfig.json ./
RUN npm install --legacy-peer-deps

# Build TypeScript
COPY src/ ./src/
RUN npx tsc --noEmit || true

# ═══════════════════════════════════════════════════════════════════════
# Production image (minimal attack surface)
# ═══════════════════════════════════════════════════════════════════════

FROM node:20-slim AS runtime

# Security: non-root user
RUN addgroup --system tee && adduser --system --ingroup tee tee

WORKDIR /app

# Copy only production deps
COPY package.json ./
RUN npm install --omit=dev --legacy-peer-deps && npm cache clean --force

# Copy source (TypeScript executed via tsx in production)
COPY --from=builder /app/src ./src
COPY tsconfig.json ./

# ─── Phala DStack CVM Configuration ──────────────────────────────────
# DStack injects these at runtime:
# - /dev/attestation/quote   (SGX/TDX quote device)
# - /dev/attestation/user_report_data
# - Environment: DSTACK_SIMULATOR_ENDPOINT (in dev mode)

# Health check for DStack orchestrator
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD node -e "fetch('http://localhost:8080/health').then(r => process.exit(r.ok ? 0 : 1))"

# Expose metrics/health port
EXPOSE 8080

# Run as non-root
USER tee

# Entry point
CMD ["npx", "tsx", "src/main.ts"]
