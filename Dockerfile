# syntax=docker/dockerfile:1.7

# The Selkies web client the viewer proxy serves (services/proxy/
# selkies-client-files.ts). Same release as the instance image installs
# (obs-cloud-container's Dockerfile): bump both together, the client and the
# server speak one protocol version.
FROM debian:bookworm-slim AS selkies-web
ARG SELKIES_VERSION=2.2.1
ARG SELKIES_SHA256=4bc87969acf45951fbf6148b9d7e23717df58411e5a47d361b99b78842caaa8c
ADD --checksum=sha256:${SELKIES_SHA256} \
    https://github.com/selkies-project/selkies/releases/download/${SELKIES_VERSION}/selkies-${SELKIES_VERSION}-ubuntu24.04-amd64.deb \
    /tmp/selkies.deb
RUN dpkg-deb -x /tmp/selkies.deb /tmp/selkies \
 && web="$(find /tmp/selkies -type d -name selkies_web -path '*/site-packages/selkies/*' | head -n1)" \
 && test -f "$web/index.html" \
 && cp -a "$web" /selkies-web \
 && find /selkies-web \( -name '*.py' -o -name __pycache__ \) -prune -exec rm -rf {} +

FROM oven/bun:1

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY --from=selkies-web /selkies-web ./selkies-web
COPY src ./src
COPY tsconfig.json ./

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
