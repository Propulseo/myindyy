import type {
  Capability,
  ObsidianTask,
  Person,
  PersonId,
  TaskCommand,
} from "@/types/domain";
import { projects, projectsById } from "@/fixtures";

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
 * il faut aussi la permission d'agir. Le jugement est celui du réducteur, pas
 * une seconde règle écrite à côté.
 */
export function canManageTask(person: Person, task: TaskScope): boolean {
  return authorizeTaskCommand(person, "todo.complete", { task }).allowed;
}

/** Membres d'un projet, dans l'ordre déclaré. Vide si le projet n'existe pas. */
export function projectMemberIds(projectId: string): PersonId[] {
  return projectsById[projectId]?.memberIds ?? [];
}

/**
 * Où une commande dépose la tâche : un projet — ou aucun, pour une tâche
 * personnelle — et la personne qui la porte. `TaskDraft` satisfait cette forme.
 */
export interface TaskTarget {
  /** Absent : tâche personnelle. */
  projectId?: string;
  ownerId: PersonId;
}

export type TaskDenialReason =
  /** Le rôle n'a pas du tout le droit d'agir sur les tâches. */
  | "capability"
  /** Tâche personnelle : elle n'appartient qu'à son propriétaire. */
  | "personal"
  /** Le projet, source ou cible, n'est pas affecté au rôle. */
  | "project"
  /** Le responsable choisi n'est pas membre du projet visé. */
  | "membership";

export interface TaskAuthorization {
  allowed: boolean;
  reason?: TaskDenialReason;
}

const ALLOWED: TaskAuthorization = { allowed: true };
const deny = (reason: TaskDenialReason): TaskAuthorization => ({
  allowed: false,
  reason,
});

/**
 * La règle d'autorisation d'une commande de tâche, écrite une seule fois.
 *
 * L'interface s'en sert pour décider ce qu'elle propose et ce qu'elle explique ;
 * le réducteur s'en sert pour refuser une commande qui arriverait malgré tout.
 * Les deux passent donc exactement par le même jugement.
 *
 * `task` décrit la tâche visée quand elle existe déjà — tri, fin, annulation.
 * `target` décrit où la commande dépose la tâche — capture, tri.
 *
 * Ces contrôles sont ceux d'une démonstration : ils vivent dans le navigateur.
 * Hermes et les connecteurs devront refaire ces autorisations côté serveur avant
 * toute mutation réelle du coffre Obsidian.
 */
export function authorizeTaskCommand(
  person: Person,
  command: TaskCommand,
  input: { task?: TaskScope; target?: TaskTarget },
): TaskAuthorization {
  if (!can(person, "tasks.manage")) return deny("capability");

  // 1. La tâche visée doit être dans le périmètre du rôle.
  const { task, target } = input;
  if (task && !canSeeTask(person, task)) {
    return deny(task.visibility === "personnelle" ? "personal" : "project");
  }

  // 2. La destination doit l'être aussi, responsable compris.
  if (target) {
    if (!target.projectId) {
      // Une tâche personnelle n'appartient qu'à son propriétaire : personne
      // d'autre ne peut en créer une, ni transformer une tâche partagée en tâche
      // personnelle, ni en confier la responsabilité à quelqu'un d'autre.
      if (!can(person, "tasks.personal.view")) return deny("personal");
      if (target.ownerId !== person.id) return deny("personal");
      return ALLOWED;
    }
    if (!canSeeProject(person, target.projectId)) return deny("project");
    if (!projectMemberIds(target.projectId).includes(target.ownerId)) {
      return deny("membership");
    }
  }

  // Une commande sans cible ni destination ne veut rien dire.
  return task || target ? ALLOWED : deny("project");
}

/** Ce que l'interface écrit quand une commande n'est pas permise. */
export const taskDenialMessage: Record<TaskDenialReason, string> = {
  capability: capabilityDenial["tasks.manage"],
  personal: capabilityDenial["tasks.personal.view"],
  project: "Cette tâche appartient à un projet qui ne vous est pas affecté.",
  membership: "Le responsable choisi n'est pas membre du projet visé.",
};

/**
 * Pourquoi l'action est indisponible, en une phrase. `null` quand elle est permise.
 * L'interface affiche cette phrase au lieu de désactiver un bouton sans rien dire.
 */
export function taskDenial(person: Person, task: TaskScope): string | null {
  const verdict = authorizeTaskCommand(person, "todo.complete", { task });
  return verdict.allowed ? null : taskDenialMessage[verdict.reason ?? "project"];
}
