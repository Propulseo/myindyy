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
- L’importeur démarre avant l’écoute HTTP puis rescane toutes les 60 secondes, sans chevauchement. Il observe les crons actifs ou désactivés et tous leurs fichiers d’output; une erreur de scan est journalisée et le prochain scan peut reprendre.
- Les anciens crons non conformes ne sont ni migrés ni réécrits. Ils restent visibles avec leur état/historique, mais reprise et run-now sont bloqués avec un motif précis jusqu’à correction explicite.
- Le warning Vite historique sur le chunk global d’environ 673 kB gzip demeure hors Task 10. Aucune préoccupation critique ou importante restante.
