import type {
  AgentActivity,
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
import { canSeeTask, visibleProjectIds } from "./access";
import { formatDuration, minutesSince, plural, ratio } from "./format";
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

/** Une tâche close ne remonte plus en tête de liste, mais elle ne disparaît pas. */
function isTaskClosed(task: ObsidianTask): boolean {
  return task.state === "fait" || task.state === "annulee";
}

/**
 * Tâches Obsidian du jour. Les tâches personnelles n'apparaissent que pour les rôles
 * qui possèdent `tasks.personal.view`, c'est-à-dire leur propriétaire ; les tâches
 * partagées suivent le périmètre des projets affectés.
 *
 * Les tâches terminées et annulées restent listées, en fin de liste et avec leur
 * statut écrit : rien n'est retiré en silence.
 */
export function visibleTasks(data: Dataset, viewer: Person): ObsidianTask[] {
  return data.tasks
    .filter((task) => canSeeTask(viewer, task))
    .sort((a, b) => {
      const closed = Number(isTaskClosed(a)) - Number(isTaskClosed(b));
      if (closed !== 0) return closed;
      return Date.parse(a.dueAt) - Date.parse(b.dueAt);
    });
}

/* ------------------------------------------------------------------ */
/* Écran « Aujourd'hui »                                               */
/* ------------------------------------------------------------------ */

/**
 * Au-delà de quelle durée sans le moindre évènement une mission en cours est
 * considérée comme inactive. C'est un garde-fou, pas une panne : la mission n'est
 * pas arrêtée, elle est seulement remontée à un humain.
 */
export const STALE_AFTER_MIN = 45;

/** Exécutants qui travaillent en ce moment sur la mission. */
export function activeAgentCount(mission: Mission): number {
  return mission.agents.filter((agent) => agent.state === "actif").length;
}

/** Une mission en cours qui n'a plus rien émis depuis le seuil d'inactivité. */
export function isStalled(mission: Mission): boolean {
  return (
    mission.status === "en_cours" &&
    minutesSince(mission.lastActivityAt) >= STALE_AFTER_MIN
  );
}

/** La mission est sur sa dernière tentative autorisée. */
export function isLastAttempt(mission: Mission): boolean {
  return mission.attempts.current >= mission.attempts.max;
}

export type AttentionKind =
  | "decision"
  | "blocage"
  | "echec"
  | "inactivite"
  | "limite"
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
  inactivite: 3,
  limite: 4,
  automatisation: 5,
};

/** Minuscule initiale, pour composer une phrase autour d'un titre de mission. */
function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Ce qui demande une attention humaine, et rien d'autre.
 *
 * Chaque problème n'apparaît qu'une fois. Une mission qui touche plusieurs garde-fous
 * à la fois — durée presque écoulée, dernière tentative, plus aucun signe de vie —
 * produit une seule ligne : la raison la plus pressante en titre, les autres en
 * complément. Une mission qui porte déjà une demande de prolongation ne produit pas
 * non plus deux lignes. Une automatisation dont la dernière exécution a créé une
 * mission déjà listée ne remonte pas.
 */
export function attentionItems(data: Dataset, viewer: Person): AttentionItem[] {
  const items: AttentionItem[] = [];
  const seenMissions = new Set<string>();
  const prolongationMissions = new Set<string>();

  const pending = pendingDecisions(data, viewer);
  const visible = visibleMissions(data, viewer);

  // 1. Missions en cours qui touchent un garde-fou : inactivité, durée, tentatives.
  for (const mission of visible) {
    if (mission.status !== "en_cours") continue;

    const durationRatio = ratio(mission.duration.elapsedMin, mission.duration.capMin);
    const idleMin = minutesSince(mission.lastActivityAt);
    const stalled = idleMin >= STALE_AFTER_MIN;
    const lastAttempt = isLastAttempt(mission);
    if (!stalled && durationRatio < 0.85 && !lastAttempt) continue;

    const title = lower(mission.title);
    const active = activeAgentCount(mission);

    // Ordre d'urgence : plus rien ne bouge, puis le temps, puis les reprises.
    const reasons: { kind: AttentionKind; headline: string; detail: string }[] = [];
    if (stalled) {
      reasons.push({
        kind: "inactivite",
        headline: `Mission inactive : ${title}`,
        detail: `Aucune activité depuis ${formatDuration(idleMin)}, avec ${plural(active, "exécutant actif", "exécutants actifs")}.`,
      });
    }
    if (durationRatio >= 0.85) {
      reasons.push({
        kind: "limite",
        headline: `Durée presque atteinte : ${title}`,
        detail: `${Math.round(durationRatio * 100)} % du temps alloué écoulé. Sans prolongation, la mission s'arrête d'elle-même à la limite.`,
      });
    }
    if (lastAttempt) {
      reasons.push({
        kind: "limite",
        headline: `Dernière tentative : ${title}`,
        detail: `Tentative ${mission.attempts.current} sur ${mission.attempts.max}. Il n'en reste aucune si celle-ci n'aboutit pas.`,
      });
    }

    const [main, ...rest] = reasons;
    const decision = pending.find(
      (item) => item.missionId === mission.id && item.kind === "prolongation",
    );
    if (decision) prolongationMissions.add(mission.id);
    seenMissions.add(mission.id);

    items.push({
      id: `att-limite-${mission.id}`,
      kind: main.kind,
      headline: main.headline,
      detail: [main.detail, ...rest.map((reason) => reason.detail)].join(" "),
      href: `/missions/${mission.id}`,
      tone: main.kind === "inactivite" ? "danger" : "attention",
      at: mission.lastActivityAt,
      projectId: mission.projectId,
      missionId: mission.id,
      decisionId: decision?.id,
    });
  }

  // 2. Décisions en attente.
  for (const decision of pending) {
    if (prolongationMissions.has(decision.missionId)) continue;
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

  // La déduplication ferait disparaître l'automatisation d'origine : on la nomme
  // sur la ligne de la mission plutôt que d'ajouter une seconde ligne.
  const automationNames = new Map(
    data.automations.map((automation) => [automation.id, automation.name]),
  );
  const withOrigin = items.map((item) => {
    if (!item.missionId) return item;
    const mission = visible.find((entry) => entry.id === item.missionId);
    const name = mission?.automationId
      ? automationNames.get(mission.automationId)
      : undefined;
    return name ? { ...item, detail: `${item.detail} Issue de « ${name} ».` } : item;
  });

  return withOrigin.sort((a, b) => {
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

  // Une mission qui ne donne plus signe de vie n'est pas active : c'est un incident.
  // La compter ailleurs rendrait le Pouls rassurant à tort.
  const active = forViewer.filter(
    (mission) => mission.status === "en_cours" && !isStalled(mission),
  );
  const incidents = forViewer.filter(
    (mission) =>
      mission.status === "bloquee" ||
      mission.status === "echouee" ||
      isStalled(mission),
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
/* Activité des agents sur un projet                                   */
/* ------------------------------------------------------------------ */

/**
 * Recalculée à chaque affichage à partir des missions du projet — jamais stockée, donc
 * jamais en contradiction avec la liste affichée juste à côté.
 *
 * Le taux de réussite ne porte que sur ce que les agents ont mené à son terme ou raté.
 * Une mission annulée est une décision humaine : elle compte dans les interventions,
 * pas dans les échecs.
 */
export function projectAgentActivity(data: Dataset, projectId: string): AgentActivity {
  const forProject = data.missions.filter(
    (mission) => mission.projectId === projectId,
  );

  const closed = forProject.filter(
    (mission) => mission.status === "terminee" || mission.status === "echouee",
  );
  const succeeded = closed.filter((mission) => mission.status === "terminee");
  const cancelled = forProject.filter((mission) => mission.status === "annulee");

  const durations = closed
    .map((mission) => mission.duration.elapsedMin)
    .sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const medianDurationMin =
    durations.length === 0
      ? null
      : durations.length % 2 === 1
        ? durations[middle]
        : Math.round((durations[middle - 1] + durations[middle]) / 2);

  const instructions = forProject.reduce(
    (total, mission) =>
      total + mission.activity.filter((event) => event.kind === "instruction").length,
    0,
  );
  const resolvedDecisions = data.decisions.filter(
    (decision) => decision.projectId === projectId && decision.state !== "en_attente",
  ).length;

  return {
    missionCount: forProject.length,
    closedCount: closed.length,
    successRate: closed.length === 0 ? null : succeeded.length / closed.length,
    medianDurationMin,
    humanInterventions: instructions + resolvedDecisions + cancelled.length,
    blockedMissions: forProject.filter((mission) => mission.status === "bloquee").length,
  };
}
