# Indy VPS / Coolify runbook

This is the production recipe for the private, single-user Indy Codex OAuth cockpit. **The manual VPS procedure in this document was not executed from the development workstation.** The image, Compose rendering, production-auth Playwright harness, and local Docker safety contract are tested; every command marked “VPS validation” must still be run on the target Linux host before traffic is switched.

The supported scheduler bytes are immutable for this release:

```text
cron/scheduler.py SHA-256 = 5b4326fffe1b783fd2016a0c5c0bde21c3c8af613cc665897b9f48565d74e3c5
```

The repository cannot reconstruct those exact reviewed Hermes bytes from a stable package coordinate. Do not install `latest`, infer compatibility from a version label, or let the container download Hermes. Prepare the runtime separately and mount it read-only. A complete reviewed manifest inventories every regular file by SHA-256 and every symlink by its exact target. Startup additionally requires each symlink to resolve to an inventoried regular file inside the runtime root; external, broken, cyclic, and directory links fail closed. Create a non-editable Python virtual environment with `python3 -m venv --copies`, install dependencies physically inside it without editable installs, and remove every `.pth` file before review; startup refuses a copied runtime containing any `.pth`. The manifest is anchored outside the runtime mount at `/etc/indy/hermes-runtime-manifest.json` and Compose presents that config inside the container as root-owned mode `0444`. Indy never copies it into the UID-10001 scratch; the original config path is captured before server startup and remains the trust anchor for startup, every worker spawn and readiness. Before any Python import, startup validates the bind source, copies it into a freshly created private `/run/indy-runtime/hermes-*` tree, and validates that copy again against the same external manifest. It executes the copied interpreter with isolated Python mode only, then independently verifies the copied module actually imported as `cron.scheduler`. A bind mutation during materialization therefore either fails the second validation or produces the exact reviewed private bytes; later host mutation cannot affect the running copy. The scratch tree is removed on startup failure or graceful process exit. Record the upstream revision, retrieval URL, review date, and scheduler digest in `/opt/indy/hermes-runtime/REVIEWED-MANIFEST`; that provenance file is itself covered by the external manifest.

## Host and directory provisioning

Use a supported Debian/Ubuntu host with Docker Engine, the Compose plugin, `sqlite3`, OpenSSL, and a firewall. Reserve container UID/GID `10001` for Indy.

```bash
sudo useradd --system --uid 10001 --user-group --home-dir /srv/indy --shell /usr/sbin/nologin indy
sudo install -d -o indy -g indy -m 0700 \
  /srv/indy/state /srv/indy/hermes-home /srv/indy/workspace /srv/indy/workspaces/project
sudo install -d -o root -g indy -m 0550 /opt/indy/hermes-runtime
sudo install -d -o root -g root -m 0700 /etc/indy
sudo install -d -o root -g root -m 0700 /srv/indy/backups
```

If UID `10001` already belongs to another account, stop: either choose another dedicated UID and build with matching `APP_UID`/`APP_GID`, or migrate ownership explicitly. Never run the service as root and never make the state/OAuth directories world-readable.

Place the reviewed Hermes source plus its venv under `/opt/indy/hermes-runtime`. Its Python must import `cron.scheduler` from inside that directory. Before locking the tree, create the provenance record. Then generate the complete inventory with the exact candidate image, inspect its diff against the previously approved inventory, and install it outside the runtime mount:

```bash
sudo install -o root -g indy -m 0440 REVIEWED-MANIFEST /opt/indy/hermes-runtime/REVIEWED-MANIFEST
candidate_image='ghcr.io/propulseo/indy@sha256:REPLACE_WITH_VERIFIED_DIGEST'
review_dir="$(mktemp -d)"
docker run --rm --entrypoint node \
  --mount type=bind,src=/opt/indy/hermes-runtime,dst=/opt/hermes,readonly \
  "$candidate_image" \
  dist/server/server/hermes-runtime-manifest.js /opt/hermes \
  > "$review_dir/hermes-runtime-manifest.json"
jq -e '.schemaVersion == 1 and (.entries | length > 0)' \
  "$review_dir/hermes-runtime-manifest.json"
if sudo test -f /etc/indy/hermes-runtime-manifest.json; then
  sudo diff -u /etc/indy/hermes-runtime-manifest.json \
    "$review_dir/hermes-runtime-manifest.json"
fi
sudo install -o root -g indy -m 0440 \
  "$review_dir/hermes-runtime-manifest.json" \
  /etc/indy/hermes-runtime-manifest.json
rm -rf -- "$review_dir"
```

The `diff` is a review input, not an ignorable check: explain every added, removed, changed, or retargeted entry before installing the candidate. Generate while the runtime is quiescent. Re-running the generator over identical bytes and symlink targets yields the same ordered JSON; do not let the service regenerate or approve its own manifest. The generator records link text for review, while the startup validator resolves every link and enforces the in-runtime regular-file rule. Lock the runtime after approval:

```bash
sudo chown -R root:indy /opt/indy/hermes-runtime
sudo find /opt/indy/hermes-runtime -type d -exec chmod 0550 {} +
sudo find /opt/indy/hermes-runtime -type f -exec chmod 0440 {} +
sudo find /opt/indy/hermes-runtime/venv/bin -type f -exec chmod 0550 {} +
sudo chown root:indy /etc/indy/hermes-runtime-manifest.json
sudo chmod 0440 /etc/indy/hermes-runtime-manifest.json
```

VPS validation — prove the imported artifact, interpreter, and containment before deployment:

```bash
sudo -u indy /opt/indy/hermes-runtime/venv/bin/python - <<'PY'
import hashlib, inspect, pathlib
import cron.scheduler as scheduler
root = pathlib.Path('/opt/indy/hermes-runtime').resolve()
source = pathlib.Path(inspect.getsourcefile(scheduler)).resolve()
assert source.is_relative_to(root), (source, root)
digest = hashlib.sha256(source.read_bytes()).hexdigest()
print(source)
print(digest)
assert digest == '5b4326fffe1b783fd2016a0c5c0bde21c3c8af613cc665897b9f48565d74e3c5'
PY
```

VPS validation — Hermes cron SQLite must not use a vulnerable WAL-reset build. The local Python suite observed SQLite `3.50.4` and therefore intentionally fell back to `journal_mode=DELETE`; on the VPS prefer SQLite `3.51.3+` or a fixed backport (`3.50.7` / `3.44.6`) and run `hermes doctor`. Repairing the venv must not alter the reviewed scheduler bytes:

```bash
sudo -u indy /opt/indy/hermes-runtime/venv/bin/python -c \
  'import sqlite3; print(sqlite3.sqlite_version)'
sudo -u indy env HOME=/srv/indy HERMES_HOME=/srv/indy/hermes-home \
  /opt/indy/hermes-runtime/venv/bin/hermes doctor
```

## Codex OAuth for `etienne-openai`

Hermes owns the OAuth session used by this milestone. The reviewed runtime writes and refreshes it under `/srv/indy/hermes-home`; that directory must stay writable by UID `10001` and outside the image. No model API key may be set. Current Hermes documents `hermes auth add openai-codex` as its device-code flow and supports `--label`; the exact production credential label is `etienne-openai`.

Run the login interactively as the dedicated user. `--no-browser` prints the URL/code for use on Etienne's trusted workstation:

```bash
sudo -u indy env \
  HOME=/srv/indy \
  HERMES_HOME=/srv/indy/hermes-home \
  /opt/indy/hermes-runtime/venv/bin/hermes \
  auth add openai-codex --type oauth --label etienne-openai --no-browser

sudo -u indy env HOME=/srv/indy HERMES_HOME=/srv/indy/hermes-home \
  /opt/indy/hermes-runtime/venv/bin/hermes auth list openai-codex
sudo -u indy env HOME=/srv/indy HERMES_HOME=/srv/indy/hermes-home \
  /opt/indy/hermes-runtime/venv/bin/hermes auth status openai-codex
```

References: [Hermes provider documentation](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/integrations/providers.md) and [Hermes auth CLI parser](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/subcommands/auth.py). The standalone Codex CLI uses a separate `~/.codex/auth.json`; only mount it if the reviewed Hermes runtime explicitly needs Codex app-server mode. Do not copy either auth file into the image.

Token refresh writes must remain possible while the service is live. Mount `/srv/indy/hermes-home` read-write and `/opt/indy/hermes-runtime` read-only. After a refresh failure or `missing`/`expired` runtime state, repeat the device login; do not add an API key as a fallback.

## Secret, environment, and Compose

Create a transport secret as root. It is shared only by the private proxy and the Docker secret mount; it is never a Compose environment value.

```bash
sudo sh -c 'umask 077; openssl rand -hex 32 > /etc/indy/proxy-secret'
sudo chown 10001:10001 /etc/indy/proxy-secret
sudo chmod 0400 /etc/indy/proxy-secret
```

The host ownership matches the non-root container UID even on Compose implementations that bind-mount file-backed secrets without applying long-syntax `uid`/`gid`. Nginx's root master can still read the source to generate its separate root-only upstream include; the unprivileged host user cannot traverse `/etc/indy`.

Copy `docker-compose.example.yml` to a root-owned deployment directory. Create a mode-0600 `.env` containing only the deployment substitutions below. `INDY_IMAGE` must be an immutable registry digest.

```dotenv
INDY_IMAGE=ghcr.io/propulseo/indy@sha256:REPLACE_WITH_VERIFIED_DIGEST
INDY_PUBLIC_ORIGIN=https://indy.example.com
INDY_STATE_DIR=/srv/indy/state
INDY_HERMES_HOME=/srv/indy/hermes-home
INDY_HERMES_RUNTIME_DIR=/opt/indy/hermes-runtime
INDY_HERMES_RUNTIME_MANIFEST_FILE=/etc/indy/hermes-runtime-manifest.json
INDY_WORKSPACE_ROOT=/srv/indy/workspace
INDY_PROJECT_WORKSPACE=/srv/indy/workspaces/project
INDY_PROXY_SECRET_HOST_FILE=/etc/indy/proxy-secret
INDY_LOOPBACK_PORT=6969
INDY_PRIVATE_SUBNET=172.30.44.0/28
INDY_PRIVATE_PROXY_CIDRS=172.30.44.1/32
HERMES_AGENT_RUN_LIMIT=4
HEARTBEAT_CONCURRENCY=2
MINIONS_MODEL_LIST_CACHE_TTL_SECONDS=60
```

The allowlisted application environment is: `NODE_ENV`, `PORT`, `MINIONS_HOME`, `DB_PATH`, `HERMES_HOME`, `HERMES_SOURCE_DIR`, `HERMES_SOURCE_PYTHON`, `HERMES_PRIVATE_RUNTIME_PARENT`, `HERMES_RUNTIME_MANIFEST_FILE`, `HERMES_AGENT_RUN_LIMIT`, `HEARTBEAT_CONCURRENCY`, `MINIONS_MODEL_LIST_CACHE_TTL_SECONDS`, `INDY_PUBLIC_ORIGIN`, `INDY_PROXY_SECRET_FILE`, `INDY_TRUSTED_PROXY_CIDRS`, and `INDY_SCHEDULED_WORKDIRS`. The two source variables are entrypoint inputs only: the server child receives only `HERMES_AGENT_DIR` and `HERMES_PYTHON` rewritten to the validated private copy. `HERMES_RUNTIME_MANIFEST_FILE` remains the original root-owned Docker config path; the worker captures that contract at module initialization, overwrites any later child-environment replacement with the captured value and validates only against it. Startup removes the source variables plus `PYTHONHOME`, `PYTHONPATH` and `PYTHONUSERBASE`; the scheduler probe and worker use Python isolated mode, so an external user site or `sitecustomize` cannot enter the import path. Operators must not override those controls. Deployment substitutions beginning `INDY_` above are consumed by Compose. Do not set `HERMES_WORKER_SCRIPT` in production. Model API credentials are forbidden; CI derives their exact environment names from the central runtime policy and scans every tracked text file without a per-file or per-line exception.

The private runtime is an executable tmpfs because the copied venv interpreter must run; it has `nosuid,nodev`, is absent from image layers and backups, and is capped at 1 GiB in the Compose example. After copying, Indy changes directories to `0550`, ordinary files to `0440`, and only the copied Python executable to `0550`, then revalidates manifest, path policy and modes against the original external anchor. The same non-root UID technically owns the copy and could call `chmod` or create a forged manifest beside it; these modes are defense in depth, not an immutable sandbox. Such a forged file is never a gate input. Indy repeats validation against the root-owned config before every worker spawn and on readiness health checks, while the worker remains one long-lived isolated process. Size the tmpfs cap above the reviewed runtime inventory while keeping it inside the container memory budget. Do not mount `/run/indy-runtime` from the host and do not persist or restore it.

The default bridge gateway is `172.30.44.1`, which is the expected socket peer when host Nginx connects to the loopback-published container port. Compose constructs the runtime trust list as exact container loopbacks (`127.0.0.1/32,::1/128`) plus `INDY_PRIVATE_PROXY_CIDRS`. The loopback entries are required only for the authenticated in-container probes; a host or proxy connection reaches Indy from its bridge peer, never from container loopback. Keep `INDY_PRIVATE_PROXY_CIDRS` to the exact real proxy peer, not the full bridge, so enabling internal health does not widen external proxy trust. Before starting, verify the subnet does not collide with a host/VPN route:

```bash
docker compose -f docker-compose.example.yml config --quiet
docker compose -f docker-compose.example.yml up -d
docker network inspect indy-cockpit_indy_private --format '{{(index .IPAM.Config 0).Gateway}}'
docker compose -f docker-compose.example.yml ps
```

VPS validation — run the repository-owned credential policy against both the immutable image defaults and a real process inside the deployed container. Either non-zero exit is a release blocker, and the checker never prints credential values or embeds the forbidden names in the command:

```bash
container_id="$(docker compose -f docker-compose.example.yml ps -q indy)"
image_id="$(docker inspect "$container_id" --format '{{.Image}}')"
docker run --rm --entrypoint node "$image_id" dist/server/server/security/model-key-scan.js --environment
docker compose -f docker-compose.example.yml exec -T indy \
  node dist/server/server/security/model-key-scan.js --environment
```

The production base is pinned to the immutable Node image digest recorded in the Dockerfile. Runtime apt resolution uses Debian snapshot `20260801T000000Z` and exact direct versions for `ca-certificates`, `python3`, and `tini`; transitive packages resolve only from that immutable snapshot. GitHub Actions are referenced by commit SHA. These controls pin supply inputs for one target platform, but this runbook does **not** claim bit-for-bit image reproducibility across BuildKit versions, CPU architectures, or native toolchains. Build once in the controlled CI builder, record the resulting registry digest and provenance, scan it, and deploy that same digest. Verify the embedded inputs:

```bash
candidate_image='ghcr.io/propulseo/indy@sha256:REPLACE_WITH_VERIFIED_DIGEST'
docker image inspect "$candidate_image" --format \
  '{{index .Config.Labels "io.propulseo.indy.node-base-digest"}} {{index .Config.Labels "io.propulseo.indy.debian-snapshot"}}'
# Expected: sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b 20260801T000000Z
```

If a Coolify/Traefik container proxies directly over a shared private Docker network, omit the host `ports` mapping in the Coolify override, attach Indy to that network, and set `INDY_PRIVATE_PROXY_CIDRS` to the proxy's actual private socket source. Never trust a public range.

## Canonical private reverse proxy

The proxy must authenticate Etienne (VPN, mTLS, or an exact SSO policy) **before** injecting the Indy transport identity. The example below uses a single WireGuard client IP. It requires the Nginx headers-more module so all external `X-Indy-*` headers are removed by wildcard, not merely overwritten by convention.

Generate a root-only Nginx include from the mounted secret without placing the secret in the command line or logs:

```bash
sudo install -d -o root -g root -m 0700 /etc/nginx/indy
sudo env INDY_SECRET_SOURCE=/etc/indy/proxy-secret INDY_SECRET_TARGET=/etc/nginx/indy/transport.conf python3 - <<'PY'
import os
from pathlib import Path
source = Path(os.environ['INDY_SECRET_SOURCE'])
target = Path(os.environ['INDY_SECRET_TARGET'])
secret = source.read_text(encoding='utf-8').rstrip('\n')
assert len(secret.encode()) >= 32 and '\r' not in secret and '\n' not in secret
target.write_text(
    'proxy_set_header X-Indy-User "etienne";\n'
    f'proxy_set_header X-Indy-Proxy-Secret "{secret}";\n',
    encoding='utf-8',
)
target.chmod(0o400)
PY
```

Canonical Nginx server block:

```nginx
server {
    listen 443 ssl http2;
    server_name indy.example.com;

    # TLS directives are managed by the platform.
    # Replace this exact-IP gate only with an equivalent mTLS/SSO gate.
    allow 10.66.0.2;
    deny all;

    location / {
        # STRIP every client-supplied Indy transport/identity header first.
        more_clear_input_headers 'X-Indy-*';

        # Then inject server-owned values. This file is root-only.
        include /etc/nginx/indy/transport.conf;
        proxy_set_header Host indy.example.com;
        proxy_set_header Connection "";
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_pass http://127.0.0.1:6969;
    }
}
```

Do not rewrite browser `Origin`; the canonical browser origin must naturally be `https://indy.example.com`. Do not log request headers. Validate and reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo ss -lntp | grep ':6969'     # must show 127.0.0.1 only
curl -fsS https://indy.example.com/api/health/live
curl -fsS https://indy.example.com/api/health/ready
curl -fsS https://indy.example.com/api/runtime | jq -e \
  '.provider == "openai-codex" and .profileId == "etienne-openai" and .authState == "connected" and (.models | length > 0)'
```

The last three commands must be run from the authenticated private client. A request direct to `http://127.0.0.1:6969/api/health/live` without injected headers must return `401`.

Secret rotation is a coordinated maintenance operation: block public/private client traffic, write a new `/etc/indy/proxy-secret` atomically, regenerate the root-only Nginx include, recreate the Indy container so its Docker secret is remounted, validate readiness, then reload Nginx and reopen traffic. Retire the old value immediately. Never pass either value in `docker`, `curl`, or process command arguments.

## Firewall and Coolify

Allow only SSH from the management range, HTTPS from the private VPN/identity edge, and HTTP only if needed for ACME redirect. Explicitly deny the Indy port from non-loopback interfaces:

```bash
sudo ufw allow from MANAGEMENT_CIDR to any port 22 proto tcp
sudo ufw allow from PRIVATE_EDGE_CIDR to any port 443 proto tcp
sudo ufw deny 6969/tcp
sudo ufw enable
sudo ufw status verbose
```

In Coolify, create a Docker Compose application from the repository and select `docker-compose.example.yml`. Configure the substitutions above as non-build variables, configure `/srv/indy/state`, `/srv/indy/hermes-home`, the workspace roots, and `/opt/indy/hermes-runtime` as persistent host mounts with the documented read/write modes, and mount the reviewed manifest plus root-owned transport secret. Disable automatic public port exposure. Either keep the host-loopback Nginx path or attach only Coolify's private proxy network. Let the image healthcheck measure liveness only; make protected readiness a separate rollout gate. A public unauthenticated health URL is intentionally unsupported. Deploy an immutable image digest, not a mutable tag.

## Health, logs, and alerts

`/api/health/live` proves only that the HTTP process can respond. `/api/health/ready` returns only `ready`/`not-ready` and fails closed on schema drift, a non-writable database, incomplete control loops, worker failure, wrong/missing `etienne-openai`, or a stale/empty authenticated catalog. The runtime-status RPC has a two-second server deadline; timed-out worker requests are removed and late responses are ignored. Both routes are protected by Task 9 transport authentication. The Docker `HEALTHCHECK` calls only liveness through `healthcheck.js`, so a transient OAuth/database/catalog problem does not restart a healthy process. Rollout and traffic switching call `readinesscheck.js` separately. Both helpers read the mounted secret internally; it is absent from argv and output.

```bash
docker compose -f docker-compose.example.yml ps
docker inspect --format '{{json .State.Health}}' indy-cockpit-indy-1 | jq
docker compose -f docker-compose.example.yml logs --since=15m indy
docker compose -f docker-compose.example.yml exec -T indy \
  node dist/server/server/healthcheck.js
docker compose -f docker-compose.example.yml exec -T indy \
  node dist/server/server/readinesscheck.js
```

Alert on three consecutive liveness failures, readiness unavailable for more than two minutes, any restart loop, scheduler hash/contract errors, `database-write`/migration warnings, worker exits, OAuth expiry, stale catalog, and outbox recovery failures. Logs rotate at 10 MiB with five files in the example. Never enable debug logging that prints auth stores, request headers, task secrets, or raw manifests.

## Consistent backup and restore

Back up the Indy SQLite database with SQLite's online backup command, not a raw copy of a live WAL database. Hermes remains the sole cron authority, so include its cron jobs, dispatch receipts, run ledger, Indy terminal manifests, and redacted outputs. Exclude temporary files and caches.

```bash
backup="/srv/indy/backups/$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -o root -g root -m 0700 "$backup"
sudo sqlite3 /srv/indy/state/data/indy.db \
  ".timeout 10000" "PRAGMA wal_checkpoint(FULL);" ".backup '$backup/indy.db'"
sudo sqlite3 "$backup/indy.db" 'PRAGMA integrity_check;'
sudo rsync -a --numeric-ids \
  --exclude='*.tmp' --exclude='*.lock' --exclude='__pycache__/' \
  /srv/indy/hermes-home/cron/ "$backup/hermes-cron/"
sudo cp --preserve=mode,timestamps /opt/indy/hermes-runtime/REVIEWED-MANIFEST "$backup/"
sudo cp --preserve=mode,timestamps /etc/indy/hermes-runtime-manifest.json "$backup/"
sudo sha256sum "$backup/indy.db" > "$backup/SHA256SUMS"
```

Routine backups must exclude `/srv/indy/hermes-home/auth.json`, `/srv/indy/.codex/auth.json`, proxy secrets, `.env`, TLS private keys, and any OAuth/token cache. Re-authenticate during recovery. If business continuity requires OAuth material, back it up separately to an encrypted, access-audited secrets vault with a tested retention policy; never place it beside SQLite/cron archives.

Restore drill on a disposable host:

1. Verify archive hashes and `PRAGMA integrity_check`.
2. Provision the dedicated UID/directories again.
3. Restore `indy.db` to `/srv/indy/state/data/indy.db` and cron state to `/srv/indy/hermes-home/cron`, preserving UID `10001` and mode `0700` parents.
4. Mount the same reviewed Hermes runtime, restore its matching external full-tree manifest to `/etc/indy/hermes-runtime-manifest.json`, and deploy the recorded previous image digest with external traffic blocked.
5. Perform a fresh `etienne-openai` device login.
6. Start Indy, require Docker health plus protected readiness, inspect cron/manifests/receipts, and confirm no duplicate scheduler exists.
7. Run one idempotent manual occurrence in a disposable schedule and verify exactly one Hermes execution/manifest projection before ending the drill.

## Rollout, rollback, and scheduler upgrades

Before rollout, record the current immutable image digest, take a consistent backup, render Compose, and keep traffic at the private proxy closed. Pull/build the candidate, then let Docker deliver `SIGTERM`; the 30-second grace period permits HTTP, worker, recovery, watchdog, and passive projection loops to stop.

```bash
docker compose -f docker-compose.example.yml config --quiet
docker compose -f docker-compose.example.yml pull indy
docker compose -f docker-compose.example.yml up -d --no-deps indy
timeout 120 sh -c 'until docker compose -f docker-compose.example.yml exec -T indy node dist/server/server/healthcheck.js; do sleep 2; done'
timeout 120 sh -c 'until docker compose -f docker-compose.example.yml exec -T indy node dist/server/server/readinesscheck.js; do sleep 2; done'
docker compose -f docker-compose.example.yml ps
```

Reopen traffic only after readiness and the runtime/catalog check pass. Roll back by restoring `INDY_IMAGE` to the recorded prior digest and running the same `up -d --no-deps` plus health loop. Do not automatically roll back the database; current migrations are additive. Restore a database only from the matching consistent backup after incident review.

For a Hermes scheduler upgrade:

1. Build a separate candidate runtime; never modify the mounted production runtime in place.
2. Diff the whole generated runtime manifest, then separately review imported `cron/scheduler.py`, scheduler signatures, execution-ID chain, locking, receipt, and hook points against the reviewed source.
3. Run all Python contract/drift/crash/concurrency tests and all TypeScript/E2E tests against the candidate.
4. Generate and approve a new externally anchored runtime manifest. Compute the imported scheduler SHA-256; update the worker contract constant, image label, tests, and this runbook together only after review.
5. Mount the candidate read-only with its matching external manifest in staging; require full-tree and imported-scheduler entrypoint validation, fresh exact catalog, and one controlled cron occurrence.
6. Back up, roll out by immutable image/runtime digest, observe, then retire the previous runtime only after the rollback window.

Hermes cron is the only scheduler authority. Do not add systemd timers, host cron, Coolify scheduled jobs, Kubernetes CronJobs, or another ticker for Indy occurrences. Indy has only passive projection and recovery of already-claimed operator commands.

## Incident recovery

- **Runtime manifest or scheduler mismatch:** keep traffic closed; compare the full-tree inventory and actually imported scheduler path/hash. Restore the matching previous read-only runtime, external manifest, and image digest. Never bypass either gate.
- **OAuth missing/expired/catalog stale:** keep mission launch blocked, confirm clock/DNS/TLS, repeat the `etienne-openai` device login, then require a fresh nonempty catalog and readiness.
- **Worker crash loop:** inspect bounded logs, verify Python/runtime permissions and imports, and roll back the runtime/image together.
- **SQLite read-only/corrupt:** stop Indy, preserve the files for forensics, run `integrity_check` on a copy, and restore the latest verified online backup. Do not delete WAL/SHM files from a running service.
- **Proxy secret exposure:** close traffic, rotate both Docker secret and root-only proxy include, recreate the container, validate rejection of the old secret, and review access logs without printing headers.
- **Unexpected scheduled executions:** stop Indy and Hermes cron processing, preserve jobs/receipts/manifests/ledger, prove there is no second scheduler, and reconcile execution IDs before resuming.
- **Compromised OAuth store:** stop the service, revoke the OpenAI session, quarantine/delete the credential store securely, perform a fresh device login, and rotate the proxy secret as a separate precaution.

VPS validation is complete only when all commands below succeed on the target host:

```bash
docker compose -f docker-compose.example.yml config --quiet
docker compose -f docker-compose.example.yml pull indy
docker compose -f docker-compose.example.yml up -d
docker compose -f docker-compose.example.yml exec -T indy node dist/server/server/healthcheck.js
docker compose -f docker-compose.example.yml exec -T indy node dist/server/server/readinesscheck.js
container_id="$(docker compose -f docker-compose.example.yml ps -q indy)"
image_id="$(docker inspect "$container_id" --format '{{.Image}}')"
docker run --rm --entrypoint node "$image_id" dist/server/server/security/model-key-scan.js --environment
docker compose -f docker-compose.example.yml exec -T indy node dist/server/server/security/model-key-scan.js --environment
curl -fsS https://indy.example.com/api/runtime | jq -e \
  '.provider == "openai-codex" and .profileId == "etienne-openai" and .authState == "connected" and (.models | length > 0)'
sudo sqlite3 /srv/indy/state/data/indy.db 'PRAGMA integrity_check;'
sudo nginx -t
sudo ss -lntp | grep '127.0.0.1:6969'
```
