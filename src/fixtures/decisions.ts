import type { Decision } from "@/types/domain";
import { daysAgo, hoursAgo, minutesAgo } from "./clock";

/**
 * Chaque décision porte tout ce qu'il faut pour décider sans ouvrir un autre écran :
 * l'action, la cible exacte, l'environnement, la révision ou le contenu, la conséquence.
 */
export const decisions: Decision[] = [
  {
    id: "dec-01",
    missionId: "m-248",
    projectId: "coproflex",
    kind: "deploiement_production",
    title: "Déployer la landing CoProFlex en production",
    target: "coproflex.fr",
    environment: "Production",
    revision: "coproflex-web · a41f9c2 · « Landing de lancement, six sections »",
    consequence:
      "La page publique actuelle est remplacée immédiatement. Le retour arrière prend environ trois minutes.",
    requestedAt: minutesAgo(12),
    requiredCapability: "deploy.production",
    state: "en_attente",
    source: {
      system: "coolify",
      reference: "Coolify · service coproflex-web",
      syncedAt: minutesAgo(12),
    },
  },
  {
    id: "dec-02",
    missionId: "m-249",
    projectId: "vernay",
    kind: "communication_externe",
    title: "Envoyer la séquence de relance aux prospects Vernay",
    target: "34 contacts · segment « salon 2026 »",
    environment: "Messagerie sortante",
    revision:
      "Message 1 sur 3 · « Bonjour {prénom}, nous nous sommes croisés au salon de juin… » · envoi immédiat, les deux suivants à J+4 et J+11",
    consequence:
      "Trente-quatre courriels partent immédiatement. Un envoi ne se rappelle pas.",
    requestedAt: minutesAgo(41),
    requiredCapability: "comms.external.send",
    state: "en_attente",
    source: {
      system: "crm",
      reference: "CRM · séquence 118",
      syncedAt: minutesAgo(41),
    },
  },
  {
    id: "dec-03",
    missionId: "m-241",
    projectId: "propulseo",
    kind: "publication",
    title: "Publier l'article « Copropriété et automatisation »",
    target: "propulseo-site.com/blog/copropriete-et-automatisation",
    environment: "Blog public",
    revision:
      "1 412 mots · six intertitres · « L'automatisation ne remplace pas le syndic, elle lui rend ses heures… »",
    consequence:
      "L'article devient public et entre dans le fil de publication. Il reste dépubliable.",
    requestedAt: hoursAgo(5),
    requiredCapability: "comms.external.send",
    state: "en_attente",
    source: {
      system: "obsidian",
      reference: "Obsidian · contenus/copropriete-automatisation",
      syncedAt: hoursAgo(5),
    },
  },
  {
    id: "dec-04",
    missionId: "m-251",
    projectId: "vernay",
    kind: "prolongation",
    title: "Prolonger la recherche concurrents d'une heure",
    target: "Mission M-251 · durée portée de 4 h à 5 h, une tentative de plus",
    environment: "Garde-fous de la mission",
    revision:
      "226 minutes écoulées sur 240. Tentative 2 sur 3. Il reste trois acteurs à comparer et la synthèse à rédiger.",
    consequence:
      "La mission repart jusqu'à la nouvelle limite. Sans prolongation, elle s'arrête d'elle-même à 4 h et rend les onze comparaisons déjà faites, sans synthèse.",
    requestedAt: minutesAgo(9),
    requiredCapability: "limits.override",
    state: "en_attente",
    source: {
      system: "hermes",
      reference: "Hermes · mission 251",
      syncedAt: minutesAgo(9),
    },
  },
  {
    id: "dec-05",
    missionId: "m-237",
    projectId: "coproflex",
    kind: "deploiement_production",
    title: "Déployer le correctif d'export PDF en production",
    target: "api.coproflex.fr",
    environment: "Production",
    revision: "coproflex-api · 3b90c17 · « Pagination des appels de charges »",
    consequence:
      "Le service est redéployé sans interruption. Le retour arrière prend environ trois minutes.",
    requestedAt: daysAgo(2),
    requiredCapability: "deploy.production",
    state: "approuvee",
    resolvedAt: daysAgo(2),
    resolvedById: "etienne",
    source: {
      system: "coolify",
      reference: "Coolify · service coproflex-api",
      syncedAt: daysAgo(2),
    },
  },
];

export const decisionsById: Record<string, Decision> = Object.fromEntries(
  decisions.map((decision) => [decision.id, decision]),
);
