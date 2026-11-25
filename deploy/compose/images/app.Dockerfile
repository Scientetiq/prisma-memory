# The app image of the public install contains the pinned Node runtime, the gateway and workers, their workspace
# dependencies, the contracts they read and the administrator's CLI. Setup builds it from the repository root
# (build context ../..) using pnpm-lock.yaml. The context allowlist keeps tests, local settings and credentials out.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
LABEL org.opencontainers.image.licenses="LicenseRef-Prisma-Memory"
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages/connectors/package.json ./packages/connectors/
COPY packages/gateway/package.json ./packages/gateway/
COPY packages/i18n/package.json ./packages/i18n/
COPY packages/mcp-core/package.json ./packages/mcp-core/
COPY packages/shared/package.json ./packages/shared/
COPY packages/wire/package.json ./packages/wire/
COPY packages/workers/package.json ./packages/workers/
RUN corepack enable \
    && pnpm install --frozen-lockfile --prod --filter "@memory/gateway..." --filter "@memory/workers..." \
    && pnpm store prune

COPY contracts ./contracts
COPY packages/connectors/tsconfig.json ./packages/connectors/
COPY packages/connectors/src ./packages/connectors/src
COPY packages/gateway/tsconfig.json ./packages/gateway/
COPY packages/gateway/src ./packages/gateway/src
COPY packages/i18n/tsconfig.json ./packages/i18n/
COPY packages/i18n/src ./packages/i18n/src
COPY packages/mcp-core/tsconfig.json ./packages/mcp-core/
COPY packages/mcp-core/src ./packages/mcp-core/src
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src
COPY packages/wire/tsconfig.json ./packages/wire/
COPY packages/wire/src ./packages/wire/src
COPY packages/workers/tsconfig.json ./packages/workers/
COPY packages/workers/src ./packages/workers/src
COPY tools/admin/memory-admin-cli.mjs tools/admin/first-admin.mjs ./tools/admin/
COPY --chmod=0555 deploy/compose/images/memory-admin /usr/local/bin/memory-admin

RUN chown -R root:root /app && chmod -R a+rX,go-w /app
ENV NODE_ENV=production
USER 1000:1000
CMD ["node", "--import", "tsx", "packages/gateway/src/index.ts"]
