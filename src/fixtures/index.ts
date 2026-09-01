/**
 * Point d'entrée unique des données de démonstration.
 *
 * Aucun composant n'importe un fichier de fixtures directement : tout passe par ici,
 * puis par les sélecteurs de `@/lib/selectors` qui appliquent les permissions du rôle
 * connecté. Remplacer ce module par des appels réseau ne toucherait aucun composant.
 */
export { DEMO_NOW_ISO, daysAgo, hoursAgo, inHours, minutesAgo } from "./clock";
export { automations, automationsById } from "./automations";
export { decisions, decisionsById } from "./decisions";
export { deliverables, deliverablesById } from "./deliverables";
export { missions, missionsById } from "./missions";
export { people, peopleById } from "./people";
export { projects, projectsById } from "./projects";
export { missionTemplates, obsidianTasks } from "./tasks";
