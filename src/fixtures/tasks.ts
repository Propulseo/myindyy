import type { MissionTemplate, ObsidianTask } from "@/types/domain";
import { hoursAgo, inHours, minutesAgo } from "./clock";

/**
 * Tâches Obsidian du jour.
 *
 * `visibility: "personnelle"` = tâche privée d'Étienne. Elle n'apparaît que pour les
 * rôles qui possèdent la permission `tasks.personal.view`, c'est-à-dire lui seul.
 */
export const obsidianTasks: ObsidianTask[] = [
  {
    id: "t-01",
    title: "Trancher la contrainte d'unicité des factures Tao",
    projectId: "tao",
    visibility: "partagee",
    ownerId: "lyes",
    state: "a_faire",
    dueAt: inHours(3),
    note: "Bloque la migration M-244.",
    source: { system: "obsidian", reference: "Obsidian · tâches/T-4192", syncedAt: minutesAgo(24) },
  },
  {
    id: "t-02",
    title: "Relire les textes de la landing CoProFlex avant mise en ligne",
    projectId: "coproflex",
    visibility: "partagee",
    ownerId: "lyes",
    state: "en_cours",
    dueAt: inHours(1),
    source: { system: "obsidian", reference: "Obsidian · tâches/T-4188", syncedAt: minutesAgo(24) },
  },
  {
    id: "t-03",
    title: "Rappeler les quatre demandes prioritaires Vernay",
    projectId: "vernay",
    visibility: "partagee",
    ownerId: "lucas",
    state: "a_faire",
    dueAt: inHours(4),
    note: "Deux contacts ont déclaré un budget.",
    source: { system: "obsidian", reference: "Obsidian · tâches/T-4201", syncedAt: minutesAgo(24) },
  },
  {
    id: "t-04",
    title: "Préparer la trame du point hebdomadaire",
    projectId: "propulseo",
    visibility: "partagee",
    ownerId: "etienne",
    state: "a_faire",
    dueAt: inHours(6),
    source: { system: "obsidian", reference: "Obsidian · tâches/T-4177", syncedAt: minutesAgo(24) },
  },
  {
    id: "t-05",
    title: "Valider le cadrage DocAgora avant génération des fiches",
    projectId: "docagora",
    visibility: "partagee",
    ownerId: "etienne",
    state: "a_faire",
    dueAt: inHours(8),
    source: { system: "obsidian", reference: "Obsidian · tâches/T-4205", syncedAt: hoursAgo(3) },
  },
  {
    id: "t-06",
    title: "Écrire le compte rendu du salon de juin",
    projectId: "vernay",
    visibility: "partagee",
    ownerId: "lucas",
    state: "fait",
    dueAt: hoursAgo(2),
    source: { system: "obsidian", reference: "Obsidian · tâches/T-4166", syncedAt: minutesAgo(24) },
  },
  {
    id: "t-07",
    title: "Rendez-vous comptable à 17 h",
    visibility: "personnelle",
    ownerId: "etienne",
    state: "a_faire",
    dueAt: inHours(3),
    source: { system: "obsidian", reference: "Obsidian · personnel/agenda", syncedAt: minutesAgo(24) },
  },
  {
    id: "t-08",
    title: "Renouveler l'assurance professionnelle",
    visibility: "personnelle",
    ownerId: "etienne",
    state: "a_faire",
    dueAt: inHours(9),
    note: "Échéance le 5 septembre.",
    source: { system: "obsidian", reference: "Obsidian · personnel/administratif", syncedAt: minutesAgo(24) },
  },
  {
    id: "t-09",
    title: "Répondre à la proposition de partenariat reçue lundi",
    visibility: "personnelle",
    ownerId: "etienne",
    state: "en_cours",
    dueAt: inHours(5),
    source: { system: "obsidian", reference: "Obsidian · personnel/inbox", syncedAt: minutesAgo(24) },
  },
];

/** Modèles proposés au lancement d'une mission. */
export const missionTemplates: MissionTemplate[] = [
  {
    id: "tpl-briefing",
    name: "Briefing du jour",
    objective:
      "Rassembler les décisions en attente, les missions à surveiller et les rendez-vous de la journée.",
    usedFor: "Chaque matin, avant de commencer",
    defaultBudgetEur: 0.5,
    defaultDurationMin: 20,
    defaultAutonomy: "autonome",
  },
  {
    id: "tpl-etude",
    name: "Étude produit",
    objective:
      "Cartographier un marché : acteurs, offres, tarifs, positionnement, et en tirer une synthèse.",
    usedFor: "Avant d'ouvrir un nouveau chantier produit",
    defaultBudgetEur: 3,
    defaultDurationMin: 300,
    defaultAutonomy: "encadree",
  },
  {
    id: "tpl-prd",
    name: "Assistant PRD",
    objective:
      "Structurer une spécification produit et poser les questions restées sans réponse.",
    usedFor: "Au cadrage d'une fonctionnalité",
    defaultBudgetEur: 2,
    defaultDurationMin: 180,
    defaultAutonomy: "supervisee",
  },
  {
    id: "tpl-seo",
    name: "Audit SEO",
    objective:
      "Passer les pages publiques : structure, temps de chargement, maillage, contenus dupliqués.",
    usedFor: "Tous les trimestres, ou après une refonte",
    defaultBudgetEur: 3,
    defaultDurationMin: 180,
    defaultAutonomy: "encadree",
  },
  {
    id: "tpl-rdv",
    name: "Préparation de rendez-vous",
    objective:
      "Reprendre l'historique du compte, lister les opportunités ouvertes et les points de blocage.",
    usedFor: "La veille d'un rendez-vous client",
    defaultBudgetEur: 2,
    defaultDurationMin: 90,
    defaultAutonomy: "encadree",
  },
];
