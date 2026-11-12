# Image of the market-data service. Two stages: the build stage compiles TypeScript, the runtime stage holds only
# production dependencies, the compiled code and the SQL migrations. The base image is pinned by tag and digest
# (the same Node.js major as "engines" in package.json); Dependabot proposes updates.

# --- build stage -------------------------------------------------------------------------------------------
FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS build
WORKDIR /app

# Dependencies first, so this layer stays cached while only the source changes.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- runtime stage -----------------------------------------------------------------------------------------
FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# dist/ holds the service (main.js) and the three commands run by hand inside the container:
# "npm run replay" (the projection rebuild of the REQ-12 demo), "npm run backfill" (the one-off load before go-live)
# and "npm run parked" (see README.md).
COPY --from=build /app/dist ./dist
# The whole tree: migrations/shared (the shared schema) and migrations/tenant (applied to every tenant schema). The
# migrator finds both next to dist/ (../../../migrations from dist/adapters/postgres).
COPY migrations ./migrations
# The GraphQL schema is the API contract and the service builds its schema from it at start (src/web/graphql/endpoint.ts
# reads ../../../contracts/graphql/schema.graphql from dist/web/graphql). Only this folder of contracts/ goes into the image.
COPY contracts/graphql ./contracts/graphql

# The base image's unprivileged user; the Helm chart also enforces a non-root user and a read-only file system.
USER node
# 8080: the public API and the health probes (the gateway routes /v1/market-data). market-data has no internal port.
EXPOSE 8080
CMD ["node", "dist/main.js"]
