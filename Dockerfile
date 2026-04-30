# MLP Core — Dockerfile
#
# Multi-stage build:
#   Stage 1 — builder: compiles TypeScript to JavaScript
#   Stage 2 — runner: runs compiled output, no dev dependencies
#
# Environment variables required at runtime:
#   MLP_ENV=production
#   ANTHROPIC_API_KEY
#   FALKORDB_HOST
#   FALKORDB_PORT

# ── Stage 1: Builder ──────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json ./

# Install all dependencies including devDependencies for build
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript
RUN npm run build

# ── Stage 2: Runner ───────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# MLP runs on stdio transport for MCP
# No port exposure needed for MCP stdio mode
# PORT is only used if a health check endpoint is added later

ENV MLP_ENV=production
ENV NODE_ENV=production

# Run the compiled server
CMD ["node", "dist/src/index.js"]
