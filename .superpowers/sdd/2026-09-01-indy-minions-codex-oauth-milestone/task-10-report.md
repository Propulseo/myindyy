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

## Fix review round 3/5

- La machine de receipt est désormais récupérable à chaque frontière de crash. Le receipt `prepared` contient un snapshot runtime nettoyé; sous le verrou Hermes, le hook écrit le pending avec le vrai `execution_id`, lie ensuite le receipt, puis retire le token one-shot avant le runner. Une évidence pending ou terminal antérieure portant exactement `(task, token)` est reprise sans attribuer le token à l’occurrence suivante. Un receipt déjà lié peut reconstruire un pending manquant depuis son snapshot et rester finalisable depuis `cron.executions`. Un receipt seulement préparé, sans marqueur job exact, ne vaut jamais acceptation.
- Une panne temporaire de `getRuntimeStatus` ou du catalogue pendant le traitement outbox libère le lease avec backoff et conserve une réponse honnête `202 pending`. La reprise dans le même processus revalide le catalogue frais et n’effectue qu’un seul trigger. Les refus policy déterministes ne deviennent terminaux qu’après chargement réussi du runtime.
- La redaction TypeScript/Python consomme toute la valeur d’un header `Authorization` jusqu’à la fin de ligne, y compris les paramètres Digest séparés par virgules. Les clés structurées `password`, `passwd`, `pwd` et `passphrase` rejoignent token/key/secret/credential/cookie dans le scrubber récursif; outputs, manifests, SQLite et réponses HTTP ne conservent pas ces fixtures.
- L’intégration est explicitement épinglée à `hermes-agent==0.15.1`. Le démarrage valide par AST/source la chaîne réelle `create_execution` → injection/copie `execution_id` → `run_one_job` → `_run_one_job_body` → `run_job`. Version, source ou signature divergente désactive le worker avant ticker/requêtes. Le README documente la procédure d’upgrade et les tests de caractérisation obligatoires.

### TDD du fix round 3

- RED/GREEN Python : ticker avant replay Node, prepared+token, quatre frontières pending/bind/clear/runner, reconstruction d’un pending perdu, auto suivant sans token, absence de fausse acceptation inter-store, version/source drift et redaction structurée Digest/password.
- RED/GREEN API : catalogue temporairement indisponible conservé pending, récupération dans le processus, replay accepted et trigger unique.
- RED/GREEN sécurité/projection : Basic, Digest complet et aliases de mots de passe absents des previews, outputs complets, manifests et lignes SQLite.

### Vérifications du fix round 3

- Ciblé TypeScript : 3 fichiers, 66 tests, 0 échec.
- Python worker : 38 tests, 0 échec.
- `pnpm test` (binaire Vitest installé) : 25 fichiers, 213 tests, 0 échec.
- Typecheck serveur et client : exit 0.
- `pnpm build` : serveur, client et assets, exit 0; 2 602 modules transformés. Le warning Vite historique sur le chunk principal reste inchangé.
- `git diff --check` : exit 0.

## Fix review round 4/5

- Le projecteur de manifests suit maintenant les états terminaux publiés par `cron.executions._TERMINAL_STATES`. Après redémarrage réel simulé, les tentatives `claimed` et `running` dont le propriétaire est mort passent par `recover_interrupted_executions()` à `unknown`, puis quittent toujours le pending. Elles sont projetées conservativement en `failed`, avec `hermesStatus=unknown`, l’erreur Hermes exacte et `originalHermesStatus`/`startedAtEvidence` dans la provenance. Une tentative jamais démarrée emploie l’horodatage durable `claimed_at`, sans timestamp fabriqué.
- Une réponse runtime chargée avec `authState=error` est classée transitoire comme une exception de catalogue : lease libéré, backoff et réponse `202 pending`. Les états explicites `missing`/`expired`, le mauvais profil et les refus modèle/effort/workdir issus d’un inventaire réussi restent des résultats terminaux rejouables.
- Le marqueur `indy_dispatch_token` est mono-propriétaire. Une commande B ne peut plus écraser le token A : Python renvoie `scheduled_task_busy`, que l’outbox Node traite comme transitoire. Après claim/clear de A, B est reprise sans starvation. Si le hook crashe après le pending mais avant le bind/clear, le finalizer passif lie et retire A uniquement lorsque receipt, marqueur job courant et token du manifest durable concordent; il ne planifie rien. Les tests couvrent A accepted sans occurrence, les crashs après marqueur et après pending, B pending, puis deux IDs/manifests/receipts distincts.
- Les scrubbers TS/Python utilisent en premier un motif de chaîne JSON escape-aware pour la valeur `authorization`, avant le motif header jusqu’à fin de ligne. Les fixtures Digest avec guillemets échappés ne laissent plus username, nonce ou response dans output, manifest, SQLite ou HTTP.
- La confiance metadata+AST a été remplacée par l’identité cryptographique du fichier réellement importé. `cron/scheduler.py` est épinglé au SHA-256 `5b4326fffe1b783fd2016a0c5c0bde21c3c8af613cc665897b9f48565d74e3c5`; son chemin source, son module et les signatures critiques sont vérifiés avant démarrage. Une différence d’un octet/dead-code, un chemin illisible ou un autre module échoue fermé. La metadata `hermes-agent` n’est plus qu’un diagnostic et un faux mismatch metadata avec source exacte reste accepté.

### TDD du fix round 4

- RED/GREEN Python : ledger installé create/claimed/running/recover→unknown, pending finalisé; A/B concurrent avec crash; JSON Authorization échappé; hash source exact contre drift/unreadable/autre module et metadata divergente.
- RED/GREEN API/outbox : runtime retourné `error` reste pending puis connected déclenche exactement une fois; busy B reste pending et rejoue accepted après clear A.
- RED/GREEN projection/sécurité : statut Hermes original conservé dans `mission_runs.provenance_json`; username/nonce/response Digest absents des manifests, événements SQLite, previews et contenu HTTP complet.

### Vérifications du fix round 4

- Ciblé TypeScript : 4 fichiers, 73 tests, 0 échec.
- Python worker : 41 tests, 0 échec.
- `pnpm test` (binaire Vitest installé) : 25 fichiers, 216 tests, 0 échec.
- Typecheck serveur et client : exit 0.
- `pnpm build` : serveur, client et assets, exit 0; 2 602 modules transformés. Le warning Vite historique sur le chunk principal reste inchangé.
- `git diff --check` : exit 0.

## Fix review round 5/5

- `ScheduledTaskOccurrenceManifest` expose désormais une provenance typée limitée à `source`, `evidence`, `originalHermesStatus` et `startedAtEvidence`. Le parseur accepte uniquement le hook `indy-hermes-run-job-hook`, le ledger `cron.executions`, un statut original cohérent et la preuve `claimed_at` ou `started_at`; une clé étrangère, un enum inventé ou un statut contradictoire diffère le manifest entier. Les manifests historiques `completed`/`failed` sans détail restent lisibles, tandis qu’un terminal `unknown` exige la preuve complète afin de ne jamais perdre la distinction d’interruption.
- La projection conserve l’objet de provenance nettoyé et ses discriminants dans `mission_runs.provenance_json`. Le repository propage le même objet nettoyé dans les événements `run.started` et `run.completed`/`run.failed`; l’API qui expose ces enregistrements bénéficie de la redaction centrale existante.

### TDD du fix round 5

- RED TypeScript : provenance valide supprimée par le parseur, enum/clé arbitraires acceptés, et `startedAtEvidence` absent de SQLite/événements.
- GREEN TypeScript/Python : deux manifests interrompus réels, l’un jamais démarré (`claimed_at`) et l’autre déjà exécuté (`started_at`), restent distincts de l’écriture Python jusqu’aux lignes SQLite et aux événements; les chaînes de provenance injectées sont redacted avant persistance.

### Vérifications du fix round 5

- Ciblé TypeScript : 2 fichiers, 11 tests, 0 échec.
- Python worker : scénario interrompu ciblé puis module complet, 41 tests, 0 échec.
- `pnpm test` (binaire Vitest installé) : 25 fichiers, 217 tests, 0 échec.
- Typecheck serveur et client : exit 0.
- `pnpm build` : serveur, client et assets, exit 0; 2 602 modules transformés. Le warning Vite historique sur le chunk principal reste inchangé.
- `git diff --check` : exit 0.
