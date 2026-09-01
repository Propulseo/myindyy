# Task 8 — accueil Étienne et timeline d’exécution

## Plan design — passe 1

- Sujet / audience / job : cockpit personnel d’Étienne ; rendre les exceptions de ses agents visibles et actionnables en moins de 30 secondes.
- Couleurs : Ink `#0B0D12`, Panel `#151821`, Fog `#ECEAF5`, Periwinkle `#7C96FF`, Signal Amber `#E6A85C`, Stable Green `#65C18C`.
- Type : missions en `Iowan Old Style, Palatino Linotype, serif` ; corps en `ui-sans-serif, system-ui` ; données et repères en `ui-monospace, SFMono-Regular`.
- Layout : navigation compacte, rail de pouls étroit, puis espace de travail ; sur mobile, barre basse et contenu plein écran.
- Signature : le « mission pulse rail » encode l’état par couleur et la fraîcheur par intensité ; seule l’activité live respire lentement.

```text
DESKTOP  [nav] [pulse │ │ ● │] [À décider / À débloquer / En cours / À relire / Top 5]
DETAIL   [nav] [pulse │ ● │ │] [mission + contrôles] [timeline par tentative]
MOBILE   [contenu plein écran : priorité active]
         [accueil] [missions] [nouvelle] [fichiers]
```

## Critique et révision — passe 2

La première passe risquait de transformer chaque priorité en carte interchangeable et le rail en décoration. Révision : les priorités deviennent des bandes éditoriales séparées par des règles, avec une densité croissante selon l’urgence. Le rail est dérivé des vraies missions et runs (statut + `lastActivityAt`) et sert de navigation vers la mission. L’action utile reste dans chaque ligne, sans boutons décoratifs. Aucun gradient, aucune fixture ; l’état Obsidian reste explicitement « Connecteur non activé ». Sur mobile, le rail devient une ligne de pouls horizontale au-dessus du contenu plutôt qu’un second panneau.

## TDD RED / GREEN

- RED : `pnpm test -- client/src/components/RunTimeline.test.tsx client/src/components/RunControls.test.tsx` échoue sur les imports absents `./RunTimeline` et `./RunControls` (2 suites en échec, motif attendu).
- GREEN ciblé : même commande, 2 fichiers et 6 tests passent.
- Mutation mentale : retirer la clé idempotente, annoncer le succès avant résolution serveur, masquer l’erreur serveur, perdre le regroupement par tentative ou remplacer l’état vide fait échouer au moins une assertion dédiée.

## Fichiers

- Créés : `TodayPage.tsx`, `RunTimeline.tsx`, `RunControls.tsx`, `RuntimeBadge.tsx` et les deux tests composants.
- Modifiés : `App.tsx`, `TaskDetailPage.tsx`, `NewTaskPage.tsx`, `api.ts`, `store.ts`, `globals.css`, `vitest.config.ts`, `package.json`, `pnpm-lock.yaml`.
- Le fichier préexistant `TaskDetailPage.tsx` passe de 294 à 310 lignes : dépassement du seuil cible de 250 justifié par l’intégration locale du panneau d’exécution, tout en restant sous le maximum autorisé de 350. Une extraction de son en-tête historique serait un refactor séparé sans valeur fonctionnelle pour ce jalon.

## Vérifications

- `pnpm test` → 10 fichiers, 64 tests, 0 échec.
- `pnpm typecheck` → TypeScript serveur et client, exit 0.
- `pnpm build` → build serveur, client et assets, exit 0 ; 2 597 modules transformés.
- `git diff --check` → aucune erreur d’espace ou de patch.
- Audit production → aucune fixture, aucun `Math.random`, aucun `console.log/error` ajouté ; couleurs uniquement via tokens CSS globaux.

## Auto-revue

- Contrats : `/api/runtime`, historique `messages+runs+events` et commandes avec `Idempotency-Key` sont consommés sans modifier les routes serveur.
- Vérité serveur : aucun succès n’est affiché avant résolution ; un rejet, dont 409, conserve la vue et expose la cause.
- Création : modèle obligatoire, OAuth `connected` obligatoire, provider fixé à `openai-codex`, profil affiché `etienne-openai`; `reasoningEfforts:null` ne produit que « Réglage global ».
- Données : l’accueil se rafraîchit depuis les mises à jour SSE de tâches/runs et recharge l’historique durable ; Top 5 affiche uniquement « Connecteur non activé ».
- Design, seconde critique : le rail horizontal mobile manquait lors de la première implémentation ; il a été ajouté. Le mouvement est limité au run live et neutralisé par `prefers-reduced-motion`. Les sections restent des bandes éditoriales et non une collection de cartes.
- Accessibilité : contrôles nommés, labels de formulaire, alert/status sémantiques, focus visible et cibles tactiles de 40 px minimum.
- Limites honnêtes : aucun champ projet n’existe dans `Task`, donc l’UI affiche « Projet · non renseigné » plutôt que d’inventer une valeur. Le build signale le chunk global historique `index` à 670,21 kB gzip ; sa réduction demande un chantier de découpage des routes hors Task 8.

## Fix round 1/5 — 2026-09-01

### RED / GREEN

- RED : les quatre suites ciblées échouent sur les comportements absents : invalidation `task_run_updated`, fraîcheur du rail, profil réel/mismatch, erreur outil, libellés distincts et layout mobile. Le test layout a ensuite échoué spécifiquement sur l’import absent `AppMain`, avant extraction.
- GREEN ciblé : `RunTimeline`, `RunControls`, `TodayPage` et `MissionWorkspace` passent, 17 tests sur 17.
- Suite complète : 12 fichiers, 75 tests, 0 échec.

### Corrections

- Chaque événement board pertinent incrémente maintenant une révision d’historique par mission. `TodayPage` et `TaskDetailPage` rechargent cette révision ; les réponses obsolètes sont rejetées et les requêtes concurrentes sont isolées par révision.
- `tool.completed` avec `payload.status="error"` utilise `CircleAlert`, le ton ambre et le libellé « Échec ». Les statuts et fallbacks de timeline sont traduits.
- La création exige OAuth connecté, le profil réel `etienne-openai` et un catalogue non vide. Le badge montre toujours le `profileId` réel et indique comment reconnecter le profil attendu.
- `AppMain` et `MissionWorkspace` rendent le contenu, le chat, la timeline et les contrôles scrollables sur mobile ; le test DOM vérifie les classes des deux régions.
- Le pulse rail expose `fresh` avant 15 minutes, `warm` de 15 à moins de 45 minutes, puis `stale`; les frontières et le libellé accessible sont testés. L’animation live utilise une légère mise à l’échelle afin de ne pas écraser l’intensité de fraîcheur, et reste neutralisée par `prefers-reduced-motion`.
- Les deux champs de contrôle portent désormais les labels distincts « Instruction à ajouter » et « Instruction de correction ».

### Vérifications et auto-revue

- `pnpm test` → 12 fichiers, 75 tests PASS.
- `pnpm typecheck` → serveur et client, exit 0.
- Build client Vite direct → exit 0 ; `pnpm build:server` et `pnpm build:assets` → exit 0.
- `git diff --check` → aucune erreur.
- `TaskDetailPage.tsx` atteint 341 lignes après intégration du rafraîchissement durable ; il reste sous le maximum autorisé de 350. Les deux zones de layout ont été extraites pour contenir cette croissance.
- Auto-revue : une réponse réseau ancienne ne peut pas remplacer une révision SSE récente ; un événement board provoque au plus un fetch dans la page actuellement montée ; aucun état de succès local n’est simulé.

## Fix round 2/5 — 2026-09-02

### RED / GREEN

- RED ciblé : le premier passage exécutable produit 5 fichiers en échec, 8 assertions rouges et 7 vertes. Les régressions reproduisent la réponse sœur abandonnée dans le batch Today, la navigation Detail bloquée entre deux missions à révision identique, le rail qui ne vieillit pas, le temps relatif anglais et le fallback de création absent. La nouvelle suite `useTasks` a d’abord révélé un prérequis jsdom (`localStorage`) corrigé dans son en-tête de test.
- GREEN ciblé : `useTasks`, `TodayPage`, `TaskDetailPage`, `format` et `NewTaskPage` passent, 17 tests sur 17.
- GREEN final après extraction de l’horloge : suite complète de 16 fichiers, 85 tests sur 85.

### Corrections

- Les snapshots `fetchTasks` initiaux et de reconnexion passent par `applyTaskSnapshot`. Une progression monotone de `updated_at` ou `last_agent_response_at` invalide l’historique durable, y compris lorsqu’un run terminé pendant la coupure n’apparaît plus dans le snapshot des runs actifs.
- Le batch Today utilise une identité propre à chaque mission et révision. La résolution d’une requête ne rend plus obsolètes ses sœurs ; une réponse d’une ancienne identité ne peut pas remplacer la version courante.
- Detail déduplique les requêtes avec la clé composée `taskId:revision`. Deux missions partageant la même révision chargent chacune leur historique, et le store continue de rejeter une réponse de révision périmée.
- Une horloge partagée programme un seul timer sur la prochaine frontière réelle du rail. Elle bascule automatiquement `fresh` vers `warm` à 15 minutes puis `stale` à 45 minutes, sans animation supplémentaire ; la règle `prefers-reduced-motion` existante reste applicable au seul mouvement live.
- `timeAgo` est désormais un formateur français commun et testable avec une horloge injectée. Le fallback de création visible devient « Impossible de créer la mission ».

### Fichiers et vérifications

- Créés : `useFreshnessClock.ts`, `useTasks.test.ts`, `TaskDetailPage.test.tsx`, `format.test.ts`, `NewTaskPage.test.ts`.
- Modifiés : `useTasks.ts`, `TodayPage.tsx` et son test, `TaskDetailPage.tsx`, `NewTaskPage.tsx`, `format.ts`.
- `pnpm test` → 16 fichiers, 85 tests PASS.
- `pnpm typecheck` → TypeScript serveur et client, exit 0.
- `pnpm build` → serveur, client et assets, exit 0 ; 2 600 modules transformés.
- `git diff --check` → aucune erreur. `TodayPage.tsx` redescend à 227 lignes après extraction ; `TaskDetailPage.tsx` reste à 343 lignes, sous le maximum documenté de 350.

### Auto-revue

- Les invalidations de snapshot sont limitées aux signaux serveur strictement plus récents : un snapshot identique ne crée ni fetch ni boucle.
- Les gardes asynchrones sont séparées par mission ; le nettoyage ne supprime une entrée que si son identité correspond encore à la requête terminée.
- Le timer de fraîcheur est unique pour toute la page, s’arrête quand toutes les missions sont anciennes ou sans activité, et ses deux frontières exactes sont couvertes avec de faux timers.
- Aucun succès optimiste, fixture ou état de run inventé n’a été ajouté. Préoccupation inchangée et hors Task 8 : Vite avertit toujours sur le chunk global historique `index` à environ 671 kB gzip.

## Fix round 3/5 — 2026-09-02

### RED / GREEN

- RED initial : les deux suites ciblées reproduisent 5 échecs sur 8 tests : une activité chargée à 20 ou 45 minutes reste `fresh`, tandis qu’un snapshot HTTP ancien écrase une update SSE, retire une création SSE et ressuscite une suppression connue.
- RED complémentaire : le test du seul signal `last_agent_response_at` échoue car l’égalité du store l’ignorait ; un dernier test démontre qu’une suppression SSE d’une mission inconnue au début de la requête pouvait aussi être ressuscitée.
- GREEN ciblé final : `useTasks`, `useFreshnessClock` et `TodayPage` passent, 19 tests sur 19.

### Corrections et auto-revue

- Au changement de clé d’activité, `useFreshnessClock` retourne immédiatement une heure recalculée, rebase ensuite son état et ne conserve qu’un timer vers la prochaine frontière. Une activité déjà âgée de 20 minutes apparaît donc `warm` au premier rendu pertinent ; à 45 minutes elle apparaît `stale` sans timer inutile.
- Chaque chargement HTTP capture avant `fetchTasks` une baseline des tâches et la séquence courante du board. À résolution, la fusion garde toute valeur courante plus récente et les mutations SSE survenues pendant la requête.
- La séquence par mission couvre aussi les tombstones : une suppression SSE ne peut pas être annulée par une réponse plus ancienne, même si la mission était inconnue lors du départ. En revanche, une tâche absente de la réponse et inchangée depuis la baseline est bien supprimée par le snapshot autoritaire.
- L’égalité `upsertTask` inclut désormais `last_agent_response_at`, afin que ce signal monotone puisse progresser indépendamment de `updated_at`.
- Préoccupation inchangée et hors Task 8 : le build Vite conserve son avertissement sur le chunk global historique, environ 672 kB gzip.

### Vérifications

- `pnpm test` → 17 fichiers, 93 tests PASS.
- `pnpm typecheck` → TypeScript serveur et client, exit 0.
- `pnpm build` → serveur, client et assets, exit 0 ; 2 600 modules transformés.
- `git diff --check` → aucune erreur.
