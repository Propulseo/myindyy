# Task 10 — crons Hermes sous politique Codex OAuth

## Résultat

- Hermes reste l’unique source du planning et l’unique ticker. Indy ne persiste ni ne réécrit les expressions de planning. Le seul nouveau cycle périodique est un import passif des fichiers d’exécution déjà écrits par Hermes; ses dépendances ne permettent ni `runScheduledTask` ni `tickScheduledTasks`.
- Les créations, modifications, reprises et déclenchements manuels sont validés avant toute mutation Hermes contre un diagnostic runtime frais. La politique exige exactement `provider=openai-codex`, le profil `etienne-openai` connecté, un modèle explicite du catalogue authentifié, un effort explicitement publié par ce modèle et un workdir canonique appartenant au registre serveur. Un catalogue indisponible, un tableau d’efforts `null`, une traversée ou une cible de symlink externe échouent fermé sans fallback.
- `INDY_SCHEDULED_WORKDIRS` ajoute des racines au registre côté serveur; le workspace Minions demeure autorisé par défaut. Seuls des répertoires existants résolus par le filesystem sont conservés.
- Chaque occurrence durable Hermes est projetée exactement une fois sous la clé `cron:<scheduledTaskId>:<HermesRunId>`. Un index SQLite unique et un upsert transactionnel protègent les redémarrages et scans répétés. Une identité mission `cron:<scheduledTaskId>` porte uniquement l’historique de contrôle; les requêtes du board excluent ces identités et SQLite ne devient jamais la source du planning.
- Les événements importés conservent début, terminal, timestamps, statut, erreur redacted, provider, modèle, effort, workdir et provenance du fichier Hermes. Aucun succès n’est créé à la réception d’un clic manuel : l’occurrence apparaît seulement après détection du fichier durable.
- Le déclenchement manuel exige `Idempotency-Key`. Une même clé avec le même payload rejoue la réponse enregistrée sans second trigger; la réutilisation avec un payload différent retourne `409`. Les erreurs worker et runtime retournées au cockpit sont typées et ne recopient pas de credentials.
- Le cockpit affiche l’état OAuth/profil/catalogue, provider, modèle, effort, prochain passage, dernier passage, statut et dernière erreur. `Exécuter maintenant` reste désactivé sans readiness serveur explicite et affiche exactement le motif de refus français renvoyé par le serveur. La création/édition ne propose que les modèles, efforts et workdirs publiés par le serveur.
- L’adaptateur Python transporte `reasoning_effort` sans fallback sur création, mise à jour et normalisation. La valeur interne `limit=0`, non exposée par la route HTTP, permet au projecteur de lire tous les crons Hermes au lieu de tronquer l’import à 100.

## TDD RED / GREEN

- RED politique : la matrice création/mise à jour/run-now acceptait encore provider, modèle, effort ou workdir invalides et le module de policy n’existait pas. GREEN après ajout de la validation typée, du catalogue frais et du registre canonique.
- RED idempotence : deux POST manuels identiques déclenchaient Hermes deux fois et aucun conflit de payload n’était conservé. GREEN avec `operator_commands`, hash canonique et replay durable.
- RED projection : aucune occurrence Hermes n’alimentait `mission_runs`, les redémarrages ne possédaient pas de clé unique, et l’import automatique hors navigateur n’existait pas. GREEN avec identité cron stable, occurrence key unique, upsert transactionnel et réconciliateur passif.
- RED Python : `reasoning_effort` disparaissait des jobs créés/mis à jour. GREEN après transport explicite; une régression additionnelle a montré que l’import interne était tronqué à une entrée pour `limit=0`, puis est passée avec le sentinel non borné.
- RED UI : sans readiness serveur, le helper autorisait implicitement le bouton. GREEN en fail-closed, avec conservation exacte des cinq motifs de refus testés.
- RED sécurité final : une erreur brute de mutation pouvait renvoyer `Bearer oauth-secret-should-stay-private`; GREEN avec une erreur worker générique typée. L’événement `run.failed` omettait aussi l’erreur durable; GREEN après ajout de l’erreur et redaction des valeurs sensibles.

## Fichiers

- Politique/API/runtime : `server/scheduled-tasks/policy.ts`, `server/routes/scheduled-tasks.ts`, `server/runtime/hermes-runtime.ts`, `server/app.ts`, `shared/types.ts`.
- Projection/historique : `server/scheduled-tasks/projection.ts`, `server/scheduled-tasks/runs.ts`, `server/runs/repository.ts`, `server/runs/types.ts`, `server/db/schema.sql`, `server/db/index.ts`, `server/db/queries.ts`, `server/index.ts`.
- Adaptateur worker : `server/workers/hermes_scheduled_tasks.py`.
- Cockpit : `client/src/components/ScheduledTasksPage.tsx`, `client/src/lib/api.ts`, `client/src/lib/scheduledTaskReadiness.ts`.
- Tests : `tests/scheduled-runtime-policy.test.ts`, `tests/scheduled-occurrence-projection.test.ts`, `tests/test_hermes_worker_resolve.py`, `client/src/lib/scheduledTaskReadiness.test.ts`.
- Contrat opératoire : `README.md`, `.env.example`.
- Rapport : ce fichier.

## Vérifications finales

- Ciblé TypeScript : 3 fichiers, 61 tests, 0 échec.
- Python worker : 19 tests, 0 échec.
- `pnpm test` : 21 fichiers, 194 tests, 0 échec.
- `pnpm typecheck` : serveur et client, exit 0.
- `pnpm build` : serveur, client et assets, exit 0; 2 601 modules transformés.
- `git diff --check` : exit 0.

## Auto-revue et préoccupations

- La readiness affichée n’est jamais reconstruite côté client : en son absence le bouton est désactivé. Create/update/pause/resume reprojettent aussi la tâche avant réponse afin de ne pas réintroduire un objet UI sans acknowledgement serveur.
- L’importeur démarre avant l’écoute HTTP puis rescane toutes les 60 secondes, sans chevauchement. Il observe les manifests terminaux indépendamment de la liste de jobs vivants; une erreur de scan est journalisée et le prochain scan peut reprendre.
- Les anciens crons non conformes ne sont ni migrés ni réécrits. Ils restent visibles avec leur état/historique, mais reprise et run-now sont bloqués avec un motif précis jusqu’à correction explicite.
- Le warning Vite historique sur le chunk global d’environ 673 kB gzip demeure hors Task 10. Aucune préoccupation critique ou importante restante.

## Fix review round 1/5

- Admission déplacée dans un hook contrôlé de `cron.scheduler.run_job`, donc commune aux ticks périodiques, ticks immédiats et exécutions directes. Le runtime/catalogue est relu pour chaque job; profil, provider, modèle, effort et workdir sont revérifiés juste avant l’effet. Les refus produisent une occurrence Hermes échouée sans appel agent. Le fallback provider/modèle est neutralisé par `ContextVar` uniquement pendant l’exécution cron admise.
- Le déclenchement manuel est désormais une outbox durable. Le claim précède tout lookup/policy; replay terminé et conflit de payload ne dépendent plus de l’existence actuelle du job ou du runtime. Un propriétaire non résolu renvoie `202 pending`. La reprise startup revalide la policy puis renvoie le même token.
- Le receipt Hermes ne repose plus sur une heuristique de timestamp/fingerprint. Sous le verrou cross-process `cron.jobs._jobs_lock`, `indy_dispatch_token` est persisté dans la même mutation `jobs.json` que `manual_run_at/next_run_at`. Crash-before reprend; crash-after constate le marqueur exact et ne redéclenche pas; une mutation concurrente sans ce token ne peut simuler l’effet.
- Chaque occurrence écrit d'abord un pending et un output redacted. Le manifeste terminal immuable et atomique n'est finalisé qu'après preuve durable `completed` ou `failed` dans le ledger `cron.executions`; les états running, inconnus ou partiels restent différés. La projection ne consulte plus la liste de jobs vivants en production, ignore raw/partial/temp/unclassified, conserve les timestamps exacts et le snapshot historique, et reste idempotente par clé `(task, HermesRunId)` après disparition du job/fichier.
- Toutes les mutations publiques task et commandes mission filtrent `mission_kind='interactive'`, y compris viewed/move/delete et cascade. Les projections cron ne sont contrôlables que par les routes planifiées.
- Une redaction centrale protège previews, contenu complet, erreurs HTTP et payloads d’événements. Les output refs de manifest ne sont lus que si leur `realpath` reste sous le répertoire de manifests et se termine par `.output.json`.
- Le cockpit corrèle un run manuel uniquement par le dispatch token du manifest, marque l’historique brut comme non corrélé et bascule immédiatement la readiness en refus fail-closed après une erreur policy autoritative, puis rafraîchit le serveur.

### TDD du fix

- RED/GREEN Python: bypass automatique, fraîcheur par job, fallback contextuel, crash-before/crash-after, mutation concurrente et ID d’exécution Hermes stable.
- RED/GREEN API: isolation directe de toutes les routes génériques, claim avant lookup, refus stocké, duplicate concurrent pending, payload conflict et reprise outbox.
- RED/GREEN projection: manifests de jobs supprimés, config historique, timestamps exacts, mêmes run IDs sur deux tâches, concurrence/restart, tombstone et boucle passive.
- RED/GREEN sécurité/UI: secrets bearer/token/password/credential absents des previews et contenus complets; corrélation stricte par token; readiness immédiatement fail-closed.

### Vérifications du fix

- Ciblé TypeScript: 8 fichiers, 85 tests, 0 échec.
- Python worker: 25 tests, 0 échec.
- `pnpm typecheck`: serveur et client, exit 0.
- `pnpm test`: 25 fichiers, 207 tests, 0 échec.
- `pnpm build`: serveur, client et assets, exit 0; 2 602 modules transformés. Le warning Vite historique sur le chunk principal reste inchangé.
- `git diff --check`: exit 0.

## Fix review round 2/5

- Le hook d’admission est installé synchroniquement avant le thread ticker et avant la boucle de requêtes du worker. Une signature Hermes incompatible empêche le worker de démarrer; aucun chemin ne retombe sur le runner original. Le hook consomme l’ID réel de `cron.executions` transporté par le job réclamé. L’appel direct qui n’expose pas cet ID est explicitement refusé, sans UUID fabriqué ni manifeste mensonger.
- Le replay du receipt durable précède maintenant tout lookup du job, du profil ou du catalogue dans Node et Python. Un receipt `accepted` ou `failed` exact reste donc rejouable après suppression/renommage du job ou expiration OAuth; un token attaché à une autre tâche échoue fermé.
- L’outbox SQLite possède des leases transactionnels, compte les tentatives et conserve la prochaine échéance. Les erreurs worker déterministes deviennent des réponses terminales rejouables. Les indisponibilités transitoires restent `202 pending`; une boucle passive bornée, sans chevauchement et avec backoff reprend les commandes déjà réclamées. Un retry utilisateur peut avancer une commande libre mais ne vole jamais le lease d’un propriétaire actif.
- Sous `cron.jobs._jobs_lock`, le token manuel est associé une seule fois à l’ID d’occurrence réel puis retiré du job. Le receipt est écrit avant le retrait : un crash intermédiaire ne permet pas à une occurrence automatique ultérieure d’hériter du token. Un `ContextVar` transporte cette association exacte jusqu’au manifeste.
- La redaction centrale TypeScript/Python couvre désormais l’intégralité des credentials `Authorization` (Basic, Digest et autres schémas), les champs structurés et les valeurs de provenance. Le nom de tâche et le snapshot provider/modèle/workdir sont nettoyés avant manifeste, SQLite et projection HTTP/UI.

### TDD du fix round 2

- RED/GREEN Python : installation précoce, échec d’installation, garde contre la signature Hermes, ID durable direct, replay receipt avant job, consommation one-shot du token, concurrence tick et redaction Basic/Digest.
- RED/GREEN API/outbox : receipt avant policy, failure durable, lease concurrent, reprise après indisponibilité transitoire et boucle sans chevauchement.
- RED/GREEN projection/sécurité : credentials dans nom, config, erreurs, JSON et output complet absents de SQLite et des réponses HTTP.

### Vérifications du fix round 2

- Ciblé TypeScript : 3 fichiers, 66 tests, 0 échec.
- Python worker ciblé : 17 tests, 0 échec; module complet : 32 tests, 0 échec.
- `pnpm test` (binaire Vitest installé) : 25 fichiers, 213 tests, 0 échec.
- Typecheck serveur et client : exit 0.
- `pnpm build` : serveur, client et assets, exit 0; 2 602 modules transformés. Le warning Vite historique sur le chunk principal reste inchangé.
- `git diff --check` : exit 0.

### Préoccupations

- Le fallback documenté est volontairement fail-closed : les appels directs internes qui ne rendent pas disponible l’ID durable Hermes sont refusés. Les exécutions supportées passent par le ticker/API Hermes et conservent l’ID ledger réel.
- La boucle de reprise d’outbox n’est pas un scheduler de cron : elle ne calcule aucune échéance de tâche et ne déclenche que des commandes manuelles déjà réclamées avec leur token durable.
