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
| Succès | `ok` | `#5FD39B` | Terminé, sain, dans ses limites |
| Attention | `attention` | `#E8B45F` | Attend une validation, approche sa durée ou sa dernière tentative |
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
| Monospace | **JetBrains Mono** | SIL Open Font License 1.1 | Statuts, durées, tentatives, horodatages, sources, références |

Les trois sont récupérées et auto-hébergées au moment du build par `next/font/google` :
aucun appel réseau à l'exécution, aucune dépendance à Google Fonts en production.

Règle de partage : **la serif nomme, la sans explique, la mono mesure.** Un nombre susceptible de
changer en direct (durée, tentative, compteur) est toujours en monospace, pour éviter le tremblement
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
- **768 – 1279 px** : rail de 68 px, icône seule ; le libellé reste lisible par les
  lecteurs d'écran et apparaît en infobulle native au survol.
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
- Chaque état de tâche — à faire, en cours, faite, annulée — est écrit à côté de sa pastille.
  Une tâche annulée reste listée, barrée et nommée : rien ne disparaît en silence.
- Les commandes d'une tâche vivent dans un menu déclenché par un bouton nommé. Hors du
  périmètre du rôle, le menu affiche l'explication écrite au lieu de disparaître.
- États **vide**, **chargement** et **erreur** dessinés pour chaque écran, et déclenchables
  depuis Réglages › Démonstration pour pouvoir être présentés.

---

## 9. Garde-fous opérationnels, aucun budget financier

Codex tourne derrière Indy sur l'abonnement ChatGPT de l'utilisateur. Le cockpit n'a
donc **aucun coût à afficher** : pas de prix par mission, pas de prix par jeton, pas de
plafond en euros. **Aucun budget financier n'existe dans le modèle métier ni dans
l'interface.** Dans ce document, le mot « budget » ne subsiste que dans cette section,
pour dire ce qui a été retiré et par quoi il a été remplacé.

Ce qui encadre une mission est opérationnel :

| Garde-fou | Où il se voit |
|---|---|
| Durée maximale | Jauge sur la mission, formulaire de création. Les listes montrent la durée écoulée |
| Nombre maximal de tentatives | Jauge sur la mission, colonne de droite des listes, formulaire de création |
| Agents en parallèle | Choisi à la création, de 1 à 4, un par défaut. Panneau de garde-fous de la mission : actifs sur total, maximum autorisé |
| Échéance | Facultative, choisie à la création avec sa date et son heure. En-tête de la mission, et remontée sur « Aujourd'hui » quand elle approche ou passe |
| Niveau d'effort | En-tête de la mission, formulaire de création |
| Dernière activité | Colonne de droite des listes, panneau de garde-fous |
| Blocage et inactivité | Statut `bloquée`, et remontée automatique au-delà de 45 min sans le moindre évènement |

Quatre conséquences sur la logique :

1. La décision sensible « dépassement de budget » devient une **prolongation** :
   repousser la durée ou accorder une tentative de plus. Elle reste réservée au
   propriétaire.
2. Une mission qui ne donne plus signe de vie n'est plus comptée comme *active* dans le
   Pouls : elle bascule dans les incidents. La compter ailleurs rendrait la bande
   rassurante à tort.
3. Sur un projet, l'ancienne mesure de consommation devient **activité des agents** :
   nombre de missions, taux de réussite, durée médiane, interventions humaines, missions
   bloquées. Tout est recalculé à partir des missions affichées, jamais stocké — les
   chiffres ne peuvent donc pas contredire la liste juste à côté.
4. Une échéance dépassée est un **incident** : ligne écrite, ton danger, sur
   « Aujourd'hui ». À moins d'une heure, elle passe en **attention**. Une mission déjà
   remontée pour plus pressant — décision, blocage, échec — ne produit pas de seconde
   ligne : son échéance est rappelée dans le complément de la première.

---

## 10. Confirmer et refuser

Le panneau sensible est unique et sert dans les deux sens. Confirmer une action et la
refuser affichent exactement les mêmes lignes — action, cible, projet, environnement,
révision ou contenu, personne qui confirme, conséquence — parce que refuser est une
décision, pas un renoncement.

| | Confirmer | Refuser |
|---|---|---|
| Bandeau | famille de la décision, dans son ton | même famille, suivie de « · refus », en ton attention |
| Mot à saisir | pour un déploiement en production | **jamais** : un refus n'écrit rien à l'extérieur |
| Bouton | plein, ou rouge si l'action est destructrice | rouge, libellé « Refuser » |

Ce qu'un refus entraîne est écrit avant de cliquer, et journalisé ensuite :

| Décision refusée | Décision | Mission |
|---|---|---|
| Déploiement, publication, communication externe | `refusée` | `en attente`, étapes et livrables conservés, attend une nouvelle instruction |
| Prolongation | `refusée` | continue avec ses limites actuelles, puis rend la main à la limite |

**Refuser n'annule jamais une mission.** L'annulation complète est une action séparée,
déclenchée depuis l'en-tête de la mission, avec son propre panneau et sa propre
conséquence. La règle qui transformait tout refus hors prolongation en `annulée` a été
retirée.

Les mêmes permissions gouvernent les deux sens : c'est le rôle qui a la charge de la
décision, dans un projet qui lui est visible, qui répond — qu'il approuve ou qu'il refuse.

---

## 11. Les tâches Obsidian, et qui écrit dans le coffre

Obsidian est la source de vérité des tâches. Indy ne prétend jamais y écrire : il compose
une commande et la transmet à Hermes, qui l'applique. Le vocabulaire de l'interface le dit
— « Commande Hermes » en tête du menu, le nom de la commande sous chaque entrée, et la
provenance d'une tâche modifiée devient `Hermes · todo.… → Obsidian · …`.

| Commande | Geste | Conséquence écrite |
|---|---|---|
| `todo.capture` | « Capturer une tâche » | Crée la tâche dans le coffre |
| `todo.triage` | « Trier ou modifier » | Met à jour projet, responsable, échéance, note |
| `todo.complete` | « Terminer » | Coche la tâche |
| `todo.cancel` | « Annuler la tâche » | Marque la tâche annulée **sans la supprimer** : elle reste affichée dans la journée, en fin de liste, avec le statut écrit « Annulée ». Passe par le panneau sensible |

Périmètre :

- Étienne gère ses tâches personnelles et toutes les tâches partagées ;
- Lyes et Lucas ne voient jamais une tâche personnelle, et ne peuvent ni en créer une, ni
  transformer une tâche partagée en tâche personnelle ;
- Lyes et Lucas gèrent les tâches partagées de leurs seuls projets affectés ;
- le responsable choisi doit être membre du projet visé ;
- un projet non affecté n'apparaît ni dans les listes, ni dans le champ « Projet ».

Cette règle est écrite une seule fois, dans `authorizeTaskCommand`. L'interface s'en sert
pour décider ce qu'elle propose et ce qu'elle explique ; le réducteur s'en sert pour
refuser une commande qui arriverait malgré tout, sans rien modifier et sans rien dire de
ce qu'il protège.

**Contrôle d'interface, pas autorisation.** Tout cela vit dans le navigateur. Hermes et
les connecteurs devront refaire ces autorisations côté serveur avant toute mutation réelle
du coffre Obsidian.

Dans ce prototype, les quatre commandes sont simulées dans l'état React de la session :
rien ne part, rien n'est écrit, rien ne survit à un rechargement.

---

## 12. Où vivent les règles

Toutes les mutations passent par un réducteur pur, `src/lib/cockpit-state.ts` : conséquence
d'un refus, limites d'une prolongation, mission créée, commandes de tâches. Le fournisseur
React ne fait que dispatcher. Trois effets : la règle se lit à un seul endroit, elle se
vérifie sans monter un composant, et une commande hors périmètre est refusée là même où
elle serait appliquée.

Deux niveaux de vérification, et ils ne se recouvrent pas :

- `pnpm test` (Vitest) porte sur les modules purs — réducteur, permissions, sélecteurs.
  Aucun composant n'est monté.
- `pnpm test:e2e` (Playwright) rejoue les parcours critiques sur le build de production, en
  1440 × 900 et en 390 × 667, en visant des rôles, des libellés et des états accessibles :
  ni coordonnée fixe, ni attente arbitraire.

---

### Utilisation du forfait

Une consommation globale du forfait Codex ne s'affiche **que** si Hermes ou Codex la
fournit. Aucune estimation n'est fabriquée. Tant que la source ne l'expose pas, Réglages
affiche un emplacement explicitement vide qui dit pourquoi. Le jour où la donnée existe,
il suffit de la renseigner dans `src/fixtures/plan.ts` : l'écran bascule seul.

