# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src/ src/

RUN npm run build

# Stage 2: Runtime
FROM node:20-alpine

LABEL org.opencontainers.image.title="nexus-agent"
LABEL org.opencontainers.image.version="0.1.0"
LABEL org.opencontainers.image.description="An open-source, MCP-native personal AI agent framework"
LABEL org.opencontainers.image.maintainer="eli"

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ dist/

ENV NODE_ENV=production

RUN addgroup -S nexus && adduser -S nexus -G nexus
RUN mkdir -p /data && chown nexus:nexus /data
USER nexus

ENTRYPOINT ["node", "dist/cli/index.js"]
