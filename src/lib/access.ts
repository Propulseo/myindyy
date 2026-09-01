import type { Capability, ObsidianTask, Person } from "@/types/domain";
import { projects } from "@/fixtures";

/** Le rôle possède-t-il cette permission ? */
export function can(person: Person, capability: Capability): boolean {
  return person.capabilities.includes(capability);
}

/**
 * Projets réellement visibles par le rôle.
 * Sans `projects.viewAll`, un projet non affecté n'existe pas : il ne s'affiche pas
 * en grisé, il n'apparaît nulle part, pas même dans les filtres.
 */
export function visibleProjectIds(person: Person): Set<string> {
  if (can(person, "projects.viewAll")) {
    return new Set(projects.map((project) => project.id));
  }
  return new Set(person.projectIds);
}

export function canSeeProject(person: Person, projectId: string): boolean {
  return visibleProjectIds(person).has(projectId);
}

/**
 * Raison écrite pour laquelle une action est indisponible. Utilisée telle quelle dans
 * l'interface : on explique, on ne se contente pas de désactiver un bouton.
 */
export const capabilityDenial: Record<Capability, string> = {
  "missions.create": "Votre rôle ne permet pas de lancer une mission.",
  "missions.control": "Votre rôle ne permet pas de piloter cette mission.",
  "missions.cancel": "Votre rôle ne permet pas d'annuler une mission.",
  "missions.approve": "Votre rôle ne permet pas de répondre à cette décision.",
  "deploy.production":
    "Le déploiement en production est réservé aux rôles qui en ont la charge.",
  "comms.external.send":
    "L'envoi vers l'extérieur est réservé aux rôles qui en ont la charge.",
  "limits.override":
    "Seul le propriétaire peut prolonger une mission au-delà de sa durée ou de ses tentatives.",
  "secrets.view": "Les identifiants des sources connectées ne sont visibles que du propriétaire.",
  "tasks.manage": "Votre rôle ne permet pas d'agir sur les tâches.",
  "tasks.personal.view": "Les tâches personnelles ne sont visibles que de leur propriétaire.",
  "projects.viewAll": "Vous ne voyez que les projets qui vous sont affectés.",
};

/* ------------------------------------------------------------------ */
/* Tâches Obsidian                                                     */
/* ------------------------------------------------------------------ */

/** Ce qu'il faut connaître d'une tâche pour décider qui a le droit d'y toucher. */
export type TaskScope = Pick<ObsidianTask, "visibility" | "projectId" | "ownerId">;

/**
 * Le rôle voit-il cette tâche ?
 *
 * Une tâche personnelle n'appartient qu'à son propriétaire. Une tâche partagée suit
 * son projet : hors du périmètre affecté, elle n'existe pas — ni en liste, ni en champ.
 */
export function canSeeTask(person: Person, task: TaskScope): boolean {
  if (task.visibility === "personnelle") {
    return can(person, "tasks.personal.view") && task.ownerId === person.id;
  }
  return task.projectId !== undefined && canSeeProject(person, task.projectId);
}

/**
 * Le rôle peut-il trier, terminer ou annuler cette tâche ? Voir ne suffit pas :
 * il faut aussi la permission d'agir.
 */
export function canManageTask(person: Person, task: TaskScope): boolean {
  return can(person, "tasks.manage") && canSeeTask(person, task);
}

/**
 * Pourquoi l'action est indisponible, en une phrase. `null` quand elle est permise.
 * L'interface affiche cette phrase au lieu de désactiver un bouton sans rien dire.
 */
export function taskDenial(person: Person, task: TaskScope): string | null {
  if (!can(person, "tasks.manage")) return capabilityDenial["tasks.manage"];
  if (task.visibility === "personnelle") {
    return canSeeTask(person, task) ? null : capabilityDenial["tasks.personal.view"];
  }
  return canSeeTask(person, task)
    ? null
    : "Cette tâche appartient à un projet qui ne vous est pas affecté.";
}
