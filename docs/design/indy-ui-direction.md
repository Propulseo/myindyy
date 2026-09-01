# Indy — direction visuelle v1

Prototype frontend, données fictives, aucun backend.
Branche : `design/indy-cockpit-v1`.

---

## 1. Lecture de l'interface existante

Captures analysées : `status`, `chat`, `crons`, `logs`, `analytics`, `skills`, `config`
(ancien cockpit Hermes : rail d'icônes + panneau chat + barre supérieure).

### Ce qui fonctionne et que l'on garde

| Élément | Raison |
|---|---|
| Fond quasi noir, contraste doux | Atmosphère calme, outil que l'on garde ouvert toute la journée |
| Trio serif / sans / mono | Donne un caractère éditorial, très rare sur un outil interne |
| Bleu pervenche en accent unique | Signature reconnaissable, jamais utilisé pour décorer |
| Bordures d'un pixel, pas d'ombres | Sensation d'instrument, pas de carte flottante |
| Micro-libellés mono en capitales | Excellente hiérarchie secondaire |
| Monogramme « I. » avec le point bleu | Marque minimale, déjà juste |

### Ce qui est corrigé

| Défaut constaté | Correction appliquée |
|---|---|
| Le chat est un onglet principal et occupe la moitié de l'écran | Le chat disparaît de la navigation. Donner une instruction devient une action **dans** une mission |
| Trois niveaux de navigation (rail + panneau + barre) | Deux niveaux maximum : navigation latérale, puis contenu. Les filtres vivent dans la page |
| Actions rapides dupliquées (panneau chat + page crons) | Un seul point d'entrée : « Nouvelle mission », disponible partout, avec des modèles |
| Historique de crons bruyant : grille de cartes, métadonnées répétées, quatre boutons par carte | Les récurrences deviennent des **automatisations** : une ligne, un état de santé, un historique replié |
| Grandes zones vides (page Status : 60 % de vide) | Colonne de contenu de largeur mesurée, densité typographique, pas d'étirement forcé |
| Libellés techniques : « sessions Hermes », `#job_a1c2`, `chat_id`, « Défaut Hermes » | Vocabulaire métier. Les identifiants techniques ne vivent que dans l'onglet **Diagnostic** |
| Abus de cartes : cartes dans des cartes | La **ligne** devient l'unité de base. La carte est réservée aux panneaux de décision |

---

## 2. Concept

> **Indy n'est pas un tableau de bord. C'est une table de contrôle.**

Trois principes tenus sur tous les écrans :

1. **La ligne avant la carte.** Une mission, une automatisation, un livrable, une tâche : une
   ligne dense, un rail de statut coloré à gauche, deux niveaux de texte. On lit une liste de
   quinze éléments d'un coup d'œil, ce qu'une grille de cartes interdit.
2. **La provenance est visible, jamais bruyante.** Chaque donnée porte sa source (Obsidian, ERP,
   CRM, Hermes, GitHub, Coolify) en monospace discret, avec sa date de dernière synchronisation.
   Indy agrège, il n'invente pas.
3. **Le silence est un état valide.** Une automatisation saine ne remonte pas. Une journée sans
   incident affiche une page courte. L'interface ne se remplit pas pour paraître occupée.

---

## 3. Palette

| Jeton | Valeur | Emploi |
|---|---|---|
| `obsidian` | `#0B0C10` | Fond de l'application |
| `surface` | `#13151B` | Panneaux, en-têtes de section, barre latérale |
| `raised` | `#1A1D25` | Survol de ligne, champ actif, panneau de décision |
| `line` | `#262A34` | Filet d'un pixel, séparateurs |
| `line-strong` | `#333846` | Bordure de contrôle, contour de bouton |
| `ivory` | `#EEEAE2` | Texte principal |
| `muted` | `#858B9C` | Texte secondaire, métadonnées |
| `indy` | `#7895F8` | Accent unique : sélection, action primaire, mission en cours |
| `indy-deep` | `#2C3A6D` | Fond d'accent très sourd |

### Couleurs d'état

| État | Jeton | Valeur | Sens |
|---|---|---|---|
| Succès | `ok` | `#5FD39B` | Terminé, sain, dans le budget |
| Attention | `attention` | `#E8B45F` | Attend une validation, dépasse sa durée ou son budget |
| Échec | `danger` | `#F4796B` | Bloqué, échoué |
| Attente | `waiting` | `#B49BF0` | En file, planifié, pas encore démarré |

Ratios de contraste mesurés (WCAG 2.1, texte sur fond) :

| | sur `obsidian` | sur `surface` | sur `raised` |
|---|---|---|---|
| `ivory` | 16,29 | 15,21 | 14,04 |
| `muted` | 5,74 | 5,36 | 4,95 |
| `indy` | 6,94 | 6,48 | 5,98 |
| `ok` | 10,50 | 9,80 | 9,05 |
| `attention` | 10,36 | 9,67 | 8,93 |
| `danger` | 7,25 | 6,77 | 6,25 |
| `waiting` | 8,27 | 7,72 | 7,13 |

Tout passe AA pour du texte normal ; tout sauf `muted` passe AAA.
**La couleur n'est jamais le seul porteur d'information** : chaque état a aussi une forme de
pastille distincte (pleine, anneau, barrée, losange, croix) et un libellé écrit.

---

## 4. Typographie

| Rôle | Famille | Licence | Emploi |
|---|---|---|---|
| Serif expressive | **Fraunces** (variable) | SIL Open Font License 1.1 | Titres de page, titres de mission, chiffre de tête. Jamais sous 18 px |
| Sans-serif d'interface | **Hanken Grotesk** | SIL Open Font License 1.1 | Tout le corps de texte, libellés, boutons |
| Monospace | **JetBrains Mono** | SIL Open Font License 1.1 | Statuts, durées, budgets, horodatages, sources, références |

Les trois sont récupérées et auto-hébergées au moment du build par `next/font/google` :
aucun appel réseau à l'exécution, aucune dépendance à Google Fonts en production.

Règle de partage : **la serif nomme, la sans explique, la mono mesure.** Un nombre susceptible de
changer en direct (durée, coût, compteur) est toujours en monospace, pour éviter le tremblement
de la ligne quand la valeur se met à jour.

---

## 5. Layout

```
+------------+----------------------------------------------------------+
|            |  barre superieure : titre . POULS INDY . role (demo)     |
|  I.        +----------------------------------------------------------+
|            |                                                          |
| Aujourd'hui|   colonne de contenu, largeur maximale 1180 px           |
| Missions   |                                                          |
| Automat.   |   -- section ------------------------------------- 4 --  |
| Projets    |   | ligne                                                |
| Livrables  |   | ligne                                                |
| Historique |   | ligne                                                |
| Reglages   |                                                          |
|            |                                                          |
| + Nouvelle |                                                          |
+------------+----------------------------------------------------------+
```

- **≥ 1280 px** : barre latérale de 232 px, libellés écrits.
- **768 – 1279 px** : rail de 68 px, icône + libellé mono minuscule.
- **< 768 px** : barre latérale masquée, **barre de navigation basse** à cinq entrées
  (Aujourd'hui, Missions, Projets, Livrables, Plus) ; « Plus » ouvre une feuille contenant
  Automatisations, Historique, Réglages, le sélecteur de rôle et le Pouls déplié.
  Ce n'est pas la version desktop rétrécie : les lignes passent sur deux niveaux, les
  métadonnées secondaires sont réduites à l'essentiel, les actions passent dans une feuille
  glissée depuis le bas, atteignable au pouce.

---

## 6. Signature visuelle — le Pouls Indy

Une bande de 200 × 26 px au centre de la barre supérieure. Ce n'est pas une courbe décorative :
c'est **une bande de temps réelle**, les douze dernières heures, bord droit = maintenant.

Composition :

- une ligne de base d'un pixel et une trame verticale très sourde, une graduation par heure ;
- **traits bleus** montants : missions actives, hauteur proportionnelle à leur avancement ;
- **losanges ambre** : décisions en attente, posés sur la ligne de base ;
- **encoches rouges** traversant toute la bande : incidents et blocages ;
- un point à l'extrême droite, qui respire lentement, marque l'instant présent ;
- une lueur bleue balaie la bande de gauche à droite toutes les 7 s.

À droite de la bande, un relevé monospace : `3 actives · 2 décisions · 1 incident`.
Sous 1024 px le relevé se réduit à `3 · 2 · 1`, avec un libellé accessible complet.

L'ensemble est un `<button>` : il ouvre un panneau qui détaille les trois compteurs et renvoie
vers la vue filtrée correspondante. Navigable au clavier, annoncé par un `aria-label` phrasé.

Mouvement : la trame dérive sur 26 s, la lueur balaie sur 7 s, le point présent respire sur 3 s.
Sous `prefers-reduced-motion: reduce`, les trois durées passent à zéro et la bande devient
strictement statique — elle reste parfaitement lisible, car toute l'information est portée par la
position et la forme des marques, jamais par l'animation.

**C'est le seul endroit où l'on dépense de l'originalité.** Partout ailleurs : filets, texte, silence.

---

## 7. Ce qui rend l'écran non générique

Vérification menée contre les réflexes habituels d'un tableau de bord :

| Réflexe évité | À la place |
|---|---|
| Bandeau de quatre grosses tuiles de KPI | Une phrase de tête en serif, puis des lignes |
| Graphiques de tendance décoratifs | Une seule visualisation dans toute l'application : le Pouls |
| Pastilles de statut multicolores partout | Quatre couleurs d'état, une forme distincte par état |
| Coins très arrondis et ombres portées | Rayons de 3 à 12 px, aucune ombre, filets d'un pixel |
| Barre latérale à sections repliables | Sept entrées, plates, sans accordéon |
| Illustration d'état vide | Une phrase en serif et une action |
| Boutons pleins partout | Un seul bouton plein par écran au maximum |
| Le mot « IA » ou « agent » en titre | Le vocabulaire du produit : mission, étape, décision, livrable |

---

## 8. Accessibilité et états

- Toute action est atteignable au clavier ; ordre de tabulation suivant l'ordre visuel.
- Un style de focus unique : anneau `indy` de 2 px, décalé de 2 px.
- Lien d'évitement vers le contenu principal en première tabulation.
- Modales et panneaux Radix : piège de focus, `Échap`, restitution du focus à l'ouvrant.
- Les listes annoncent leur nombre d'éléments ; les changements d'état passent par `aria-live`.
- États **vide**, **chargement** et **erreur** dessinés pour chaque écran, et déclenchables
  depuis Réglages › Démonstration pour pouvoir être présentés.
