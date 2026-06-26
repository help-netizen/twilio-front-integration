# Standalone Smart Slot Engine (SLOT-ENGINE-001). Deployed SEPARATELY from the
# Albusto app; Albusto reaches it via SLOT_ENGINE_URL.
FROM node:20-alpine

WORKDIR /app

# Install production deps first (better layer caching).
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=4500
EXPOSE 4500

# Lightweight liveness check against the engine's /health route.
HEALTHCHECK --interval=30s --timeout=4s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4500)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
