FROM node:24-bookworm-slim AS build

WORKDIR /opt/albusto/apps-runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

FROM build AS test
COPY src ./src
COPY reference-apps ./reference-apps
COPY test ./test
RUN npm test

FROM build AS production-dependencies
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /opt/albusto/apps-runtime

COPY --from=production-dependencies /opt/albusto/apps-runtime/node_modules ./node_modules
COPY package.json ./package.json
COPY src ./src
COPY reference-apps ./reference-apps

EXPOSE 4010
USER node
ENTRYPOINT ["node", "--no-node-snapshot", "src/server.js"]
