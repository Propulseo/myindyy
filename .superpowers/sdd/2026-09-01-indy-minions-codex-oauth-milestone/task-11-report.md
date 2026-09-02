# Task 11 — livraison, E2E et exploitation VPS

## Résultat

- Deux endpoints protégés séparent désormais la liveness de processus (`/api/health/live`) de la readiness fail-closed (`/api/health/ready`, avec alias historique `/api/health`). La readiness exige le schéma attendu et une vraie écriture SQLite annulée, les boucles de contrôle démarrées, le worker Hermes disponible, exactement `openai-codex` / `etienne-openai` connecté et un catalogue authentifié non vide vérifié depuis moins de deux minutes. La réponse publique reste générique; le motif précis reste dans les logs internes.
- Le healthcheck Docker lit le secret proxy depuis le fichier monté, puis appelle la readiness avec `Host` canonique, `X-Indy-User: etienne`, le secret interne et aucun `Origin`. Le secret n'est ni dans l'argv ni imprimé.
- L'image multi-stage utilise Node `22.14.0`, pnpm `11.1.2` frozen et Python 3, construit client/serveur, installe uniquement les dépendances de production dans le runtime et s'exécute sous `indy:indy` (UID/GID `10001`) avec `tini`. Aucun runtime OAuth, token ou modèle n'est copié.
- Le dépôt ne permet pas de reconstruire de façon reproductible l'artefact Hermes exact. Le conteneur exige donc un runtime externe monté en lecture seule. Son entrypoint importe réellement `cron.scheduler`, vérifie que son `realpath` reste sous le montage et exige le SHA-256 `5b4326fffe1b783fd2016a0c5c0bde21c3c8af613cc665897b9f48565d74e3c5`; sans montage ou en cas de drift il quitte fermé avant le serveur.
- L'exemple Compose publie uniquement sur `127.0.0.1`, persiste l'état Indy et le répertoire Hermes/OAuth hors image, monte le runtime Hermes en RO et seulement deux workspaces explicitement autorisés, fournit le secret par Docker secret, borne CPU/mémoire/PID/logs, et conserve Hermes comme unique scheduler. Le bridge a un sous-réseau explicite afin de pouvoir limiter le CIDR du proxy réel.
- Le harnais Playwright est autonome : worker Hermes Python JSONL déterministe, proxy Node de confiance qui supprime tous les en-têtes `X-Indy-*` clients et injecte l'identité/secret de transport. Il utilise la configuration production et l'origine HTTPS canonique sans OAuth, compte ou réseau réels.
- Le golden path vérifie runtime/catalogue, création avec modèle/effort/workdir explicites, outil/timeline durable, ajout d'instruction, tentative active, interruption/correction, reload, redémarrage réel du backend avec persistance de correction/timeline, retry et reload. Deux scénarios supplémentaires couvrent origine hostile, backend direct sans en-tête et runtime absent qui désactive le lancement.
- La CI ordonne : install frozen, typecheck, tests TypeScript, tests Python, build, scan des clés de modèle, installation Chromium, E2E, rendu Compose, build Docker et inspection statique de l'image. Le scan dérive les quatre noms interdits de `server/runtime/policy.ts`, inspecte les fichiers Git suivis et ignore explicitement documentation/tests afin d'éviter les exemples faux positifs.
- `docs/runbook-vps.md` couvre utilisateur/modes, runtime monté, device login `etienne-openai`, refresh, proxy Nginx qui efface par wildcard avant injection, rotation, allowlist d'environnement, firewall/Coolify, sauvegarde SQLite en ligne, exclusions OAuth, restore drill, santé/logs/alertes, upgrade du hash, autorité cron, rollout/rollback et incidents.

## TDD RED / GREEN

- Health RED : import manquant `server/health/readiness.js`; GREEN avec 9 tests de liveness sans dépendance, readiness complète, migrations absentes, SQLite read-only, worker/profil/catalogue/fraîcheur et détails non exposés.
- Entrypoint RED : module de validation absent; GREEN avec 2 tests du hash déclaré, drift et source hors montage.
- Worker E2E RED : `resolveWorkerScript` n'était pas exporté et ne permettait aucun fixture explicite; GREEN avec 2 tests d'un chemin absolu existant et refus relatif/manquant.
- Scan RED : module `server/security/model-key-scan.js` absent; GREEN avec une matrice sur les quatre variables et l'absence de faux positifs dans docs/tests/exemples vides.
- E2E RED valide : les deux scénarios sécurité/runtime passaient mais le golden path échouait d'abord sur un locator ambigu, puis révélait qu'un retry ouvre volontairement une nouvelle lignée de session. GREEN en ciblant les tentatives par rôle/label et en prouvant la persistance backend avant la nouvelle session de retry; résultat final 3/3.
- Docker RED : pnpm `11.12.0` était incompatible avec le Node hôte et son wrapper Corepack (`Cannot use 'in' operator...`). La version `11.1.2` a été épinglée dans `packageManager`, Docker et CI; install frozen hôte et image sont ensuite verts.

## Vérifications exécutées

- `pnpm install --frozen-lockfile` — exit 0, lockfile à jour, pnpm `11.1.2`.
- `pnpm exec vitest run tests/health-readiness.test.ts tests/container-entrypoint.test.ts` — 2 fichiers, 11 tests, 0 échec.
- `pnpm exec vitest run tests/hermes-worker-script.test.ts` — 2 tests, 0 échec.
- `pnpm exec vitest run tests/model-key-scan.test.ts` — 5 tests, 0 échec.
- `pnpm test` — 29 fichiers, 235 tests, 0 échec.
- `pnpm test:python` — 41 tests, 0 échec.
- `pnpm typecheck` — serveur et client, exit 0.
- `pnpm build` — serveur/client/assets, exit 0; 2 602 modules transformés.
- `pnpm secret:scan` — fichiers suivis, 0 assignment non vide interdit.
- `pnpm test:e2e` — rebuild client/serveur puis 3 scénarios, 3 réussis en 10,4 s (passage final après tous les correctifs).
- `docker compose -f docker-compose.example.yml config --quiet` avec substitutions représentatives — exit 0.
- `docker build --pull=false --tag indy-task11:e2e-ci .` — exit 0; manifest list `sha256:486cc4e58761e79cd85187dc57c320f59f0211362b3ef941998ad975ee3d6522`.
- `docker image inspect indy-task11:test` — `User="indy:indy"`, entrypoint `tini` + `container-entrypoint.js`, healthcheck `healthcheck.js`, aucune variable de clé modèle.
- `docker run --rm --entrypoint node indy-task11:test --version` — `v22.14.0`.
- `docker run --rm --entrypoint python3 indy-task11:test --version` — `Python 3.11.2`.
- `docker run --rm indy-task11:test` sans runtime Hermes — exit 1, `spawnSync /opt/hermes/venv/bin/python ENOENT`, donc échec fermé.
- `git diff --check` — exit 0 avant chacun des deux premiers commits; une dernière exécution est enregistrée après ce rapport.

## Commits Task 11

- `37d6e19` — `chore: harden Indy container readiness`.
- `6bacb88` — `test: add autonomous production-auth E2E`.
- Le dernier commit documentaire contient ce rapport, le README, le runbook et la portabilité UTF-8 du faux worker.

## Vérifications réservées au VPS

La recette VPS manuelle n'a pas été exécutée localement. Restent obligatoires sur le serveur cible : création UID/GID et modes, import/hash/realpath du runtime Hermes réellement monté, version SQLite et `hermes doctor`, device login réel `etienne-openai`, catalogue Codex frais réel, réseau/CIDR socket réel, module Nginx headers-more et strip wildcard, secret rotation, firewall/port inaccessible, Coolify, sauvegarde/restore drill, rollout/rollback par digest, mission réelle avec outil/correction/reprise après restart, et absence de toute clé modèle dans l'environnement du conteneur. Les commandes exactes sont dans `docs/runbook-vps.md`.

## Préoccupations et éléments de revue finale

- La suite Python locale signale que son SQLite `3.50.4` est affecté par le bug WAL-reset; Hermes bascule volontairement en `journal_mode=DELETE`. Le VPS doit utiliser SQLite `3.51.3+` ou un backport corrigé (`3.50.7` / `3.44.6`) et exécuter `hermes doctor`, sans modifier les bytes du scheduler épinglé.
- Le warning Vite historique sur le chunk principal d'environ 673 kB gzip demeure hors Task 11.
- L'image n'embarque délibérément pas Hermes : l'exploitation doit fournir l'artefact exact revu. C'est une barrière fail-closed, pas une installation automatique incomplète.
- Les actions GitHub utilisent leurs tags majeurs officiels; un durcissement ultérieur peut épingler leurs SHA après mise en place du processus de mise à jour Dependabot/Renovate.
- **Finding Task 10 parqué, non modifié ici :** un manifeste contradictoire `status=completed` avec `hermesStatus=failed|unknown` peut encore passer le parseur. Le producteur interne hash-pinné émet des paires cohérentes et Task 11 n'analyse pas ces manifests; le finding doit impérativement rester visible dans la revue globale et être corrigé/accepté explicitement avant la décision finale de livraison.
