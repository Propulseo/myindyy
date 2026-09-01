/**
 * L'état que la démonstration fait bouger, et rien d'autre.
 *
 * Tout est ici sous forme de fonctions pures : le fournisseur React n'a plus qu'à
 * dispatcher. Les conséquences d'un refus, d'une prolongation ou d'une commande de
 * tâche se lisent donc à un seul endroit, et se vérifient sans monter de composant.
 *
 * Les mutations sont simulées : rien ne quitte le navigateur, rien ne survit à un
 * rechargement, aucune commande n'est réellement envoyée à Hermes.
 */
import type {
  ActivityEvent,
  AutonomyLevel,
  Decision,
  DecisionState,
  EffortLevel,
  Mission,
  MissionStatus,
  ObsidianTask,
  Person,
  PersonId,
  Provenance,
  TaskCommand,
} from "@/types/domain";
import { DEMO_NOW_ISO } from "@/fixtures/clock";
import { formatDuration, plural } from "./format";

export interface JournalEntry {
  id: string;
  at: string;
  message: string;
  tone: "neutral" | "success" | "danger";
}

/** Ce qu'une action de démonstration change sur une mission existante. */
export interface MissionPatch {
  status?: MissionStatus;
  /** Garde-fous repoussés par une prolongation approuvée. */
  durationCapMin?: number;
  attemptsMax?: number;
  activity?: ActivityEvent[];
}

export type DecisionPatch = {
  state: DecisionState;
  resolvedAt: string;
  resolvedById: PersonId;
};

export type MissionControl = "suspendre" | "reprendre" | "relancer" | "annuler";

export interface MissionDraft {
  objective: string;
  projectId: string;
  templateId: string | null;
  /** Garde-fou de temps, en minutes. */
  durationMin: number;
  /** Nombre de reprises autorisées avant que la mission rende la main. */
  maxAttempts: number;
  /** Exécutants autorisés à travailler en même temps. Un par défaut. */
  parallelAgents: number;
  /** Échéance attendue, facultative. Instant ISO 8601. */
  dueAt?: string;
  effort: EffortLevel;
  autonomy: AutonomyLevel;
}

export interface TaskDraft {
  title: string;
  /** Absent : tâche personnelle. */
  projectId?: string;
  ownerId: PersonId;
  dueAt: string;
  note?: string;
}

export interface CockpitState {
  missionPatches: Record<string, MissionPatch>;
  decisionPatches: Record<string, DecisionPatch>;
  createdMissions: Mission[];
  /** Tâches capturées pendant la session, les plus récentes d'abord. */
  createdTasks: ObsidianTask[];
  /** Tâches modifiées pendant la session, par identifiant. */
  taskPatches: Record<string, ObsidianTask>;
  journal: JournalEntry[];
  /** Compteur d'identifiants : la suite d'actions reste reproductible. */
  sequence: number;
}

export const initialCockpitState: CockpitState = {
  missionPatches: {},
  decisionPatches: {},
  createdMissions: [],
  createdTasks: [],
  taskPatches: {},
  journal: [],
  sequence: 0,
};

export type CockpitAction =
  | { type: "mission.control"; actor: Person; mission: Mission; action: MissionControl }
  | { type: "mission.instruct"; actor: Person; mission: Mission; text: string }
  | { type: "mission.create"; actor: Person; draft: MissionDraft }
  | {
      type: "decision.resolve";
      actor: Person;
      decision: Decision;
      mission?: Mission;
      approve: boolean;
    }
  | { type: "task.capture"; actor: Person; draft: TaskDraft }
  | { type: "task.triage"; actor: Person; task: ObsidianTask; draft: TaskDraft }
  | { type: "task.complete"; actor: Person; task: ObsidianTask }
  | { type: "task.cancel"; actor: Person; task: ObsidianTask }
  | { type: "journal.dismiss"; id: string };

/* ------------------------------------------------------------------ */
/* Règles métier, isolées pour être lisibles et vérifiables            */
/* ------------------------------------------------------------------ */

const MISSION_ACTION_LABEL: Record<MissionControl, string> = {
  suspendre: "suspendue",
  reprendre: "reprise",
  relancer: "relancée",
  annuler: "annulée",
};

const MISSION_ACTION_STATUS: Record<MissionControl, MissionStatus> = {
  suspendre: "en_attente",
  reprendre: "en_cours",
  relancer: "en_cours",
  annuler: "annulee",
};

/** Une prolongation approuvée accorde une heure et une tentative de plus. */
export const PROLONGATION_EXTRA_MIN = 60;
export const PROLONGATION_EXTRA_ATTEMPTS = 1;

export interface RefusalOutcome {
  /** Statut de la mission après le refus. Jamais `annulee`. */
  status: MissionStatus;
  /** Ce qui se produit, affiché avant de confirmer et journalisé ensuite. */
  consequence: string;
  /** La même chose en une ligne, pour le journal. */
  summary: string;
}

/**
 * Ce qu'un refus entraîne réellement.
 *
 * Refuser, c'est écarter l'action demandée — pas détruire le travail. La mission
 * garde ses étapes et ses livrables, repasse en attente et attend une nouvelle
 * instruction humaine. Refuser une prolongation est le seul cas où la mission
 * continue : elle poursuit jusqu'à ses limites actuelles, puis rend la main.
 * L'annulation complète est une action séparée, avec son propre panneau.
 */
export function refusalOutcome(decision: Decision, mission?: Mission): RefusalOutcome {
  if (decision.kind === "prolongation") {
    const limits = mission
      ? `${formatDuration(mission.duration.capMin)} et ${plural(mission.attempts.max, "tentative")}`
      : "ses limites actuelles";
    return {
      status: "en_cours",
      consequence: `La mission continue avec ses limites actuelles — ${limits}. À la limite, elle s'arrête d'elle-même et rend ce qu'elle a produit.`,
      summary: "La mission continue avec ses limites actuelles.",
    };
  }
  return {
    status: "en_attente",
    consequence:
      "L'action demandée n'a pas lieu. La mission n'est pas annulée : elle passe en attente, conserve ses étapes et ses livrables, et attend une nouvelle instruction.",
    summary: "La mission passe en attente d'une nouvelle instruction.",
  };
}

/** Les garde-fous après une prolongation approuvée, déduits de la mission. */
export function prolongedLimits(mission: Mission): {
  durationCapMin: number;
  attemptsMax: number;
} {
  return {
    durationCapMin: mission.duration.capMin + PROLONGATION_EXTRA_MIN,
    attemptsMax: mission.attempts.max + PROLONGATION_EXTRA_ATTEMPTS,
  };
}

/** Ce qu'entraîne l'annulation d'une tâche, affiché avant de confirmer. */
export const TASK_CANCEL_CONSEQUENCE =
  "La tâche sort de la journée. Elle n'est pas supprimée : Hermes la marque annulée dans le coffre, et elle reste consultable avec ce statut.";

/* ------------------------------------------------------------------ */
/* Réducteur                                                           */
/* ------------------------------------------------------------------ */

const JOURNAL_LIMIT = 4;

function hermes(reference: string): Provenance {
  return { system: "hermes", reference, syncedAt: DEMO_NOW_ISO };
}

/** Provenance d'une tâche après une commande : Hermes reçoit, Obsidian conserve. */
function taskSource(command: TaskCommand, note: string): Provenance {
  return hermes(`Hermes · ${command} → Obsidian · ${note}`);
}

function journalEntry(
  sequence: number,
  message: string,
  tone: JournalEntry["tone"],
): JournalEntry {
  return { id: `journal-${sequence}`, at: DEMO_NOW_ISO, message, tone };
}

function activityEvent(
  sequence: number,
  event: Omit<ActivityEvent, "id" | "at">,
): ActivityEvent {
  return { id: `act-${sequence}`, at: DEMO_NOW_ISO, ...event };
}

/** Empile un évènement en tête de ce que la session a déjà ajouté à la mission. */
function withActivity(
  patches: Record<string, MissionPatch>,
  missionId: string,
  event: ActivityEvent,
  rest: Omit<MissionPatch, "activity">,
): Record<string, MissionPatch> {
  const current = patches[missionId];
  return {
    ...patches,
    [missionId]: {
      ...current,
      ...rest,
      activity: [event, ...(current?.activity ?? [])],
    },
  };
}

function pushJournal(
  state: CockpitState,
  sequence: number,
  message: string,
  tone: JournalEntry["tone"],
): JournalEntry[] {
  return [journalEntry(sequence, message, tone), ...state.journal].slice(0, JOURNAL_LIMIT);
}

function taskFromDraft(
  draft: TaskDraft,
  base: Pick<ObsidianTask, "id" | "state"> & Partial<ObsidianTask>,
  command: TaskCommand,
  reference: string,
): ObsidianTask {
  const personal = !draft.projectId;
  return {
    ...base,
    id: base.id,
    title: draft.title,
    projectId: draft.projectId,
    visibility: personal ? "personnelle" : "partagee",
    ownerId: draft.ownerId,
    state: base.state,
    dueAt: draft.dueAt,
    note: draft.note?.trim() ? draft.note.trim() : undefined,
    source: taskSource(command, reference),
  };
}

export function cockpitReducer(
  state: CockpitState,
  action: CockpitAction,
): CockpitState {
  const sequence = state.sequence + 1;

  switch (action.type) {
    case "journal.dismiss":
      return {
        ...state,
        journal: state.journal.filter((entry) => entry.id !== action.id),
      };

    case "mission.control": {
      const { mission, actor } = action;
      const label = MISSION_ACTION_LABEL[action.action];
      const event = activityEvent(sequence, {
        kind: action.action === "annuler" ? "decision" : "systeme",
        actor: actor.name,
        message: `Mission ${label}.`,
        source: hermes(`Hermes · mission ${mission.reference}`),
      });

      return {
        ...state,
        sequence,
        missionPatches: withActivity(state.missionPatches, mission.id, event, {
          status: MISSION_ACTION_STATUS[action.action],
        }),
        journal: pushJournal(
          state,
          sequence,
          `${mission.title} — ${label}.`,
          action.action === "annuler" ? "danger" : "neutral",
        ),
      };
    }

    case "mission.instruct": {
      const event = activityEvent(sequence, {
        kind: "instruction",
        actor: action.actor.name,
        message: action.text,
        source: hermes("Hermes · instruction"),
      });

      return {
        ...state,
        sequence,
        missionPatches: withActivity(
          state.missionPatches,
          action.mission.id,
          event,
          {},
        ),
        journal: pushJournal(
          state,
          sequence,
          "Instruction transmise à la mission.",
          "neutral",
        ),
      };
    }

    case "decision.resolve": {
      const { decision, mission, actor, approve } = action;

      // Un refus n'annule rien : il écarte l'action et rend la main à un humain.
      const refusal = approve ? undefined : refusalOutcome(decision, mission);
      const limits =
        approve && decision.kind === "prolongation" && mission
          ? prolongedLimits(mission)
          : undefined;

      const event = activityEvent(sequence, {
        kind: "decision",
        actor: actor.name,
        message: refusal
          ? `${decision.title} — refusé. ${refusal.consequence}`
          : `${decision.title} — approuvé.`,
        source: decision.source,
      });

      return {
        ...state,
        sequence,
        decisionPatches: {
          ...state.decisionPatches,
          [decision.id]: {
            state: approve ? "approuvee" : "refusee",
            resolvedAt: DEMO_NOW_ISO,
            resolvedById: actor.id,
          },
        },
        missionPatches: withActivity(
          state.missionPatches,
          decision.missionId,
          event,
          {
            status: refusal ? refusal.status : "en_cours",
            ...(limits
              ? {
                  durationCapMin: limits.durationCapMin,
                  attemptsMax: limits.attemptsMax,
                }
              : {}),
          },
        ),
        journal: pushJournal(
          state,
          sequence,
          refusal
            ? `${decision.title} — refusé. ${refusal.summary}`
            : `${decision.title} — approuvé.`,
          refusal ? "danger" : "success",
        ),
      };
    }

    case "mission.create": {
      const { draft, actor } = action;
      const index = state.createdMissions.length + 1;
      const id = `m-new-${index}`;
      const mission: Mission = {
        id,
        reference: `M-${300 + index}`,
        title: draft.objective,
        summary:
          "Mission créée depuis le cockpit. Elle démarrera dès qu'un exécutant sera libre.",
        status: "en_attente",
        projectId: draft.projectId,
        ownerId: actor.id,
        autonomy: draft.autonomy,
        lastActivityAt: DEMO_NOW_ISO,
        effort: draft.effort,
        dueAt: draft.dueAt,
        progress: { done: 0, total: 1, unit: "étapes" },
        duration: { elapsedMin: 0, capMin: draft.durationMin },
        attempts: { current: 0, max: draft.maxAttempts },
        parallelAgents: draft.parallelAgents,
        steps: [{ id: `${id}-s1`, label: "Préparer la mission", state: "todo" }],
        agents: [],
        activity: [
          activityEvent(sequence, {
            kind: "instruction",
            actor: actor.name,
            message: draft.objective,
            source: hermes("Hermes · mise en file"),
          }),
        ],
        deliverableIds: [],
        decisionIds: [],
        diagnostics: [
          {
            at: DEMO_NOW_ISO,
            level: "info",
            scope: "file",
            message: [
              "queued",
              `duration_cap=${draft.durationMin}min`,
              `attempts_max=${draft.maxAttempts}`,
              `parallel_agents=${draft.parallelAgents}`,
              `due_at=${draft.dueAt ?? "aucune"}`,
              `effort=${draft.effort}`,
              `autonomy=${draft.autonomy}`,
            ].join(" "),
          },
        ],
        source: hermes(`Hermes · mission ${300 + index}`),
      };

      return {
        ...state,
        sequence,
        createdMissions: [mission, ...state.createdMissions],
        journal: pushJournal(
          state,
          sequence,
          `Mission créée : ${draft.objective}`,
          "success",
        ),
      };
    }

    case "task.capture": {
      const id = `t-new-${state.createdTasks.length + 1}`;
      const task = taskFromDraft(
        action.draft,
        { id, state: "a_faire" },
        "todo.capture",
        `tâches/T-${4300 + state.createdTasks.length + 1}`,
      );

      return {
        ...state,
        sequence,
        createdTasks: [task, ...state.createdTasks],
        journal: pushJournal(
          state,
          sequence,
          `« ${task.title} » — capturée. Commande todo.capture transmise à Hermes.`,
          "success",
        ),
      };
    }

    case "task.triage": {
      const task = taskFromDraft(
        action.draft,
        action.task,
        "todo.triage",
        referenceOf(action.task),
      );

      return {
        ...state,
        sequence,
        taskPatches: { ...state.taskPatches, [task.id]: task },
        journal: pushJournal(
          state,
          sequence,
          `« ${task.title} » — triée. Commande todo.triage transmise à Hermes.`,
          "neutral",
        ),
      };
    }

    case "task.complete": {
      const task: ObsidianTask = {
        ...action.task,
        state: "fait",
        source: taskSource("todo.complete", referenceOf(action.task)),
      };

      return {
        ...state,
        sequence,
        taskPatches: { ...state.taskPatches, [task.id]: task },
        journal: pushJournal(
          state,
          sequence,
          `« ${task.title} » — terminée. Commande todo.complete transmise à Hermes.`,
          "success",
        ),
      };
    }

    case "task.cancel": {
      const task: ObsidianTask = {
        ...action.task,
        state: "annulee",
        source: taskSource("todo.cancel", referenceOf(action.task)),
      };

      return {
        ...state,
        sequence,
        taskPatches: { ...state.taskPatches, [task.id]: task },
        journal: pushJournal(
          state,
          sequence,
          `« ${task.title} » — annulée. Commande todo.cancel transmise à Hermes.`,
          "danger",
        ),
      };
    }
  }
}

/** Garde la note d'origine d'une tâche dans le coffre, quelle que soit la commande. */
function referenceOf(task: ObsidianTask): string {
  const arrow = task.source.reference.split("→").pop() ?? task.source.reference;
  return arrow.replace(/^\s*Obsidian\s*·\s*/, "").trim();
}

/* ------------------------------------------------------------------ */
/* Application de l'état aux données                                   */
/* ------------------------------------------------------------------ */

/** Les missions des fixtures, augmentées de ce que la session a fait bouger. */
export function applyMissions(state: CockpitState, missions: Mission[]): Mission[] {
  return [...state.createdMissions, ...missions].map((mission) => {
    const patch = state.missionPatches[mission.id];
    if (!patch) return mission;
    return {
      ...mission,
      status: patch.status ?? mission.status,
      duration: {
        ...mission.duration,
        capMin: patch.durationCapMin ?? mission.duration.capMin,
      },
      attempts: {
        ...mission.attempts,
        max: patch.attemptsMax ?? mission.attempts.max,
      },
      activity: patch.activity
        ? [...patch.activity, ...mission.activity]
        : mission.activity,
    };
  });
}

export function applyDecisions(
  state: CockpitState,
  decisions: Decision[],
): Decision[] {
  return decisions.map((decision) => {
    const patch = state.decisionPatches[decision.id];
    return patch ? { ...decision, ...patch } : decision;
  });
}

export function applyTasks(
  state: CockpitState,
  tasks: ObsidianTask[],
): ObsidianTask[] {
  return [...state.createdTasks, ...tasks].map(
    (task) => state.taskPatches[task.id] ?? task,
  );
}
