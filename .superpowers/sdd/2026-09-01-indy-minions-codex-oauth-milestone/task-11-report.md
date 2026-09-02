# Task 11 — livraison, E2E et exploitation VPS

## Résultat

- Deux endpoints protégés séparent désormais la liveness de processus (`/api/health/live`) de la readiness fail-closed (`/api/health/ready`, avec alias historique `/api/health`). La readiness exige le schéma attendu et une vraie écriture SQLite annulée, les boucles de contrôle démarrées, le worker Hermes disponible, exactement `openai-codex` / `etienne-openai` connecté et un catalogue authentifié non vide vérifié depuis moins de deux minutes. La réponse publique reste générique; le motif précis reste dans les logs internes.
- Le healthcheck Docker lit le secret proxy depuis le fichier monté puis appelle uniquement la liveness avec `Host` canonique, `X-Indy-User: etienne`, le secret interne et aucun `Origin`. La readiness reste un helper séparé de rollout. Le secret n'est ni dans l'argv ni imprimé.
- L'image multi-stage utilise Node `22.14.0`, pnpm `11.1.2` frozen et Python 3, construit client/serveur, installe uniquement les dépendances de production dans le runtime et s'exécute sous `indy:indy` (UID/GID `10001`) avec `tini`. Le digest de base Node, le frontend Dockerfile, le snapshot Debian et les versions apt directes sont épinglés; aucun runtime OAuth, token ou modèle n'est copié.
- Le dépôt ne permet pas de reconstruire de façon reproductible l'artefact Hermes exact. Le conteneur exige donc un runtime externe monté en lecture seule et un manifeste externe revu qui inventorie tous ses fichiers et symlinks. Chaque symlink doit résoudre vers un fichier régulier inventorié sous le runtime; cible externe, cassée, cyclique ou répertoire est rejetée. L'entrypoint fige d'abord le manifeste, valide le bind complet sans importer Python, le copie dans un répertoire privé éphémère, refuse tout `.pth`, impose les modes, revalide la copie, puis seulement importe `cron.scheduler` en Python isolé et exige le SHA-256 `5b4326fffe1b783fd2016a0c5c0bde21c3c8af613cc665897b9f48565d74e3c5`. Le manifeste et les modes sont revérifiés avant spawn et readiness. Une mutation pendant la copie échoue ou reproduit exactement les bytes revus; une mutation ultérieure du bind ne touche plus le runtime exécuté.
- L'exemple Compose publie uniquement sur `127.0.0.1`, persiste l'état Indy et le répertoire Hermes/OAuth hors image, monte le runtime Hermes en RO et seulement deux workspaces explicitement autorisés, fournit le secret par Docker secret, borne CPU/mémoire/PID/logs, et conserve Hermes comme unique scheduler. Le bridge a un sous-réseau explicite afin de pouvoir limiter le CIDR du proxy réel. La copie privée vit sur un tmpfs `nosuid,nodev`, mode `0700`, plafonné à 1 Gio et jamais sauvegardé.
- Le harnais Playwright est autonome : worker Hermes Python JSONL déterministe, proxy Node de confiance qui supprime tous les en-têtes `X-Indy-*` clients et injecte l'identité/secret de transport. Il utilise la configuration production et l'origine HTTPS canonique sans OAuth, compte ou réseau réels.
- Le golden path vérifie runtime/catalogue, création avec modèle/effort/workdir explicites, outil/timeline durable, ajout d'instruction, tentative active, interruption/correction, reload, redémarrage réel du backend avec persistance de correction/timeline, retry et reload. Deux scénarios supplémentaires couvrent origine hostile, backend direct sans en-tête et runtime absent qui désactive le lancement.
- La CI ordonne : install frozen, typecheck, tests TypeScript, tests Python, build, scan des credentials modèle, installation Chromium, E2E, rendu Compose, build Docker et inspection statique de l'image. Ses actions sont épinglées par commit. Le scan dérive les quatre noms interdits par codepoints depuis `server/runtime/policy.ts`, couvre tous les fichiers texte suivis sans exception par chemin ou par ligne, et bloque les occurrences contiguës comme celles fragmentées par syntaxe, commentaires, heredoc, scalar ou template. UTF-8 et UTF-16 BOM sont décodés strictement; NUL ou texte ambigu échoue fermé. Un helper générique contrôle aussi l'environnement réel de l'image et du conteneur sans embarquer ces noms dans les commandes de déploiement.
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
- Scan RED : les fichiers `e2e/`, clés JSON citées et affectations `process.env`/bracket échappaient au scanner. Le premier GREEN couvrait six syntaxes et les quatre noms dérivés de la politique; la revue 2/5 ci-dessous remplace ensuite ses exclusions de chemins par des suppressions strictement locales.
- Runtime RED : aucun module d'inventaire complet n'existait et l'entrypoint ne détectait qu'un drift du scheduler. GREEN avec génération JSON déterministe, fichier régulier SHA-256, symlink par cible exacte, refus des entrées manquantes/ajoutées/modifiées, manifeste ancré hors montage et validation avant Python; un drift de `run_agent.py` est couvert.
- Reproductibilité RED : base/action tags mutables et apt courant. GREEN avec base Node et frontend Dockerfile par digest, actions par SHA, snapshot Debian signé/immuable, bootstrap CA content-addressé avec SHA-256 et versions directes prouvées par `apt-cache`/build. Le runbook limite honnêtement la promesse aux inputs d'une plateforme et impose le déploiement du digest CI produit.

### Revue corrective 2/5

- Scan RED : les deux listes Compose héritées du host, la forme PowerShell, l'affectation JavaScript augmentée et l'export shell nu produisaient zéro finding; une exclusion de dossier masquait aussi une injection dans un document. GREEN intermédiaire : toute occurrence exacte, insensible à la casse et bornée comme identifiant, échouait fermée sans exclusion par chemin. La revue 4/5 ci-dessous supprime ensuite entièrement l'ancien mécanisme d'exception locale.
- Symlink RED : une cible externe pouvait changer après génération sans invalider le manifeste; liens cassés et cycles étaient également acceptés. GREEN : avant toute comparaison du manifeste, le validateur résout chaque symlink, exige que sa cible réelle soit un fichier régulier sous le runtime et refuse sinon. Un lien interne stable vers un fichier inventorié reste accepté. Le runbook impose `venv --copies` pour ne pas dépendre d'un interpréteur externe au montage.

### Revue corrective 3/5

- Suppression RED : un marqueur placé dans une chaîne JavaScript ou une valeur JSON supprimait toute la ligne. GREEN : la directive doit être la ligne entière d'un vrai commentaire reconnu selon l'extension (`//`, `#` ou commentaire HTML Markdown) et ne supprime que la ligne suivante. Les deux bypass exacts et une suppression légitime sont couverts.
- Encodage RED : un script PowerShell UTF-16 était interprété comme NUL-bearing puis ignoré. GREEN : BOM UTF-16LE/BE et UTF-8 sont décodés fatalement; NUL, séquence invalide ou encodage ambigu lève une erreur et fait échouer le scan. Le fixture PowerShell UTF-16LE exact et son pendant BE sont couverts.
- Fragmentation RED : concaténation de littéraux JavaScript et continuation shell rendaient les noms invisibles. GREEN : une vue syntaxique normalisée, avec correspondance vers la ligne source et limites d'identifiant, détecte les deux formes exactes sans transformer les suppressions en exclusion de dossier.
- TOCTOU RED : le bind validé restait la source Python exécutée et pouvait être retargeté côté hôte. GREEN : le manifeste externe est figé dans le scratch, le bind est validé, copié dans `mkdtemp`, puis la copie est revalidée avant le premier import. L'env enfant pointe seulement vers la copie, retire les trois chemins Python injectables et force les modes safe/no-user-site. Un test réel prouve qu'une mutation source+manifeste entre les validations échoue et nettoie atomiquement le scratch; un autre prouve qu'une mutation du bind après copie ne change pas les bytes privés et que le gate scheduler refuse la source mais accepte le chemin privé.

### Revue corrective 4/5

- Scanner RED : l'ancienne ligne d'exception supprimait encore le finding suivant et quatre fragments via commentaires, quotes, parenthèses, template et scalar rendaient zéro résultat. GREEN : le mécanisme d'exception est supprimé entièrement; les noms centraux et les fixtures sont construits indépendamment par codepoints. Deux vues mappées vers la source, brute et sans commentaires, retirent les séparateurs syntaxiques et couvrent aussi HTML, heredoc et continuation shell. Les binaires suivis ne sont ignorés qu'après validation de leur signature, donc un fichier texte renommé reste scanné. Lecture, UTF-8/16 et NUL restent fail-closed.
- Python RED : la copie acceptait un `.pth`, conservait les variables source/import et ne disposait d'aucun argv isolé. GREEN : tout `.pth` est refusé après copie, les variables source et les trois chemins Python hérités sont supprimés, le probe et le worker utilisent `-I`, et le bootstrap n'ajoute que le dossier du worker Indy. Un test réel avec `sitecustomize` externe prouve qu'il n'est pas exécuté.
- Modes RED : une source en `0777` conservait ses droits dans le runtime privé. GREEN : répertoires `0550`, fichiers `0440`, seule exception exécutable Python `0550`; manifeste, absence de `.pth` et modes sont revérifiés avant chaque spawn et à chaque readiness. Le test Linux exécuté sous UID/GID numérique `10001` prouve les modes et le refus d'écriture directe. Le runbook précise que le même UID peut techniquement refaire un `chmod`, d'où ces gates répétés plutôt qu'une promesse d'immuabilité.

## Vérifications exécutées

- `pnpm install --frozen-lockfile` — exit 0, lockfile à jour, pnpm `11.1.2`.
- `pnpm exec vitest run tests/model-key-scan.test.ts tests/container-entrypoint.test.ts tests/runtime-policy.test.ts tests/hermes-runtime-manifest.test.ts` — revue 4/5 ciblée : 4 fichiers, 27 réussis, le test de modes Linux seul différé sous Windows.
- `pnpm test` — 31 fichiers, 254 réussis et 1 test Linux différé sous Windows, 0 échec.
- `python -m unittest discover -s tests -p "test_*.py"` — 41 tests, 0 échec.
- `pnpm typecheck` — serveur et client, exit 0.
- `pnpm build` — serveur/client/assets, exit 0; 2 602 modules transformés.
- `pnpm secret:scan` — tous fichiers texte suivis sans mécanisme d'exception, 0 référence interdite.
- `pnpm test:e2e` — rebuild client/serveur puis 3 scénarios, 3 réussis en 8,4 s après la revue 4/5.
- `docker compose -f docker-compose.example.yml config --quiet` avec substitutions représentatives — exit 0.
- parsing `.github/workflows/ci.yml` avec la dépendance YAML du projet — workflow `ci`, 15 étapes, exit 0.
- `docker build --target build --tag indy-task11-round4-test .` — cible Linux build/typecheck verte. Le premier run root a confirmé que `0440` ne bloque pas UID 0 et n'a donc pas été accepté comme preuve; rerun `docker run --user 10001:10001 --tmpfs /app/node_modules/.vite-temp:...` avec tests montés RO : 15/15 réussis, y compris modes `0550/0440`, refus d'écriture et scanner.
- `docker build --tag indy-task11-round4 .` — passage définitif exit 0; image `sha256:9aac4e6d6c5a881a2b6e052d02f4bb5a63b88e65482f0adccb48bb49aad6e292`.
- `docker image inspect indy-task11-round4` et helpers jetables — `User="indy:indy"`, healthcheck liveness attendu, contrôle d'environnement générique vert, Python `-I` sous UID `10001` vert.
- `docker image inspect indy-task11-round3` et `docker run --rm --entrypoint node ...` — `User="indy:indy"`, healthcheck `healthcheck.js` (liveness), source `/opt/hermes`, scratch `/run/indy-runtime`, UID/GID `10001`, mode `0700`.
- `docker run --rm --entrypoint dpkg-query indy-task11:review2 ...` — `ca-certificates=20230311+deb12u1`, `python3=3.11.2-1+b1`, `tini=0.19.0-1+b3`.
- générateur de manifeste exécuté dans l'image sur un arbre éphémère — inventaire ordonné d'un fichier et d'un symlink, exit 0.
- `docker run --rm indy-task11:review2` sans runtime Hermes — exit 1, `ENOENT ... lstat '/opt/hermes'`, donc échec fermé avant Python.
- `git diff --check` et `git diff --cached --check` — exécutés après ce rapport et avant commit; le scan est ensuite rejoué depuis HEAD.

## Commits Task 11

- `37d6e19` — `chore: harden Indy container readiness`.
- `6bacb88` — `test: add autonomous production-auth E2E`.
- `04b85e8` — `chore: ship Indy Codex OAuth cockpit`.
- `dd2325f` — `fix: close Task 11 deployment review gaps`.
- `49646f6` — `fix: fail closed on runtime and key references`.
- `287fb10` — `fix: close Task 11 scanner and runtime races`.
- Un commit correctif atomique ferme les findings de revue 4/5 décrits ci-dessus; son hash est communiqué avec le statut final.

## Vérifications réservées au VPS

La recette VPS manuelle n'a pas été exécutée localement. Restent obligatoires sur le serveur cible : création UID/GID et modes, import/hash/realpath du runtime Hermes réellement monté, version SQLite et `hermes doctor`, device login réel `etienne-openai`, catalogue Codex frais réel, réseau/CIDR socket réel, module Nginx headers-more et strip wildcard, secret rotation, firewall/port inaccessible, Coolify, sauvegarde/restore drill, rollout/rollback par digest, mission réelle avec outil/correction/reprise après restart, et absence de toute clé modèle dans l'environnement du conteneur. Les commandes exactes sont dans `docs/runbook-vps.md`.

## Préoccupations et éléments de revue finale

- La suite Python locale signale que son SQLite `3.50.4` est affecté par le bug WAL-reset; Hermes bascule volontairement en `journal_mode=DELETE`. Le VPS doit utiliser SQLite `3.51.3+` ou un backport corrigé (`3.50.7` / `3.44.6`) et exécuter `hermes doctor`, sans modifier les bytes du scheduler épinglé.
- Le warning Vite historique sur le chunk principal d'environ 673 kB gzip demeure hors Task 11.
- L'image n'embarque délibérément pas Hermes : l'exploitation doit fournir l'artefact exact revu. C'est une barrière fail-closed, pas une installation automatique incomplète.
- Le runtime revu ne peut contenir aucun symlink vers l'interpréteur du host ou un répertoire externe; reconstruire son venv avec `--copies` avant de générer et approuver le manifeste.
- Les actions GitHub sont désormais épinglées par SHA. Leur mise à jour doit vérifier le tag officiel puis revoir le diff de l'action avant de remplacer le commit.
- **Finding Task 10 parqué, non modifié ici :** un manifeste contradictoire `status=completed` avec `hermesStatus=failed|unknown` peut encore passer le parseur. Le producteur interne hash-pinné émet des paires cohérentes et Task 11 n'analyse pas ces manifests; le finding doit impérativement rester visible dans la revue globale et être corrigé/accepté explicitement avant la décision finale de livraison.
