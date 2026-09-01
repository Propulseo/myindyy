# Task 9 — accès privé Étienne

## Résultat

- Toute la surface `/api/**` passe par `requireEtienne` avant les parseurs de body et les routeurs. Cela couvre les tâches, missions, fichiers, agent, crons, skills, runtime, `/api/events`, le SSE par mission, `/api/health` et `/api/version`.
- En production, la configuration n'est disponible que si `INDY_PUBLIC_ORIGIN` est une origine HTTPS canonique valide. L’identité n’est ensuite acceptée que si l’adresse réelle `req.socket.remoteAddress` appartient à `INDY_TRUSTED_PROXY_CIDRS`, si `X-Indy-Proxy-Secret` correspond au contenu de `INDY_PROXY_SECRET_FILE`, et si `X-Indy-User` vaut exactement `etienne`.
- Les CIDR configurés doivent être privés (RFC1918/loopback/link-local IPv4 ou ULA/loopback/link-local IPv6). Une entrée publique, invalide ou absente ferme l’authentification.
- Le secret est chargé uniquement depuis un chemin absolu monté, doit contenir au moins 32 octets, et est comparé via des condensats SHA-256 de taille fixe avec `timingSafeEqual`. Aucun secret ni détail de credential n’entre dans les erreurs ou logs.
- Le bypass local exige simultanément `NODE_ENV=development`, `INDY_DEV_ACTOR=etienne` et une socket loopback réelle. Il est inactif en test et production.
- Le middleware définit le type Express et `req.actor = { id: 'etienne' }`. Les commandes opérateur utilisent désormais `req.actor.id`; la constante Task 5 a été supprimée.
- Les champs d’identité body/query ne deviennent jamais autoritaires. Les champs body non consommés par une route sont sans effet; une query usurpée sur une commande laisse `operator_commands.actor_id=etienne`.
- Les assets statiques restent publics. Les routes health/version sont volontairement protégées parce qu’elles exposent l’état interne; le healthcheck Task 11 devra donc emprunter la frontière proxy authentifiée.

## TDD RED / GREEN

- RED initial : `pnpm test -- tests/auth-etienne.test.ts` produit 8 échecs et 2 tests verts. Les APIs anonymes répondaient encore `200/404/400`, `/api/events` ouvrait le SSE jusqu’au timeout, et `server/auth/etienne.ts` était absent.
- GREEN auth initial : le même fichier passe 10/10 après ajout de la frontière minimale.
- RED intégration Task 5 : auth + commandes produit 11 échecs command route, montrant les fixtures sans `req.actor` et les requêtes production sans credentials.
- GREEN intégration : auth + commandes passe 21/21 après construction explicite de l’acteur vérifié dans les tests unitaires et de secrets proxy montés dans les tests production.
- GREEN ciblé final : auth + commandes + runtime passe 27/27, puis l’auth seule passe 11/11 avec le rejet explicite des CIDR publics et le chemin socket réel pour le loopback de développement.

## Fichiers

- Créé : `server/auth/etienne.ts`.
- Modifiés : `server/app.ts`, `server/routes/runs.ts`, `README.md`.
- Créé : `tests/auth-etienne.test.ts`.
- Fixtures adaptées à la nouvelle frontière : `tests/run-commands.test.ts`, `tests/runtime-route.test.ts`.
- Rapport : ce fichier.

## Vérifications finales

- `pnpm test` → 18 fichiers, 104 tests, 0 échec.
- `pnpm typecheck` → serveur et client, exit 0.
- `pnpm build` → serveur, client et assets, exit 0; 2 600 modules transformés.
- `git diff --check` → exit 0.
- Scan source → aucun secret de test dans `server/` ou `README.md`; aucune variable de secret brut; `server/routes/runs.ts` journalise depuis `req.actor.id`.

## Auto-revue et préoccupations

- Aucune route API connue ni middleware CORS ne répond avant la frontière d’authentification.
- `X-Forwarded-For`, `Forwarded`, `req.ip` et Express `trust proxy` ne participent pas à la confiance. Le proxy doit supprimer les deux en-têtes Indy reçus du client et les réinjecter sur le hop privé.
- Le secret est lu au démarrage du module; une rotation du fichier exige un redémarrage contrôlé du processus Indy.
- Aucune préoccupation critique ou importante restante. Le warning Vite historique sur le chunk global d’environ 672 kB gzip demeure hors Task 9.

## Fix review round 1/5 — 2026-09-02

### Correctif sécurité

- Le middleware permissif `cors()` a été retiré. Indy n’émet plus `Access-Control-Allow-Origin: *` et ne répond plus aux preflights avant authentification.
- Après validation source + secret + utilisateur, toute requête browser portant `Origin` doit fournir l’origine normalisée exacte `https://Host` en production (`http://Host` en développement) et `Sec-Fetch-Site: same-origin`.
- `same-site`, `cross-site`, origine opaque/malformée et méthode unsafe browser-shaped privée d’un des deux signaux sont refusés `403` avant mutation. Un client interne sans `Origin` ni Fetch Metadata reste autorisé seulement après transport auth complet.
- Un preflight anonyme `/api/**` retourne `401` sans aucun en-tête CORS. Les accès cross-origin ne sont pas supportés; aucune réflexion d’origine ni wildcard credentials n’existe.

### Régressions ajoutées

- RED : 4 échecs ciblés sur 21 tests auth — preflight `204`, mutation hostile `201`, ACAO `*` et méthodes unsafe ambiguës acceptées.
- GREEN : 21/21 auth après retrait de CORS et ajout du contrôle Origin/Fetch Metadata.
- Le SSE `/api/tasks/:id/live` est maintenant testé directement : une mission réelle existe, mais la requête anonyme reçoit `401 application/json` avant `text/event-stream`.
- Les configurations chemin secret relatif, CIDR valide + malformed, privé + public, secret trop court et la casse `Etienne` échouent fermé.
- Chaque intégration production de `run-commands.test.ts` initialise désormais son propre home/secret, réinitialise les modules, ferme sa base et restaure l’environnement. Le test de course passe aussi seul, sans dépendre du test précédent.

### Vérifications du correctif

- `pnpm test -- tests/auth-etienne.test.ts tests/run-commands.test.ts tests/runtime-route.test.ts` → 3 fichiers, 38 tests, 0 échec.
- `pnpm test -- tests/run-commands.test.ts -t "keeps exactly one start command"` → 1 test, 0 échec (10 ignorés), exécuté isolément.
- `pnpm test` → 18 fichiers, 114 tests, 0 échec.
- `pnpm typecheck` → serveur et client, exit 0.
- `pnpm build` → serveur, client et assets, exit 0; 2 600 modules transformés. Le warning Vite historique sur le chunk global d'environ 672 kB gzip demeure hors Task 9.
- `git diff --check` → exit 0.

## Fix review round 2/5 — 2026-09-02

### Correctif sécurité

- La décision browser n'est plus dérivée du seul `Host` entrant. `INDY_PUBLIC_ORIGIN` configure au démarrage l'unique origine publique HTTPS canonique; une valeur absente ou invalide rend l'authentification indisponible hors développement.
- La configuration doit être sa propre sérialisation `URL.origin` : host en minuscules, aucun userinfo, path, slash terminal, query, fragment ni port HTTPS `:443` redondant. Un port non standard explicite reste supporté.
- Une requête browser authentifiée doit présenter simultanément l'`Origin` canonique exact, le `Host`/port canonique exact et `Sec-Fetch-Site: same-origin`. Alias, variantes de casse, ports divergents et valeurs multiples/ambiguës sont refusés `403` avant mutation.
- Le chemin interne sans `Origin` demeure disponible seulement après les trois contrôles de transport; son `Host` doit rester singulier et non ambigu. Il est documenté comme exception du hop proxy privé et de l'automatisation interne, pas comme accès navigateur.

### TDD et régressions

- RED principal : 13 échecs sur 37 tests auth. Le couple hostile `Host: hostile.example` + `Origin: https://hostile.example` mutait encore (`201`), comme les alias/casses/ports auto-cohérents; huit configurations canoniques invalides répondaient `200` plutôt que `503`.
- GREEN principal : 37/37 après parsing canonique au démarrage et comparaison indépendante de la requête.
- RED complémentaire : un POST sans `Origin` mais avec `Host` ambigu mutait encore (`201`); GREEN après rejet global d'un `Host` absent ou ambigu.
- La matrice couvre désormais origine canonique absente, relative, HTTP, userinfo, path/slash, query/fragment, casse et `:443`, plus le happy path HTTPS avec port non standard, les alias, variations de casse, divergences de port et valeurs Host/Origin multiples sérialisées.

### Vérifications du correctif

- `pnpm test -- tests/auth-etienne.test.ts tests/run-commands.test.ts tests/runtime-route.test.ts` → 3 fichiers, 57 tests, 0 échec.
- `pnpm test` → 18 fichiers, 133 tests, 0 échec.
- `pnpm typecheck` → serveur et client, exit 0.
- `pnpm build` → serveur, client et assets, exit 0; 2 600 modules transformés. Le warning Vite historique sur le chunk global d'environ 672 kB gzip demeure hors Task 9.
- `git diff --check` → exit 0.
