# Task 11 — livraison, E2E et exploitation VPS

## Résultat

- Deux endpoints protégés séparent désormais la liveness de processus (`/api/health/live`) de la readiness fail-closed (`/api/health/ready`, avec alias historique `/api/health`). La readiness exige le schéma attendu et une vraie écriture SQLite annulée, les boucles de contrôle démarrées, le worker Hermes disponible, exactement `openai-codex` / `etienne-openai` connecté et un catalogue authentifié non vide vérifié depuis moins de deux minutes. La réponse publique reste générique; le motif précis reste dans les logs internes.
- Le healthcheck Docker lit le secret proxy depuis le fichier monté puis appelle uniquement la liveness avec `Host` canonique, `X-Indy-User: etienne`, le secret interne et aucun `Origin`. La readiness reste un helper séparé de rollout. Le secret n'est ni dans l'argv ni imprimé.
- L'image multi-stage utilise Node `22.14.0`, pnpm `11.1.2` frozen et Python 3, construit client/serveur, installe uniquement les dépendances de production dans le runtime et s'exécute sous `indy:indy` (UID/GID `10001`) avec `tini`. Le digest de base Node, le frontend Dockerfile, le snapshot Debian et les versions apt directes sont épinglés; aucun runtime OAuth, token ou modèle n'est copié.
- Le dépôt ne permet pas de reconstruire de façon reproductible l'artefact Hermes exact. Le conteneur exige donc un runtime externe monté en lecture seule et un manifeste externe revu qui inventorie tous ses fichiers et symlinks. L'entrypoint valide l'arbre complet avant Python, puis importe réellement `cron.scheduler`, vérifie que son `realpath` reste sous le montage et exige le SHA-256 `5b4326fffe1b783fd2016a0c5c0bde21c3c8af613cc665897b9f48565d74e3c5`; sans montage/manifeste ou en cas de drift il quitte fermé avant le serveur.
- L'exemple Compose publie uniquement sur `127.0.0.1`, persiste l'état Indy et le répertoire Hermes/OAuth hors image, monte le runtime Hermes en RO et seulement deux workspaces explicitement autorisés, fournit le secret par Docker secret, borne CPU/mémoire/PID/logs, et conserve Hermes comme unique scheduler. Le bridge a un sous-réseau explicite afin de pouvoir limiter le CIDR du proxy réel.
- Le harnais Playwright est autonome : worker Hermes Python JSONL déterministe, proxy Node de confiance qui supprime tous les en-têtes `X-Indy-*` clients et injecte l'identité/secret de transport. Il utilise la configuration production et l'origine HTTPS canonique sans OAuth, compte ou réseau réels.
- Le golden path vérifie runtime/catalogue, création avec modèle/effort/workdir explicites, outil/timeline durable, ajout d'instruction, tentative active, interruption/correction, reload, redémarrage réel du backend avec persistance de correction/timeline, retry et reload. Deux scénarios supplémentaires couvrent origine hostile, backend direct sans en-tête et runtime absent qui désactive le lancement.
- La CI ordonne : install frozen, typecheck, tests TypeScript, tests Python, build, scan des clés de modèle, installation Chromium, E2E, rendu Compose, build Docker et inspection statique de l'image. Ses actions sont épinglées par commit. Le scan dérive les quatre noms interdits de `server/runtime/policy.ts`, inspecte les fichiers Git suivis applicatifs/déploiement/E2E, couvre syntaxes env/YAML/JSON/TypeScript et ignore explicitement documentation/tests de fixture.
- `docs/runbook-vps.md` couvre utilisateur/modes, runtime monté, device login `etienne-openai`, refresh, proxy Nginx qui efface par wildcard avant injection, rotation, allowlist d'environnement, firewall/Coolify, sauvegarde SQLite en ligne, exclusions OAuth, restore drill, santé/logs/alertes, upgrade du hash, autorité cron, rollout/rollback et incidents.

## TDD RED / GREEN

- Health RED : import manquant `server/health/readiness.js`; GREEN avec 9 tests de liveness sans dépendance, readiness complète, migrations absentes, SQLite read-only, worker/profil/catalogue/fraîcheur et détails non exposés.
- Entrypoint RED : module de validation absent; GREEN avec 2 tests du hash déclaré, drift et source hors montage.
- Worker E2E RED : `resolveWorkerScript` n'était pas exporté et ne permettait aucun fixture explicite; GREEN avec 2 tests d'un chemin absolu existant et refus relatif/manquant.
- Scan RED : module `server/security/model-key-scan.js` absent; GREEN avec une matrice sur les quatre variables et l'absence de faux positifs dans docs/tests/exemples vides.
- E2E RED valide : les deux scénarios sécurité/runtime passaient mais le golden path échouait d'abord sur un locator ambigu, puis révélait qu'un retry ouvre volontairement une nouvelle lignée de session. GREEN en ciblant les tentatives par rôle/label et en prouvant la persistance backend avant la nouvelle session de retry; résultat final 3/3.
- Docker RED : pnpm `11.12.0` était incompatible avec le Node hôte et son wrapper Corepack (`Cannot use 'in' operator...`). La version `11.1.2` a été épinglée dans `packageManager`, Docker et CI; install frozen hôte et image sont ensuite verts.

### Revue corrective 1/5

- Health RED : le client conteneur recevait `/api/health/ready` au lieu de `/api/health/live`; GREEN avec liveness Docker et `readinesscheck.js` séparé. Compose rend exactement `127.0.0.1/32,::1/128,<proxy-privé-exact>` : les probes internes sont admis sans élargir le pair externe du bridge.
- Readiness RED : deux appels contre un `runtime.status` figé restaient pendants, et une réponse tardive résolvait après le deadline attendu. GREEN avec deadline serveur de deux secondes propagée au client JSONL, suppression atomique de `pending[id]`, timer nettoyé et réponse tardive ignorée. Deux tests worker réels et le test HTTP répété couvrent le comportement.
- Scan RED : les fichiers `e2e/`, clés JSON citées et affectations `process.env`/bracket échappaient au scanner. GREEN sur six syntaxes et les quatre noms dérivés de la politique; documentation et fixtures de tests restent les seules exclusions larges.
- Runtime RED : aucun module d'inventaire complet n'existait et l'entrypoint ne détectait qu'un drift du scheduler. GREEN avec génération JSON déterministe, fichier régulier SHA-256, symlink par cible exacte, refus des entrées manquantes/ajoutées/modifiées, manifeste ancré hors montage et validation avant Python; un drift de `run_agent.py` est couvert.
- Reproductibilité RED : base/action tags mutables et apt courant. GREEN avec base Node et frontend Dockerfile par digest, actions par SHA, snapshot Debian signé/immuable, bootstrap CA content-addressé avec SHA-256 et versions directes prouvées par `apt-cache`/build. Le runbook limite honnêtement la promesse aux inputs d'une plateforme et impose le déploiement du digest CI produit.

## Vérifications exécutées

- `pnpm install --frozen-lockfile` — exit 0, lockfile à jour, pnpm `11.1.2`.
- `pnpm exec vitest run tests/health-readiness.test.ts tests/container-entrypoint.test.ts tests/hermes-runtime-manifest.test.ts tests/hermes-worker-timeout.test.ts tests/model-key-scan.test.ts` — 5 fichiers, 26 tests, 0 échec; couvre les deadlines répétées, réponse tardive, drift hors scheduler et syntaxes structurées du scan.
- `pnpm test` — 31 fichiers, 245 tests, 0 échec.
- `pnpm test:python` — 41 tests, 0 échec.
- `pnpm typecheck` — serveur et client, exit 0.
- `pnpm build` — serveur/client/assets, exit 0; 2 602 modules transformés.
- `pnpm secret:scan` — fichiers suivis, 0 assignment non vide interdit.
- `pnpm test:e2e` — rebuild client/serveur puis 3 scénarios, 3 réussis en 8,7 s (passage final après tous les correctifs).
- `docker compose -f docker-compose.example.yml config --quiet` avec substitutions représentatives — exit 0.
- parsing `.github/workflows/ci.yml` avec la dépendance YAML du projet — workflow `ci`, 15 étapes, exit 0.
- `docker build --pull=false --tag indy-task11:review1 .` — exit 0 en 17,6 s; manifest list `sha256:e8048705c09acc1c18bdda8c41047d17e18927495d91816469ac8c2d5670a0e8`.
- `docker image inspect indy-task11:review1` — `User="indy:indy"`, healthcheck `healthcheck.js` (liveness), base/snapshot conformes et aucune variable de clé modèle.
- `docker run --rm --entrypoint dpkg-query indy-task11:review1 ...` — `ca-certificates=20230311+deb12u1`, `python3=3.11.2-1+b1`, `tini=0.19.0-1+b3`.
- générateur de manifeste exécuté dans l'image sur un arbre éphémère — inventaire ordonné d'un fichier et d'un symlink, exit 0.
- `docker run --rm indy-task11:review1` sans runtime Hermes — exit 1, `ENOENT ... lstat '/opt/hermes'`, donc échec fermé avant Python.
- `git diff --check` et `git diff --cached --check` — exécutés après ce rapport et avant commit; le scan est ensuite rejoué depuis HEAD.

## Commits Task 11

- `37d6e19` — `chore: harden Indy container readiness`.
- `6bacb88` — `test: add autonomous production-auth E2E`.
- `04b85e8` — `chore: ship Indy Codex OAuth cockpit`.
- Un commit correctif atomique ferme les findings de revue 1/5 décrits ci-dessus; son hash est communiqué avec le statut final.

## Vérifications réservées au VPS

La recette VPS manuelle n'a pas été exécutée localement. Restent obligatoires sur le serveur cible : création UID/GID et modes, import/hash/realpath du runtime Hermes réellement monté, version SQLite et `hermes doctor`, device login réel `etienne-openai`, catalogue Codex frais réel, réseau/CIDR socket réel, module Nginx headers-more et strip wildcard, secret rotation, firewall/port inaccessible, Coolify, sauvegarde/restore drill, rollout/rollback par digest, mission réelle avec outil/correction/reprise après restart, et absence de toute clé modèle dans l'environnement du conteneur. Les commandes exactes sont dans `docs/runbook-vps.md`.

## Préoccupations et éléments de revue finale

- La suite Python locale signale que son SQLite `3.50.4` est affecté par le bug WAL-reset; Hermes bascule volontairement en `journal_mode=DELETE`. Le VPS doit utiliser SQLite `3.51.3+` ou un backport corrigé (`3.50.7` / `3.44.6`) et exécuter `hermes doctor`, sans modifier les bytes du scheduler épinglé.
- Le warning Vite historique sur le chunk principal d'environ 673 kB gzip demeure hors Task 11.
- L'image n'embarque délibérément pas Hermes : l'exploitation doit fournir l'artefact exact revu. C'est une barrière fail-closed, pas une installation automatique incomplète.
- Les actions GitHub sont désormais épinglées par SHA. Leur mise à jour doit vérifier le tag officiel puis revoir le diff de l'action avant de remplacer le commit.
- **Finding Task 10 parqué, non modifié ici :** un manifeste contradictoire `status=completed` avec `hermesStatus=failed|unknown` peut encore passer le parseur. Le producteur interne hash-pinné émet des paires cohérentes et Task 11 n'analyse pas ces manifests; le finding doit impérativement rester visible dans la revue globale et être corrigé/accepté explicitement avant la décision finale de livraison.
