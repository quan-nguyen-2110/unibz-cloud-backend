# SquadUp API — multi-stage Node 20 Alpine image for ECS Fargate

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:20-alpine AS runner
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY --from=deps --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --chown=nodejs:nodejs src ./src
COPY --chown=nodejs:nodejs package.json ./

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:8080/healthz || exit 1

USER nodejs
CMD ["node", "src/server.js"]
