FROM node:24-bookworm-slim AS build
WORKDIR /app
# The native SQLite driver can fall back to compilation on either CPU architecture.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY tsconfig.json ./
COPY apps/api/src apps/api/src
COPY scripts scripts
RUN npm run build:api

FROM build AS production-deps
WORKDIR /production
COPY package.json package-lock.json ./
# Runtime needs only root dependencies; workspace packages are build inputs.
RUN npm pkg delete workspaces && npm ci --omit=dev --workspaces=false

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-deps /production/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/dist/apps/api ./dist/apps/api
RUN mkdir /data && chown node:node /data && chmod 700 /data
USER node
EXPOSE 3001
CMD ["node", "--env-file-if-exists=.env", "dist/apps/api/src/server.js"]
