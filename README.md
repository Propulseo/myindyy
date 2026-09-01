# Indy — cockpit multi-agents Propul'SEO

Prototype frontend navigable du cockpit interne Propul'SEO. Il sert à valider l'identité
visuelle, la navigation, la hiérarchie de l'information, les principaux écrans, les
interactions et l'expérience selon le rôle connecté.

**Ce prototype ne se connecte à rien.** Aucun backend, aucune base de données, aucune
variable d'environnement, aucun appel réseau vers Hermes, Obsidian, GitHub, l'ERP, le CRM,
Supabase, Coolify ou le VPS. Toutes les données sont fictives et vivent dans
[`src/fixtures/`](src/fixtures/).

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
pnpm build        # build de production
pnpm start        # sert le build de production
```

Prérequis : Node 20.9 ou plus récent, pnpm 10 ou plus récent.

---

## Ce que contient le prototype

| Écran | Route | Rôle |
|---|---|---|
| Aujourd'hui | `/` | À traiter, en cours, tâches Obsidian du jour, terminé récemment |
| Missions | `/missions` | Recherche, quatre filtres, trois regroupements |
| Détail d'une mission | `/missions/[id]` | Vue d'ensemble, Activité, Livrables, Diagnostic |
| Automatisations | `/automatisations` | Une ligne par récurrence, historique replié |
| Projets | `/projets`, `/projets/[id]` | Membres, missions, tâches, livrables, budget, sources |
| Livrables | `/livrables` | Ce que les missions ont produit, groupé par jour |
| Historique | `/historique` | Missions closes, décisions prises, exécutions notables |
| Réglages | `/reglages` | Matrice des permissions, sources, identité visuelle, états |

La création d'une mission est un panneau, accessible partout depuis « Nouvelle mission »
ou la touche `N`.

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
| Autoriser un dépassement de budget | oui | non | non |
| Voir les identifiants des sources | oui | non | non |
| Voir les tâches personnelles | oui | non | non |

Un projet non affecté n'apparaît nulle part : ni dans les listes, ni dans les filtres, ni
en grisé. DocAgora n'est affecté qu'à Étienne : c'est le témoin de ce comportement.

Toute action sensible — déploiement en production, publication, communication externe,
annulation d'une mission, dépassement de budget — passe par un panneau unique qui affiche
l'action, la cible, le projet, l'environnement, la révision ou le contenu, la personne qui
confirme et la conséquence.

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
    decision/             panneau de confirmation réutilisable
    automation/ project/ today/ data/   lignes spécialisées
  fixtures/               données de démonstration, séparées de l'interface
  lib/                    permissions, sélecteurs purs, format, état du cockpit
  types/domain.ts         types métier
```

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
l'interface, **JetBrains Mono** pour les statuts, durées et budgets.

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
  l'extérieur et ne survivent pas à un rechargement.
- Les données sont figées sur une journée de démonstration, le mardi 1er septembre 2026 à
  14 h 20. Les durées relatives sont calculées à partir de cet instant, ce qui garantit un
  rendu identique sur le serveur et dans le navigateur.
- Aucun identifiant réel n'est stocké ni affiché.
