# Indy — cockpit multi-agents Propul'SEO

Prototype frontend navigable du cockpit interne Propul'SEO. Il sert à valider l'identité
visuelle, la navigation, la hiérarchie de l'information, les principaux écrans, les
interactions et l'expérience selon le rôle connecté.

**Ce prototype ne se connecte à rien.** Aucun backend, aucune base de données, aucune
variable d'environnement, aucun appel réseau vers Hermes, Obsidian, GitHub, l'ERP, le CRM,
Supabase, Coolify ou le VPS. Toutes les données sont fictives et vivent dans
[`src/fixtures/`](src/fixtures/).

**Aucun coût n'est affiché.** Codex tourne derrière Indy sur l'abonnement ChatGPT de
l'utilisateur. Aucun budget financier n'existe dans le modèle métier ni dans l'interface :
ni prix par mission, ni prix par jeton, ni plafond en euros. Le mot « budget » n'apparaît
dans cette documentation que pour expliquer cette absence et nommer ce qui l'a remplacé.
Ce qu'Indy encadre et montre sont des garde-fous opérationnels — durée maximale, tentatives
autorisées, agents en parallèle, échéance, niveau d'effort, dernière activité, blocage et
inactivité. Une consommation globale du forfait ne s'affiche que si Hermes ou Codex la
fournit ; aucune estimation n'est fabriquée.

---

## Installation et lancement

```bash
pnpm install
pnpm dev          # http://localhost:3000
```

Autres commandes :

```bash
pnpm lint         # ESLint (config Next.js + règles React)
pnpm typecheck    # génération des types de routes, puis tsc --noEmit
pnpm test         # Vitest : permissions, sélecteurs, règles de décision et de tâches
pnpm test:watch   # les mêmes tests, en continu
pnpm test:e2e     # Playwright : les parcours d'interface, sur le build de production
pnpm build        # build de production
pnpm start        # sert le build de production
```

`pnpm test` ne monte aucun composant : il vérifie les modules purs — permissions,
sélecteurs, réducteur.

`pnpm test:e2e` est autonome depuis un clone propre : Playwright construit
l'application, la sert, attend qu'elle réponde, joue les parcours puis arrête tout.
Un serveur déjà lancé sur le même port est réutilisé. Il faut le navigateur une
première fois :

```bash
pnpm install
pnpm exec playwright install chromium   # ou : pnpm test:e2e:install
pnpm test:e2e
```

Les parcours couverts : refus d'une décision sur M-248 (panneau sensible, aucun
champ à saisir, mission « En attente » et jamais « Annulée »), capture puis
annulation d'une tâche (elle reste affichée avec le statut « Annulée »), périmètre
des rôles (Lyes et Lucas ne voient aucune tâche personnelle, ni DocAgora), et le
petit mobile 390 × 667 (la feuille défile, l'action principale reste visible et
cliquable, la barre du bas ne recouvre rien).

Prérequis : Node 20.9 ou plus récent, pnpm 10 ou plus récent.

---

## Ce que contient le prototype

| Écran | Route | Rôle |
|---|---|---|
| Aujourd'hui | `/` | À traiter, en cours, tâches Obsidian du jour et leurs commandes, terminé récemment |
| Missions | `/missions` | Recherche, quatre filtres, trois regroupements |
| Détail d'une mission | `/missions/[id]` | Vue d'ensemble, Activité, Livrables, Diagnostic |
| Automatisations | `/automatisations` | Une ligne par récurrence, historique replié |
| Projets | `/projets`, `/projets/[id]` | Membres, missions, tâches, livrables, activité des agents, sources |
| Livrables | `/livrables` | Ce que les missions ont produit, groupé par jour |
| Historique | `/historique` | Missions closes, décisions prises, exécutions notables |
| Réglages | `/reglages` | Matrice des permissions, sources, identité visuelle, états |

La création d'une mission est un panneau, accessible partout depuis « Nouvelle mission »
ou la touche `N`. On y pose l'objectif, le projet, un modèle facultatif, la durée maximale,
les tentatives autorisées, le **nombre d'agents en parallèle** (de 1 à 4, un par défaut) et
une **échéance facultative** avec date et heure. Le résumé « Avant de lancer » reprend ces
deux valeurs, et le détail de la mission créée les affiche à son tour.

### Ce qui demande une attention humaine

« À traiter » ne liste que ce qui appelle une décision ou un geste : décisions en attente,
blocages, échecs récents, **échéances dépassées ou à moins d'une heure**, missions inactives
au-delà de 45 minutes sans le moindre évènement, garde-fous presque atteints, automatisations
sorties de leur routine. Une échéance dépassée est un incident, écrit et en ton danger ; une
échéance qui approche est une attention. Une mission ne produit jamais deux lignes : si elle
remonte déjà pour une raison plus pressante, son échéance est rappelée sur cette ligne-là.

### Les tâches Obsidian

Obsidian reste la source de vérité des tâches. Indy n'écrit jamais dans le coffre : il
compose une commande et la transmet à Hermes, qui l'applique.

| Commande | Depuis où | Ce qu'elle fait |
|---|---|---|
| `todo.capture` | « Capturer une tâche », dans les tâches du jour | Crée la tâche : titre, projet ou « Personnel », responsable, échéance, note |
| `todo.triage` | Menu d'une tâche › « Trier ou modifier » | Corrige le projet, le responsable, l'échéance ou la note |
| `todo.complete` | Menu d'une tâche › « Terminer » | Coche la tâche |
| `todo.cancel` | Menu d'une tâche › « Annuler la tâche » | Passe la tâche en « Annulée », après une confirmation qui dit la conséquence |

Chaque mutation écrit une ligne de journal qui nomme la commande, et la provenance de la
tâche devient `Hermes · todo.… → Obsidian · …`. L'état d'une tâche est toujours écrit à
côté de sa pastille : la couleur ne le porte jamais seule.

**Annuler une tâche ne la supprime pas.** Hermes demande à Obsidian de la marquer
annulée ; elle reste affichée dans les tâches du jour, en fin de liste, avec le statut
écrit « Annulée », et conserve son titre, son projet, son responsable, son échéance, sa
note et sa provenance. C'est exactement ce que le panneau de confirmation annonce avant
le geste, ce que le journal répète après, et ce que les tests vérifient.

Dans ce prototype, les quatre commandes sont **simulées** dans l'état React de la session.

### Qui a le droit, et où la règle est écrite

La règle d'autorisation d'une commande de tâche est écrite une seule fois, dans
[`authorizeTaskCommand`](src/lib/access.ts). L'interface s'en sert pour décider ce
qu'elle propose et ce qu'elle explique ; le réducteur s'en sert pour refuser une commande
qui arriverait quand même. Les deux passent donc par le même jugement.

| Règle | Effet |
|---|---|
| `tasks.manage` | Sans elle, aucune commande ne passe |
| Tâche personnelle | Réservée à son propriétaire, avec `tasks.personal.view`. Personne d'autre n'en crée, n'en transforme une en tâche personnelle, ni n'en change le responsable |
| Tâche partagée | Son projet doit être visible par l'acteur |
| Destination d'un tri | Le projet visé doit lui aussi être visible |
| Responsable choisi | Il doit être membre du projet visé |

Une commande refusée par le réducteur ne modifie **rien** — ni tâches, ni missions, ni
décisions. Elle laisse une seule ligne de journal, volontairement générique : elle ne dit
ni le titre visé, ni l'existence d'un projet qui n'est pas affecté au rôle.

> **Ces contrôles sont ceux d'une démonstration.** Ils vivent dans le navigateur : un
> appel direct au contexte les traverserait s'ils n'étaient pas dans le réducteur, et
> n'importe quel client peut de toute façon être modifié. Hermes et les connecteurs
> devront **refaire ces autorisations côté serveur** avant toute mutation réelle du
> coffre Obsidian. Ce que fait le cockpit ici, c'est décider ce qu'il propose et
> expliquer ce qu'il refuse — pas garantir un accès.

---

## Les trois rôles de démonstration

Le sélecteur en haut à droite est explicitement marqué « démonstration ». Ce n'est pas une
authentification : il change le point de vue pour vérifier ce que chaque rôle voit et peut
faire. Le choix est conservé dans le navigateur.

| | Étienne | Lyes | Lucas |
|---|---|---|---|
| Rôle | Propriétaire | Développeur | Business developer |
| Projets visibles | tous | Propul'SEO, Tao, CoProFlex, Ocean | Propul'SEO, Vernay Immobilier |
| Piloter ses missions | oui | oui | oui |
| Déployer en production | oui | oui | non |
| Publier ou envoyer à l'extérieur | oui | oui | oui |
| Prolonger une mission au-delà de ses limites | oui | non | non |
| Voir les identifiants des sources | oui | non | non |
| Capturer, trier, terminer ou annuler une tâche | toutes | ses projets | ses projets |
| Voir les tâches personnelles | oui | non | non |

Un projet non affecté n'apparaît nulle part : ni dans les listes, ni dans les filtres, ni
dans les champs d'un formulaire, ni en grisé. DocAgora n'est affecté qu'à Étienne : c'est le
témoin de ce comportement. Les tâches personnelles suivent la même règle, en plus strict :
elles n'appartiennent qu'à leur propriétaire, et Lyes comme Lucas n'en voient jamais aucune.
Quand une action sort du périmètre d'un rôle, le contrôle affiche l'explication écrite au
lieu de disparaître ou d'être désactivé sans un mot.

Toute action sensible — déploiement en production, publication, communication externe,
annulation d'une mission, prolongation au-delà des garde-fous, annulation d'une tâche —
passe par un panneau unique qui affiche l'action, la cible, le projet, l'environnement, la
révision ou le contenu, la personne qui confirme et la conséquence exacte.

**Refuser passe par ce même panneau**, avant toute mutation. Un refus ne demande aucun mot
à saisir : rien ne part vers l'extérieur. Refuser un déploiement, une publication ou une
communication externe **n'annule pas la mission** : la décision passe à « refusée », la
mission repasse « en attente », conserve ses étapes et ses livrables, et attend une nouvelle
instruction humaine. Refuser une prolongation laisse la mission continuer avec ses limites
actuelles, puis rendre la main à la limite. L'annulation complète d'une mission reste une
action séparée, avec son propre panneau.

---

## Architecture

```
src/
  app/                    routes, une par écran
  components/
    primitives/           boutons, champs, panneaux, états, mise en page
    shell/                barre latérale, barre supérieure, rôle, états d'écran
    pulse/                le Pouls Indy et sa géométrie
    status/              pastilles, jauges, provenance
    mission/              ligne, détail, panneau de création
    decision/             panneau unique de confirmation et de refus
    automation/ project/ today/ data/   lignes spécialisées
  fixtures/               données de démonstration, séparées de l'interface
  lib/                    permissions, sélecteurs purs, format, état du cockpit
  types/domain.ts         types métier
tests/                    Vitest, sur les modules purs uniquement
e2e/                      Playwright, sur les parcours critiques
```

Tout ce que la démonstration fait bouger passe par un réducteur pur,
[`src/lib/cockpit-state.ts`](src/lib/cockpit-state.ts) : conséquence d'un refus, limites
d'une prolongation, mission créée, commandes de tâches. `src/lib/cockpit.tsx` ne fait plus
que dispatcher — les règles se vérifient donc sans monter un seul composant.

`src/fixtures/index.ts` est le seul point d'entrée des données. Les composants ne lisent
jamais un fichier de fixtures directement : ils passent par les sélecteurs de
`src/lib/selectors.ts`, qui sont des fonctions pures recevant le jeu de données et le rôle
connecté. Brancher de vraies sources reviendrait à remplacer ce module, sans toucher aux
composants.

Les jetons visuels — couleurs, typographies, rayons, animations — sont déclarés dans le
bloc `@theme` de [`src/app/globals.css`](src/app/globals.css).

---

## Direction visuelle

Le détail se trouve dans [`docs/design/indy-ui-direction.md`](docs/design/indy-ui-direction.md) :
palette et contrastes mesurés, typographies et licences, concept de layout, signature
visuelle, ce qui a été conservé de l'ancienne interface et ce qui a été corrigé.

Captures desktop et mobile : [`docs/design/screenshots/`](docs/design/screenshots/).

Trois familles, toutes sous SIL Open Font License 1.1, récupérées et auto-hébergées au
build par `next/font/google` : **Fraunces** pour les titres, **Hanken Grotesk** pour
l'interface, **JetBrains Mono** pour les statuts, durées et tentatives.

---

## Accessibilité

- Toute action est atteignable au clavier, dans l'ordre visuel.
- Un style de focus unique, visible sur tous les fonds.
- Lien d'évitement vers le contenu en première tabulation.
- Contrastes vérifiés : tout le texte passe AA, tout sauf le gris secondaire passe AAA.
- La couleur n'est jamais seule : chaque état a une forme de pastille et un libellé écrit.
- `prefers-reduced-motion` respecté, y compris par le Pouls.
- Responsive desktop, tablette et mobile, avec une navigation mobile pensée pour le pouce.

Les états **vide**, **chargement** et **erreur** sont dessinés pour chaque écran et se
déclenchent depuis Réglages › Démonstration.

---

## Limites

- Les actions modifient l'écran pour la durée de la session ; elles ne déclenchent rien à
  l'extérieur et ne survivent pas à un rechargement. Les quatre commandes de tâches ne
  partent pas vers Hermes : elles sont simulées dans l'état React.
- Avec les trois rôles de démonstration, une tâche visible est toujours actionnable : les
  explications écrites de refus existent et sont couvertes par les tests, mais elles ne se
  déclenchent sur aucun écran de la démonstration.
- Les autorisations sont vérifiées dans le navigateur, jusque dans le réducteur. C'est une
  démonstration, pas une garantie : Hermes et les connecteurs devront refaire ces contrôles
  côté serveur avant toute mutation réelle.
- `pnpm test` ne monte aucun composant : il n'y a pas de test de rendu unitaire. Le
  comportement à l'écran est couvert par `pnpm test:e2e`, sur les parcours critiques
  seulement — pas sur l'ensemble des écrans.
- Les données sont figées sur une journée de démonstration, le mardi 1er septembre 2026 à
  14 h 20. Les durées relatives sont calculées à partir de cet instant, ce qui garantit un
  rendu identique sur le serveur et dans le navigateur.
- Aucun identifiant réel n'est stocké ni affiché.
