# Indy

**Cockpit privé Propul'SEO pour Hermes Agent**

## Provenance

Indy est un fork privé de [Minions 0.1.27](https://github.com/agent37-platform/minions), sous licence MIT, importé depuis le commit `a0787971cb207fd80f7e54991a52665874fe914a`. Le socle upstream est conservé dans l'historique de cette branche; les adaptations Propul'SEO vivent sous le préfixe de branche `codex/`.

Hermes Agent is powerful, but running real work on it means juggling terminal sessions, losing track of which job finished, and manually checking on long-running tasks. The more you delegate, the harder it gets to manage.

Minions gives you one screen to create, supervise, and review autonomous Hermes Agent work.

Hosted access option on [Agent37](https://www.agent37.com).

## Quick Start

**Prerequisites:** Node.js 20+ and [Hermes Agent](https://hermes-agent.nousresearch.com)

```powershell
pnpm install
$env:INDY_DEV_ACTOR = 'etienne'
pnpm dev
```

Open [http://localhost:6969](http://localhost:6969). The development actor is accepted only when `NODE_ENV=development`, `INDY_DEV_ACTOR=etienne`, and the actual TCP peer is loopback. A request reaching the development server from another machine does not receive this bypass.

Local sqllite db is created on first run and state lives in `~/.minions/`

Check the installed version:

```bash
minions --version
npm view minionsai version
```

The Settings page also shows the version of the running Minions server.

## Private proxy authentication

The first milestone is mono-user: every `/api/**` request must resolve to the server-owned actor `{ id: "etienne" }`. This includes task and mission reads/writes, files, agent settings, scheduled tasks, skills, runtime diagnostics, both SSE families, `/api/health`, and `/api/version`. Static client assets remain public so the proxy can serve the application shell. Health and version are deliberately protected because they reveal internal service and Hermes state; later routes under `/api/health/*` inherit the same boundary.

Production requires all of the following:

1. `INDY_PUBLIC_ORIGIN` is a valid, normalized canonical HTTPS origin.
2. The actual socket peer (`req.socket.remoteAddress`) belongs to a configured private proxy CIDR.
3. `X-Indy-Proxy-Secret` matches the mounted transport-secret file using a timing-safe comparison.
4. `X-Indy-User` is exactly `etienne`.

The application never uses `X-Forwarded-For`, `Forwarded`, `req.ip`, query parameters, or request-body fields as identity. Express `trust proxy` is intentionally not enabled. The reverse proxy must strip any client-supplied `X-Indy-User` and `X-Indy-Proxy-Secret` headers, then inject its own values on the private upstream hop. The Indy port must bind only to the private host/network and must not be reachable directly from the Internet.

The API is same-origin only. Indy emits no wildcard CORS headers and does not enable cross-origin credential sharing. Production does not derive trust from a request's `Host`: `INDY_PUBLIC_ORIGIN` declares the one canonical public HTTPS origin. For a browser request carrying `Origin`, that header must equal the configured origin byte-for-byte, `Host` must equal its canonical host and optional non-default port byte-for-byte, and `Sec-Fetch-Site` must be `same-origin`. Aliases, case variants, an explicit default `:443`, port mismatches, userinfo, ambiguous/multiple values, opaque/malformed origins, and unsafe browser-shaped requests missing either signal return `403` before route handling. The proxy must preserve or set this exact canonical `Host`; forwarded host/protocol headers are not trusted.

An anonymous `OPTIONS /api/**` preflight is not public metadata: it crosses the same authentication boundary and returns `401`. No `Access-Control-Allow-Origin` response is produced. A transport-internal non-browser client may omit both `Origin` and Fetch Metadata and use a different singular `Host`, but only after the actual private source, transport secret, and exact user checks succeed. This exception is for the private proxy hop and trusted internal automation, never ambient browser traffic. Cross-origin API access is intentionally unsupported; if it becomes necessary, it must be a separate exact normalized HTTPS allowlist design, never origin reflection or wildcard credentials.

| Variable | Production meaning |
| --- | --- |
| `INDY_PUBLIC_ORIGIN` | Required canonical HTTPS origin, for example `https://indy.example.com` or `https://indy.example.com:8443`. It must already equal URL origin serialization: lowercase host, no userinfo, path, trailing slash, query, fragment, or redundant `:443`. Missing or malformed values make authentication unavailable. |
| `INDY_PROXY_SECRET_FILE` | Absolute path to the mounted secret file. The file contains at least 32 bytes; one final newline is ignored. The secret itself must not be placed in an environment variable. |
| `INDY_TRUSTED_PROXY_CIDRS` | Comma-separated private proxy addresses or CIDRs, for example `10.20.0.5/32,fd42:1234::5/128`. Public ranges and invalid entries make authentication unavailable. |
| `INDY_DEV_ACTOR` | Optional local-only bypass. It is effective only with the exact value `etienne`, `NODE_ENV=development`, and an actual loopback socket. It is ignored in test and production. |

Create and mount a distinct high-entropy transport secret with restrictive permissions, for example:

```bash
umask 077
openssl rand -hex 32 > /run/secrets/indy-proxy
```

Configure the proxy to read the same secret from its secret store and inject it upstream; never expose it to browser JavaScript or proxy access logs. Set `INDY_PUBLIC_ORIGIN=https://indy.example.com`, set `INDY_PROXY_SECRET_FILE=/run/secrets/indy-proxy`, and restrict `INDY_TRUSTED_PROXY_CIDRS` to the proxy's real private source network. The proxy must send `Host: indy.example.com` on browser traffic. Missing or invalid production configuration fails closed with `503`. Missing or invalid transport credentials return the same generic `401`; a trusted, transport-authenticated identity other than exact `etienne` returns `403`.

## Features

- **Kanban board**: see every task at a glance: in progress, in review, done
- **Autonomous execution**: describe what you want in chat, walk away; the agent decides how to get it done
- **Automatic review queue**: successful agent runs move cards to ready for review
- **Live streaming**: watch tool calls, reasoning, and responses in real time
- **Human-in-the-loop**: agents propose completion; you verify and close. Nothing moves to done without your sign-off
- **Per-task model control**: override model and reasoning effort on any task
- **Scheduled Tasks**: create and manage recurring Hermes jobs, history, and output
- **File browser**: see files agents have created in the workspace directory
- **Local-first option**: self-host with SQLite, no account, and no cloud dependency. Your local data stays on your machine

## How It Works

Each task is a persistent Hermes root session. You talk to it, it works, and the board reflects where everything stands. Chat transcripts live in Hermes's session database; Minions stores task metadata, status, and per-task settings in a local SQLite database.

## Who It's For

- **Hermes power users** juggling multiple sessions across projects
- **Indie founders** delegating research, ops, writing, and coding to their agent
- **Anyone running long-lived Hermes work** who needs to know what finished, what's stuck, and what needs attention

## Roadmap

- **Scheduled task supervision**: automatically monitor, recover, and report on scheduled agent jobs
- **Notifications**: get alerted via Telegram, WhatsApp, or webhook when a task needs review
- **Skills library**: pluggable skill templates for common workflows (lead gen, web research, content pipelines, data collection, competitive monitoring, outbound sequences)
- **OpenClaw adapter**: run Minions against OpenClaw-hosted agents

## FAQ

**Can I use this with other agents?**
Not yet. The adapter interface exists, but launch is Hermes-only. OpenClaw is next.

## Contributing

Contributions are welcome. Please open an issue first with the feature or change you have in mind and why it should be added. Once the approach is approved, create a PR. See [CLAUDE.md](CLAUDE.md) for architecture and development details.
