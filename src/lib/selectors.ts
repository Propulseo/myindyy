import type {
  Automation,
  AutomationRun,
  Decision,
  Deliverable,
  Mission,
  ObsidianTask,
  Person,
  Project,
} from "@/types/domain";
import {
  automations,
  decisions,
  deliverables,
  missions,
  obsidianTasks,
  projects,
} from "@/fixtures";
import { can, visibleProjectIds } from "./access";
import { minutesSince, ratio } from "./format";
import { notableOutcomes, type Tone } from "./status";

/**
 * L'ensemble des données affichables. Le contexte du cockpit fabrique ce jeu à partir
 * des fixtures plus les changements provoqués par la démonstration (mission suspendue,
 * décision approuvée, mission créée). Les sélecteurs restent des fonctions pures.
 */
export interface Dataset {
  projects: Project[];
  missions: Mission[];
  decisions: Decision[];
  deliverables: Deliverable[];
  automations: Automation[];
  tasks: ObsidianTask[];
}

export const baseDataset: Dataset = {
  projects,
  missions,
  decisions,
  deliverables,
  automations,
  tasks: obsidianTasks,
};

export const emptyDataset: Dataset = {
  projects,
  missions: [],
  decisions: [],
  deliverables: [],
  automations: [],
  tasks: [],
};

const newestFirst = (a: string, b: string) => Date.parse(b) - Date.parse(a);

/* ------------------------------------------------------------------ */
/* Vues filtrées par le rôle connecté                                  */
/* ------------------------------------------------------------------ */

export function visibleProjects(data: Dataset, viewer: Person): Project[] {
  const allowed = visibleProjectIds(viewer);
  return data.projects.filter((project) => allowed.has(project.id));
}

export function visibleMissions(data: Dataset, viewer: Person): Mission[] {
  const allowed = visibleProjectIds(viewer);
  return data.missions.filter((mission) => allowed.has(mission.projectId));
}

export function visibleDecisions(data: Dataset, viewer: Person): Decision[] {
  const allowed = visibleProjectIds(viewer);
  return data.decisions.filter((decision) => allowed.has(decision.projectId));
}

export function pendingDecisions(data: Dataset, viewer: Person): Decision[] {
  return visibleDecisions(data, viewer)
    .filter((decision) => decision.state === "en_attente")
    .sort((a, b) => newestFirst(a.requestedAt, b.requestedAt));
}

export function visibleDeliverables(data: Dataset, viewer: Person): Deliverable[] {
  const allowed = visibleProjectIds(viewer);
  return data.deliverables
    .filter((deliverable) => allowed.has(deliverable.projectId))
    .sort((a, b) => newestFirst(a.producedAt, b.producedAt));
}

export function visibleAutomations(data: Dataset, viewer: Person): Automation[] {
  const allowed = visibleProjectIds(viewer);
  return data.automations.filter((automation) => allowed.has(automation.projectId));
}

/**
 * Tâches Obsidian du jour. Les tâches personnelles n'apparaissent que pour les rôles
 * qui possèdent `tasks.personal.view`, c'est-à-dire leur propriétaire.
 */
export function visibleTasks(data: Dataset, viewer: Person): ObsidianTask[] {
  const allowed = visibleProjectIds(viewer);
  const seesPersonal = can(viewer, "tasks.personal.view");

  return data.tasks
    .filter((task) => {
      if (task.visibility === "personnelle") {
        return seesPersonal && task.ownerId === viewer.id;
      }
      return task.projectId !== undefined && allowed.has(task.projectId);
    })
    .sort((a, b) => {
      if (a.state === "fait" && b.state !== "fait") return 1;
      if (b.state === "fait" && a.state !== "fait") return -1;
      return Date.parse(a.dueAt) - Date.parse(b.dueAt);
    });
}

/* ------------------------------------------------------------------ */
/* Écran « Aujourd'hui »                                               */
/* ------------------------------------------------------------------ */

export type AttentionKind =
  | "decision"
  | "blocage"
  | "echec"
  | "budget"
  | "automatisation";

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  /** Ce qui est en jeu, formulé pour être lu en une seconde. */
  headline: string;
  detail: string;
  href: string;
  tone: Tone;
  at: string;
  projectId: string;
  missionId?: string;
  decisionId?: string;
}

const KIND_WEIGHT: Record<AttentionKind, number> = {
  decision: 0,
  blocage: 1,
  echec: 2,
  budget: 3,
  automatisation: 4,
};

/** Minuscule initiale, pour composer une phrase autour d'un titre de mission. */
function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Ce qui demande une attention humaine, et rien d'autre.
 *
 * Chaque problème n'apparaît qu'une fois : une mission au budget presque atteint qui
 * porte déjà une demande de dépassement produit une seule ligne, pas deux. Une
 * automatisation dont la dernière exécution a créé une mission déjà listée ne remonte
 * pas non plus.
 */
export function attentionItems(data: Dataset, viewer: Person): AttentionItem[] {
  const items: AttentionItem[] = [];
  const seenMissions = new Set<string>();
  const budgetDecisionMissions = new Set<string>();

  const pending = pendingDecisions(data, viewer);
  const visible = visibleMissions(data, viewer);

  // 1. Budget ou durée presque atteints, avec la demande de dépassement s'il y en a une.
  for (const mission of visible) {
    if (mission.status !== "en_cours") continue;
    const budgetRatio = ratio(mission.budget.spentEur, mission.budget.capEur);
    const durationRatio = ratio(mission.duration.elapsedMin, mission.duration.capMin);
    if (budgetRatio < 0.85 && durationRatio < 0.85) continue;

    const decision = pending.find(
      (item) => item.missionId === mission.id && item.kind === "depassement_budget",
    );
    if (decision) budgetDecisionMissions.add(mission.id);
    seenMissions.add(mission.id);

    const overBudget = budgetRatio >= durationRatio;
    items.push({
      id: `att-budget-${mission.id}`,
      kind: "budget",
      headline: overBudget
        ? `Budget presque atteint : ${lower(mission.title)}`
        : `Durée presque atteinte : ${lower(mission.title)}`,
      detail: overBudget
        ? `${Math.round(budgetRatio * 100)} % du budget consommé. La mission s'arrêtera d'elle-même au plafond.`
        : `${Math.round(durationRatio * 100)} % du temps alloué écoulé.`,
      href: `/missions/${mission.id}`,
      tone: "attention",
      at: mission.lastActivityAt,
      projectId: mission.projectId,
      missionId: mission.id,
      decisionId: decision?.id,
    });
  }

  // 2. Décisions en attente.
  for (const decision of pending) {
    if (budgetDecisionMissions.has(decision.missionId)) continue;
    seenMissions.add(decision.missionId);
    items.push({
      id: `att-dec-${decision.id}`,
      kind: "decision",
      headline: `Validation requise : ${lower(decision.title)}`,
      detail: decision.consequence,
      href: `/missions/${decision.missionId}`,
      tone: "attention",
      at: decision.requestedAt,
      projectId: decision.projectId,
      missionId: decision.missionId,
      decisionId: decision.id,
    });
  }

  // 3. Missions bloquées, puis missions en échec de moins de vingt-quatre heures.
  for (const mission of visible) {
    if (seenMissions.has(mission.id)) continue;

    if (mission.status === "bloquee") {
      seenMissions.add(mission.id);
      items.push({
        id: `att-blk-${mission.id}`,
        kind: "blocage",
        headline: `Mission bloquée : ${lower(mission.title)}`,
        detail: mission.summary,
        href: `/missions/${mission.id}`,
        tone: "danger",
        at: mission.lastActivityAt,
        projectId: mission.projectId,
        missionId: mission.id,
      });
      continue;
    }

    if (mission.status === "echouee" && minutesSince(mission.lastActivityAt) < 60 * 24) {
      seenMissions.add(mission.id);
      items.push({
        id: `att-fail-${mission.id}`,
        kind: "echec",
        headline: `Mission en échec : ${lower(mission.title)}`,
        detail: mission.summary,
        href: `/missions/${mission.id}`,
        tone: "danger",
        at: mission.lastActivityAt,
        projectId: mission.projectId,
        missionId: mission.id,
      });
    }
  }

  // 4. Automatisations qui sortent de leur routine.
  for (const automation of visibleAutomations(data, viewer)) {
    if (automation.health === "saine") continue;
    const run = automation.runs[0];
    if (!run || !notableOutcomes.includes(run.outcome)) continue;
    if (run.missionId && seenMissions.has(run.missionId)) continue;

    items.push({
      id: `att-auto-${automation.id}`,
      kind: "automatisation",
      headline:
        run.outcome === "echec"
          ? `Automatisation en échec : ${automation.name}`
          : `Signalement : ${automation.name}`,
      detail: run.note ?? automation.purpose,
      href: `/automatisations#${automation.id}`,
      tone: run.outcome === "echec" ? "danger" : "attention",
      at: run.at,
      projectId: automation.projectId,
    });
  }

  return items.sort((a, b) => {
    const weight = KIND_WEIGHT[a.kind] - KIND_WEIGHT[b.kind];
    return weight !== 0 ? weight : newestFirst(a.at, b.at);
  });
}

/** Ce qui travaille en ce moment, du plus récemment actif au plus ancien. */
export function workingMissions(data: Dataset, viewer: Person): Mission[] {
  return visibleMissions(data, viewer)
    .filter(
      (mission) => mission.status === "en_cours" || mission.status === "en_attente",
    )
    .sort((a, b) => newestFirst(a.lastActivityAt, b.lastActivityAt));
}

/** Ce qui vient de se terminer, sur les dernières trente heures. */
export function recentlyFinished(data: Dataset, viewer: Person, limit = 5): Mission[] {
  return visibleMissions(data, viewer)
    .filter(
      (mission) =>
        (mission.status === "terminee" ||
          mission.status === "echouee" ||
          mission.status === "annulee") &&
        minutesSince(mission.lastActivityAt) < 60 * 30,
    )
    .sort((a, b) => newestFirst(a.lastActivityAt, b.lastActivityAt))
    .slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* Pouls Indy                                                          */
/* ------------------------------------------------------------------ */

export type PulseEventKind = "active" | "decision" | "incident";

export interface PulseEvent {
  id: string;
  kind: PulseEventKind;
  at: string;
  /** Entre 0 et 1. Hauteur de la marque pour les missions actives. */
  intensity: number;
  label: string;
}

export interface PulseSnapshot {
  active: number;
  decisions: number;
  incidents: number;
  events: PulseEvent[];
  /** Synchronisation la plus récente parmi les données affichées. */
  syncedAt: string | null;
}

/** Fenêtre de la bande du Pouls : les douze dernières heures. */
export const PULSE_WINDOW_MINUTES = 12 * 60;

export function pulseSnapshot(data: Dataset, viewer: Person): PulseSnapshot {
  const forViewer = visibleMissions(data, viewer);
  const pending = pendingDecisions(data, viewer);
  const autos = visibleAutomations(data, viewer);

  const active = forViewer.filter((mission) => mission.status === "en_cours");
  const incidents = forViewer.filter(
    (mission) => mission.status === "bloquee" || mission.status === "echouee",
  );
  const failingAutomations = autos.filter(
    (automation) => automation.health === "en_echec",
  );

  const events: PulseEvent[] = [];

  for (const mission of active) {
    events.push({
      id: `pulse-a-${mission.id}`,
      kind: "active",
      at: mission.lastActivityAt,
      intensity: Math.max(
        0.35,
        ratio(mission.progress.done, mission.progress.total || 1),
      ),
      label: mission.title,
    });
  }

  for (const decision of pending) {
    events.push({
      id: `pulse-d-${decision.id}`,
      kind: "decision",
      at: decision.requestedAt,
      intensity: 1,
      label: decision.title,
    });
  }

  for (const mission of incidents) {
    events.push({
      id: `pulse-i-${mission.id}`,
      kind: "incident",
      at: mission.lastActivityAt,
      intensity: 1,
      label: mission.title,
    });
  }

  const withinWindow = events
    .filter((event) => {
      const age = minutesSince(event.at);
      return age >= 0 && age <= PULSE_WINDOW_MINUTES;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const syncedAt =
    forViewer
      .map((mission) => mission.source.syncedAt)
      .sort((a, b) => newestFirst(a, b))[0] ?? null;

  return {
    active: active.length,
    decisions: pending.length,
    incidents: incidents.length + failingAutomations.length,
    events: withinWindow,
    syncedAt,
  };
}

/* ------------------------------------------------------------------ */
/* Historique                                                          */
/* ------------------------------------------------------------------ */

export type HistoryKind = "mission" | "decision" | "execution";

export interface HistoryEntry {
  id: string;
  kind: HistoryKind;
  at: string;
  title: string;
  detail: string;
  projectId: string;
  href: string;
  tone: Tone;
  meta: string;
}

export function historyEntries(data: Dataset, viewer: Person): HistoryEntry[] {
  const entries: HistoryEntry[] = [];

  for (const mission of visibleMissions(data, viewer)) {
    if (
      mission.status !== "terminee" &&
      mission.status !== "echouee" &&
      mission.status !== "annulee"
    ) {
      continue;
    }
    entries.push({
      id: `hist-m-${mission.id}`,
      kind: "mission",
      at: mission.lastActivityAt,
      title: mission.title,
      detail: mission.summary,
      projectId: mission.projectId,
      href: `/missions/${mission.id}`,
      tone:
        mission.status === "terminee"
          ? "success"
          : mission.status === "echouee"
            ? "danger"
            : "neutral",
      meta: mission.reference,
    });
  }

  for (const decision of visibleDecisions(data, viewer)) {
    if (decision.state === "en_attente" || !decision.resolvedAt) continue;
    entries.push({
      id: `hist-d-${decision.id}`,
      kind: "decision",
      at: decision.resolvedAt,
      title: decision.title,
      detail:
        decision.state === "approuvee"
          ? `Approuvé · ${decision.target}`
          : `Refusé · ${decision.target}`,
      projectId: decision.projectId,
      href: `/missions/${decision.missionId}`,
      tone: decision.state === "approuvee" ? "success" : "danger",
      meta: decision.environment,
    });
  }

  for (const automation of visibleAutomations(data, viewer)) {
    for (const run of automation.runs) {
      if (!notableOutcomes.includes(run.outcome)) continue;
      entries.push({
        id: `hist-r-${run.id}`,
        kind: "execution",
        at: run.at,
        title: automation.name,
        detail: run.note ?? automation.purpose,
        projectId: automation.projectId,
        href: `/automatisations#${automation.id}`,
        tone: run.outcome === "echec" ? "danger" : "attention",
        meta: `${run.durationMin} min`,
      });
    }
  }

  return entries.sort((a, b) => newestFirst(a.at, b.at));
}

export function isNotableRun(run: AutomationRun): boolean {
  return notableOutcomes.includes(run.outcome);
}

/* ------------------------------------------------------------------ */
/* Budget agent consommé par projet                                    */
/* ------------------------------------------------------------------ */

export function projectSpend(data: Dataset, projectId: string): number {
  return data.missions
    .filter((mission) => mission.projectId === projectId)
    .reduce((total, mission) => total + mission.budget.spentEur, 0);
}
