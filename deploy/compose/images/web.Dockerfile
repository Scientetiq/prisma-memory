# The web image of the public install contains the pinned Node runtime and the built Next.js panel and workplace.
# Setup builds it from the repository root (build context ../..) using pnpm-lock.yaml. The context allowlist keeps
# tests, local settings and credentials out. Compose mounts a writable cache over the panel's .next/cache directory.
# Two stages: the build stage installs the development packages and builds the panel; the runtime stage installs the
# production packages only and takes the build output from the build stage.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages/admin/package.json ./packages/admin/
RUN corepack enable && pnpm install --frozen-lockfile --filter "@memory/admin..."

COPY packages/admin/next.config.mjs packages/admin/tsconfig.json \
     packages/admin/client-peer.mjs packages/admin/request-locale.mjs ./packages/admin/
# Build-time tools of the interface languages, loaded by next.config.mjs (two loaders and the client manifest) and by
# each other. The rest of packages/admin/tools stays out of the image.
COPY packages/admin/tools/i18n/client-catalog.cjs packages/admin/tools/i18n/client-manifest.cjs \
     packages/admin/tools/i18n/client-split.cjs packages/admin/tools/i18n/route-messages.cjs \
     ./packages/admin/tools/i18n/
COPY packages/admin/src ./packages/admin/src
# The build cache is not shipped: the runtime image gets an empty .next/cache, and compose mounts a tmpfs over it.
RUN pnpm --filter @memory/admin build && rm -rf packages/admin/.next/cache

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
LABEL org.opencontainers.image.licenses="LicenseRef-Prisma-Memory"
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages/admin/package.json ./packages/admin/
RUN corepack enable && pnpm install --frozen-lockfile --prod --filter "@memory/admin..." && pnpm store prune

COPY packages/admin/next.config.mjs packages/admin/tsconfig.json \
     packages/admin/client-peer.mjs packages/admin/request-locale.mjs ./packages/admin/
COPY packages/admin/tools/i18n/client-catalog.cjs packages/admin/tools/i18n/client-manifest.cjs \
     packages/admin/tools/i18n/client-split.cjs packages/admin/tools/i18n/route-messages.cjs \
     ./packages/admin/tools/i18n/
COPY packages/admin/src ./packages/admin/src
# What the build wrote: the Next.js output, the client message data and the Next.js type stub.
COPY --from=build /app/packages/admin/.next ./packages/admin/.next
COPY --from=build /app/packages/admin/.i18n ./packages/admin/.i18n
COPY --from=build /app/packages/admin/next-env.d.ts ./packages/admin/
RUN mkdir -p packages/admin/.next/cache \
    && chown -R root:root /app \
    && chmod -R a+rX,go-w /app

WORKDIR /app/packages/admin
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--import=./client-peer.mjs
EXPOSE 3000
USER 1000:1000
CMD ["node", "/app/node_modules/next/dist/bin/next", "start", "-p", "3000"]
