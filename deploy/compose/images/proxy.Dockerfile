# The TLS front of the public install (compose.proxy.yaml, profile proxy): Caddy with deploy/compose/Caddyfile, built
# on the spot. The base image is pinned by its index digest. The file capability that lets the binary bind ports below
# 1024 is removed: every service runs as the installing user with all capabilities dropped, so Caddy listens on 8080
# and 8443 inside, and compose publishes the host's 80 and 443 to them. No certificate or key is in this image: Caddy
# obtains them at the first start and keeps them under MEMORY_HOME/data/proxy.
FROM caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0
LABEL org.opencontainers.image.licenses="LicenseRef-Prisma-Memory"
RUN setcap -r /usr/bin/caddy
COPY deploy/compose/Caddyfile /etc/caddy/Caddyfile
