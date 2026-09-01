# Captures

Prises sur le build de production (`pnpm build` puis `pnpm start`), avec les données de
démonstration et le mouvement réduit.
Desktop : 1440 × 900. Mobile : 390 × 844. Petit mobile : 390 × 667.

Seules les captures des écrans modifiés ont été régénérées lors de la dernière passe ;
les autres datent de la passe précédente et restent exactes.

## Desktop — 1440 × 900

| Fichier | Ce qu'elle montre |
|---|---|
| `desktop-01-aujourdhui.png` | Aujourd'hui, rôle propriétaire : à traiter (dont les deux remontées d'échéance), en cours, tâches avec leurs commandes, terminé |
| `desktop-02-missions.png` | Missions : recherche, filtres, trois regroupements |
| `desktop-03-mission-vue-ensemble.png` | Détail d'une mission, onglet Vue d'ensemble, décision en attente avec « Examiner et approuver » / « Examiner et refuser » |
| `desktop-04-mission-diagnostic.png` | Onglet Diagnostic : tout le détail technique, et lui seul |
| `desktop-05-decision-sensible.png` | Panneau de confirmation, déploiement en production |
| `desktop-06-nouvelle-mission.png` | Panneau de création : agents en parallèle, échéance facultative, résumé « Avant de lancer » |
| `desktop-07-automatisations.png` | Automatisations, une récurrence dépliée |
| `desktop-08-projets.png` | Liste des projets, techniques et commerciaux |
| `desktop-09-projet-technique.png` | Projet technique (Tao), avec l'état écrit des tâches |
| `desktop-10-projet-commercial.png` | Projet client commercial (Vernay Immobilier) |
| `desktop-11-livrables.png` | Livrables groupés par jour |
| `desktop-12-historique.png` | Historique : missions closes, décisions, exécutions notables |
| `desktop-13-reglages-permissions.png` | Réglages : permissions (dont les tâches), sources, forfait Codex, identité visuelle, limites |
| `desktop-14-etat-chargement.png` | État de chargement |
| `desktop-15-etat-vide.png` | États vides, avec la capture de tâche toujours proposée |
| `desktop-16-etat-erreur.png` | État d'erreur |
| `desktop-17-selecteur-role.png` | Sélecteur de rôle, marqué « démonstration » |
| `desktop-18-role-lyes.png` | Aujourd'hui vu par Lyes, développeur : ni tâches personnelles, ni DocAgora |
| `desktop-19-role-lucas.png` | Aujourd'hui vu par Lucas, business developer |
| `desktop-20-permission-refusee.png` | Décision hors permissions : expliquée, pas seulement désactivée |
| `desktop-21-refus-decision.png` | **Refus** d'un déploiement : le panneau sensible commun, sans mot à saisir, avec la conséquence exacte |
| `desktop-22-tache-capture.png` | Capture d'une tâche : titre, projet ou « Personnel », responsable, échéance, note, et la commande qui part |
| `desktop-23-tache-tri.png` | Tri d'une tâche existante (`todo.triage`) |
| `desktop-24-mission-creee.png` | Mission créée : échéance et agents en parallèle repris dans les garde-fous |
| `desktop-25-tache-commandes.png` | Menu de commandes d'une tâche : terminer, trier, annuler |
| `desktop-26-tache-capturee.png` | Après capture : la tâche est en liste, le journal nomme `todo.capture` |
| `desktop-27-mission-apres-refus.png` | Après refus : la mission est **en attente**, pas annulée, et garde ses étapes |
| `desktop-28-taches-lyes.png` | Commandes de tâches dans le périmètre de Lyes |
| `desktop-29-taches-lucas.png` | Commandes de tâches dans le périmètre de Lucas |

## Mobile — 390 × 844

| Fichier | Ce qu'elle montre |
|---|---|
| `mobile-01-aujourdhui.png` | Aujourd'hui, barre de navigation basse |
| `mobile-02-missions.png` | Missions : filtres empilés, lignes sur deux niveaux |
| `mobile-03-mission-detail.png` | Détail d'une mission |
| `mobile-04-navigation-plus.png` | Feuille « Plus » : écrans secondaires et Pouls déplié |
| `mobile-05-selecteur-role.png` | Sélecteur de rôle |
| `mobile-06-decision-sensible.png` | Panneau de confirmation en feuille basse |
| `mobile-07-taches-commandes.png` | Menu de commandes d'une tâche, au-dessus de la barre du bas |
| `mobile-08-capture-tache.png` | Feuille de capture, action principale atteignable au pouce |
| `mobile-09-refus-decision.png` | Refus d'une décision en feuille basse |
| `mobile-10-nouvelle-mission.png` | Nouvelle mission : parallélisme et échéance en feuille basse |

## Petit mobile — 390 × 667

| Fichier | Ce qu'elle montre |
|---|---|
| `mobile-petit-01-aujourdhui.png` | Aujourd'hui sur un écran court |
| `mobile-petit-03-mission-detail.png` | Détail d'une mission |
| `mobile-petit-05-selecteur-role.png` | Sélecteur de rôle |
| `mobile-petit-07-taches-commandes.png` | Menu de commandes d'une tâche |
| `mobile-petit-08-capture-tache.png` | Feuille de capture |
| `mobile-petit-09-refus-decision.png` | Refus d'une décision |
| `mobile-petit-10-nouvelle-mission.png` | Nouvelle mission |

## Ce qui a été vérifié pendant la prise

Sur les deux tailles mobiles, et pour chaque écran modifié :

- la barre de navigation basse ne recouvre aucune action — chaque bouton amené à
  l'écran reçoit bien le clic en son propre centre ;
- le corps des feuilles reste scrollable, et leur action principale
  (« Capturer », « Lancer la mission », « Refuser ») reste visible sans défilement ;
- le menu de commandes d'une tâche tient entièrement dans la fenêtre ;
- Lyes et Lucas ne voient ni tâche personnelle, ni projet DocAgora ;
- refuser un déploiement laisse la mission « en attente », jamais « annulée ».
