# The web image of the public install contains the pinned Node runtime and the built Next.js panel and workplace.
# Setup builds it from the repository root (build context ../..) using pnpm-lock.yaml. The context allowlist keeps
# tests, local settings and credentials out. Compose mounts a writable cache over the panel's .next/cache directory.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
LABEL org.opencontainers.image.licenses="LicenseRef-Prisma-Memory"
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages/admin/package.json ./packages/admin/
RUN corepack enable && pnpm install --frozen-lockfile --filter "@memory/admin..." && pnpm store prune

COPY packages/admin/next.config.mjs packages/admin/tsconfig.json \
     packages/admin/client-peer.mjs packages/admin/request-locale.mjs ./packages/admin/
# Build-time tools of the interface languages, loaded by next.config.mjs (two loaders and the client manifest) and by
# each other. The rest of packages/admin/tools stays out of the image.
COPY packages/admin/tools/i18n/client-catalog.cjs packages/admin/tools/i18n/client-manifest.cjs \
     packages/admin/tools/i18n/client-split.cjs packages/admin/tools/i18n/route-messages.cjs \
     ./packages/admin/tools/i18n/
COPY packages/admin/src ./packages/admin/src
RUN pnpm --filter @memory/admin build \
    && mkdir -p packages/admin/.next/cache \
    && chown -R root:root /app \
    && chmod -R a+rX,go-w /app

WORKDIR /app/packages/admin
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--import=./client-peer.mjs
EXPOSE 3000
USER 1000:1000
CMD ["node", "/app/node_modules/next/dist/bin/next", "start", "-p", "3000"]
