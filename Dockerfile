# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Native build deps (argon2) + openssl for Prisma engines
RUN apk add --no-cache python3 make g++ openssl

COPY package*.json ./
# HUSKY=0 avoids prepare/husky failure without .git
ENV HUSKY=0
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY . .
RUN npm run build


# ─── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:20-alpine AS production

ENV NODE_ENV=production
ENV HUSKY=0

WORKDIR /app

RUN apk add --no-cache python3 make g++ openssl wget

COPY package*.json ./
# Do NOT use --ignore-scripts — argon2 needs its install script / native build
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY prisma ./prisma
COPY src/mail/templates ./dist/src/mail/templates

RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
  && mkdir -p /app/uploads \
  && chown -R appuser:appgroup /app

USER appuser

# Railway injects PORT at runtime — do not hardcode in HEALTHCHECK only
EXPOSE 4700

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-4700}/api/v1/health" || exit 1

CMD ["node", "dist/src/main"]
