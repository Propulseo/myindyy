# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22.14.0-bookworm-slim
ARG PNPM_VERSION=11.12.0

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
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates python3 tini \
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
    HERMES_PYTHON=/opt/hermes/venv/bin/python

LABEL org.opencontainers.image.title="Indy Codex OAuth cockpit" \
      io.propulseo.indy.hermes-scheduler-sha256="5b4326fffe1b783fd2016a0c5c0bde21c3c8af613cc665897b9f48565d74e3c5"

VOLUME ["/var/lib/indy"]
EXPOSE 6969
USER indy:indy

HEALTHCHECK --interval=30s --timeout=8s --start-period=30s --retries=3 \
  CMD ["node", "dist/server/server/healthcheck.js"]

ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/server/server/container-entrypoint.js"]
