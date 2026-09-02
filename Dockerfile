# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG NODE_IMAGE=node:22.14.0-bookworm-slim@sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b
ARG PNPM_VERSION=11.1.2

FROM ${NODE_IMAGE} AS toolchain
ARG PNPM_VERSION
ENV COREPACK_HOME=/opt/corepack
WORKDIR /app
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate

FROM toolchain AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=indy-pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN pnpm typecheck && pnpm build

FROM toolchain AS production-dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=indy-pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile

FROM ${NODE_IMAGE} AS runtime
ARG APP_UID=10001
ARG APP_GID=10001
ARG DEBIAN_SNAPSHOT=20260801T000000Z
ARG CA_CERTIFICATES_VERSION=20230311+deb12u1
ARG PYTHON3_VERSION=3.11.2-1+b1
ARG TINI_VERSION=0.19.0-1+b3
ADD --checksum=sha256:0d5f444f594e48c1e16a41d8fc628a09b24c658916a1274025c2330f2a802bed \
    https://snapshot.debian.org/file/7fb3564b34eddff789d6ea4b5c346daaea7b7c1e /tmp/ca-certificates.deb
RUN dpkg-deb --extract /tmp/ca-certificates.deb /tmp/ca-bootstrap \
    && install -d -m 0755 /etc/ssl/certs \
    && cat /tmp/ca-bootstrap/usr/share/ca-certificates/mozilla/*.crt > /etc/ssl/certs/ca-certificates.crt \
    && rm -rf /tmp/ca-bootstrap /tmp/ca-certificates.deb \
    && rm -f /etc/apt/sources.list.d/debian.sources \
    && printf '%s\n' \
      "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/ bookworm main" \
      "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/ bookworm-updates main" \
      "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}/ bookworm-security main" \
      > /etc/apt/sources.list.d/debian-snapshot.list \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install --no-install-recommends -y \
      "ca-certificates=${CA_CERTIFICATES_VERSION}" \
      "python3=${PYTHON3_VERSION}" \
      "tini=${TINI_VERSION}" \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid "${APP_GID}" indy \
    && useradd --uid "${APP_UID}" --gid "${APP_GID}" --home-dir /var/lib/indy --no-create-home --shell /usr/sbin/nologin indy \
    && install -d -o indy -g indy -m 0700 /var/lib/indy /var/lib/hermes \
    && install -d -o indy -g indy -m 0755 /app

WORKDIR /app
COPY --from=production-dependencies --chown=indy:indy /app/node_modules ./node_modules
COPY --from=build --chown=indy:indy /app/dist ./dist
COPY --from=build --chown=indy:indy /app/package.json ./package.json

ENV NODE_ENV=production \
    PORT=6969 \
    MINIONS_HOME=/var/lib/indy \
    DB_PATH=/var/lib/indy/data/indy.db \
    HERMES_HOME=/var/lib/hermes \
    HERMES_AGENT_DIR=/opt/hermes \
    HERMES_PYTHON=/opt/hermes/venv/bin/python \
    HERMES_RUNTIME_MANIFEST_FILE=/run/indy-config/hermes-runtime-manifest.json

LABEL org.opencontainers.image.title="Indy Codex OAuth cockpit" \
      io.propulseo.indy.hermes-scheduler-sha256="5b4326fffe1b783fd2016a0c5c0bde21c3c8af613cc665897b9f48565d74e3c5" \
      io.propulseo.indy.node-base-digest="sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b" \
      io.propulseo.indy.debian-snapshot="20260801T000000Z"

VOLUME ["/var/lib/indy"]
EXPOSE 6969
USER indy:indy

HEALTHCHECK --interval=30s --timeout=8s --start-period=30s --retries=3 \
  CMD ["node", "dist/server/server/healthcheck.js"]

ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/server/server/container-entrypoint.js"]
