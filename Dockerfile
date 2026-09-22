# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install only production-necessary build deps
COPY package*.json ./
RUN npm ci --ignore-scripts

# Copy source & generate Prisma client, then build
COPY prisma ./prisma
RUN npx prisma generate

COPY . .
RUN npm run build


# ─── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:20-alpine AS production

ENV NODE_ENV=production

WORKDIR /app

# Only copy what's needed at runtime
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY prisma ./prisma
COPY src/mail/templates ./dist/mail/templates

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 4700

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:4700/api/v1/health || exit 1

CMD ["node", "dist/main"]
