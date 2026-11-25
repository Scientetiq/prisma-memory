# The demo profile's model simulator contains the pinned Node runtime and the model gateway from packages/mocks.
# Setup builds the image from the repository root using pnpm-lock.yaml and the build context allowlist beside this file.
# The simulator generates deterministic answers. It needs no provider or provider key. Compose keeps it on the internal
# models network, with no route out. Setup includes it only with --demo.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
LABEL org.opencontainers.image.licenses="LicenseRef-Prisma-Memory"
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/mocks/package.json ./packages/mocks/
RUN corepack enable \
    && pnpm install --frozen-lockfile --prod --filter "@memory/mocks..." \
    && pnpm store prune

COPY packages/mocks/src ./packages/mocks/src
RUN chown -R root:root /app && chmod -R a+rX,go-w /app
ENV NODE_ENV=production \
    PORT=8700 \
    MOCK_MODEL_HOST=0.0.0.0 \
    MOCK_MODEL_MODE=generate \
    MOCK_MODEL_PROTOCOL=openai \
    MOCK_MODEL_IDS=demo-llm,demo-embeddings,demo-reranker
EXPOSE 8700
USER 1000:1000
CMD ["node", "--import", "tsx", "packages/mocks/src/model-gateway.ts"]
