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

## Production deployment

The production image is a multi-stage Node 22/Python 3 image that runs as the dedicated non-root `indy` user. Its Node base digest, Debian snapshot and direct apt package versions are immutable inputs. It expects the reviewed Hermes runtime to be mounted read-only and a complete externally anchored manifest to match every file and symlink. Before importing Python, the entrypoint validates that bind, copies it to a fresh private tmpfs tree, rejects Python path-configuration files, applies read/execute-only modes, revalidates the private copy, and switches all execution paths to it; host-side mutation can no longer change running code. Python runs isolated from inherited user/import paths, and the private manifest plus modes are checked again before worker spawn and readiness. Every symlink must resolve to an inventoried regular file inside that private runtime; external, broken, cyclic, and directory links fail closed. The copied `cron/scheduler.py` then faces its separate exact SHA-256 gate. The Compose/Coolify example binds the application port to host loopback, persists Indy and Hermes state outside the image, mounts only explicitly allowed workspaces, and reads the proxy transport secret from a Docker secret file. No model API credential belongs in the environment or image.

Use [docker-compose.example.yml](docker-compose.example.yml) as the deployment template and follow [docs/runbook-vps.md](docs/runbook-vps.md) for provisioning, OAuth device login, runtime-manifest review, reverse-proxy hardening, backup/restore, rollout, rollback, and incident recovery. `/api/health/live` is process liveness and is the only Docker healthcheck target. `/api/health/ready` is a separate protected rollout gate and fails closed unless SQLite is writable/current, the control loops and worker are running, and exact profile `etienne-openai` has a fresh authenticated Codex catalog. Its runtime-status RPC is server-bounded so a frozen worker returns `503` instead of hanging the probe.

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
| `INDY_SCHEDULED_WORKDIRS` | Optional server-side registry of additional directories allowed for Hermes scheduled tasks. Separate entries with the platform path delimiter (`;` on Windows, `:` on POSIX). Each root is resolved through the filesystem before use; missing roots, traversal and symlink escapes are rejected. The Minions workspace remains allowed by default. |

Create and mount a distinct high-entropy transport secret with restrictive permissions, for example:

```bash
umask 077
openssl rand -hex 32 > /run/secrets/indy-proxy
```

Configure the proxy to read the same secret from its secret store and inject it upstream; never expose it to browser JavaScript or proxy access logs. Set `INDY_PUBLIC_ORIGIN=https://indy.example.com`, set `INDY_PROXY_SECRET_FILE=/run/secrets/indy-proxy`, and restrict external trust to the proxy's real private source. The Compose template constructs `INDY_TRUSTED_PROXY_CIDRS` from exact container loopbacks for authenticated internal probes plus `INDY_PRIVATE_PROXY_CIDRS` for that external hop; the loopback entries cannot represent a host/bridge peer. The proxy must send `Host: indy.example.com` on browser traffic. Missing or invalid production configuration fails closed with `503`. Missing or invalid transport credentials return the same generic `401`; a trusted, transport-authenticated identity other than exact `etienne` returns `403`.

## Hermes scheduled-task policy

Hermes is the only source of schedule truth and the only component that decides when a recurring task runs. Indy does not copy or rewrite schedules and does not run a parallel ticker. Before its ticker starts or its request loop accepts input, the Indy-owned Hermes worker synchronously installs a guarded hook in Hermes's shared per-job execution path. An incompatible hook contract prevents the worker from starting. Immediately before every occurrence the hook refreshes OAuth/catalog state and applies the policy below. It uses Hermes's real durable execution ID carried by the claimed job; a direct internal call that does not expose such an ID is denied instead of inventing one. A refused job never reaches inference and Hermes records the refusal as a failed occurrence. The hook also disables provider/model fallback only in that admitted cron execution context.

The guarded execution integration pins the exact imported `cron/scheduler.py` artifact reviewed with Hermes `0.15.1`: SHA-256 `5b4326fffe1b783fd2016a0c5c0bde21c3c8af613cc665897b9f48565d74e3c5`. Startup hashes the bytes returned by `inspect.getsourcefile` and also verifies the critical function signatures/source identity for `tick`, `run_job`, `run_one_job` and `_run_one_job_body`. Distribution metadata is diagnostic only, because it cannot prove which source Python imported. To upgrade Hermes, inspect the actual scheduler diff and its execution-ID chain, run the installed-contract, drift, crash and concurrency tests, then recompute and update the hash before the full Python/TypeScript suites, typecheck and build. An unreadable path, byte drift, different module or signature mismatch intentionally leaves the worker unavailable rather than executing an unguarded cron. Task 11 deployment must install or mount this exact source artifact; a wheel/version label alone is insufficient.

Creating, updating, resuming or manually running a scheduled task is fail-closed. The server requires the exact `openai-codex` provider, the connected `etienne-openai` OAuth profile, an explicit model from a freshly authenticated Hermes catalog, an explicit effort published for that model, and a canonical workdir in the server registry. A missing catalog or unknown effort does not fall back to defaults. Manual runs also require an `Idempotency-Key`; reusing the same key and payload replays the server acknowledgement, while a different payload returns `409` without triggering Hermes again.

Each completed occurrence writes a redacted output artifact followed by an immutable terminal manifest under `$HERMES_HOME/cron/indy-manifests/<task-id>/`. The manifest contains the Hermes execution ID, original task identity and runtime snapshot, exact start/finish timestamps, status/error, output reference and optional manual dispatch token. Its provenance is restricted to the reviewed Hermes hook/source, ledger evidence, original terminal status and `startedAtEvidence` (`claimed_at` or `started_at`); unknown keys, mismatched statuses and fabricated evidence are rejected. Indy passively imports only these terminal manifests at startup and while running; partial/temp/raw output files are deferred, deleted jobs remain importable, and the importer never calls the scheduler or a trigger. The validated, redacted provenance is stored both with the mission run and its run events so an interrupted claimed occurrence remains distinguishable from one that actually started.

Every manifest occurrence is projected exactly once into `mission_runs` using `cron:<scheduled-task-id>:<Hermes-run-id>`. SQLite stores this control-plane history and a stable cron mission identity, never the schedule itself. Generic mission/task mutation routes exclude `mission_kind='cron'`; cron control remains available only through `/api/scheduled-tasks`.

Manual runs use the operator command table as a durable outbox. The idempotency claim happens before task/runtime lookup, and the durable Hermes receipt is consulted before the current job or catalog: an accepted or failed receipt therefore replays exactly even after deletion or OAuth expiry. Commands use transactional leases; deterministic worker refusals become replayable terminal responses, while transient unavailability stays truthfully `202 pending` and a bounded, non-overlapping passive recovery loop retries with backoff. This loop cannot schedule work on its own; it only resumes already claimed operator commands. Hermes persists the dispatch token in the same locked `jobs.json` mutation as its run-now intent, then consumes and associates it with exactly one real execution ID under the same job lock. Crash-before resumes, crash-after replays the receipt, and later automatic occurrences receive no manual token. The HTTP acknowledgement remains pending until a terminal manifest bearing that exact token appears; the UI never correlates an unrelated automatic or legacy raw run. Authorization credentials (including Basic and other schemes), secret-looking task names, errors, output and provenance are centrally redacted before manifests, SQLite and HTTP projection.

The manual receipt also carries a redacted configuration snapshot. Under the Hermes job lock, the execution hook writes pending occurrence evidence before binding the receipt or clearing the one-shot token. On restart it can recover an earlier pending/terminal token match, or reconstruct missing pending evidence for an already-bound receipt from that snapshot. The passive manifest finalizer also binds and clears a stranded marker when receipt, current Hermes job token and durable manifest token agree exactly, so a second command cannot starve after a hook crash; it never creates an execution or changes a schedule. A merely prepared receipt without the exact durable job token is never accepted. Temporary runtime/catalog failures remain leased outbox work with bounded retry; only policy decisions made from a successfully loaded fresh catalog and deterministic worker refusals become terminal responses.

Hermes ledger state `unknown` is terminal durable evidence for an interrupted owner. Indy projects it conservatively as a failed occurrence while retaining `hermesStatus=unknown`, the exact Hermes error, and the original status/timestamp evidence in provenance; claimed attempts use their durable `claimed_at` when no `started_at` exists. A returned runtime `authState=error` remains transient outbox work, whereas connected-inventory refusals and explicit OAuth `missing`/`expired` are terminal. Hermes also serializes manual tokens per job: a different existing token returns transient `scheduled_task_busy` without overwriting it, so the second outbox command retries only after the first occurrence claims and clears its token.

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
