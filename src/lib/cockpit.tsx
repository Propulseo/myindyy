"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  ActivityEvent,
  AutonomyLevel,
  Decision,
  EffortLevel,
  Mission,
  MissionStatus,
  Person,
  PersonId,
} from "@/types/domain";
import { DEMO_NOW_ISO, missions as baseMissions, people } from "@/fixtures";
import { baseDataset, emptyDataset, type Dataset } from "./selectors";
import {
  getViewerServerSnapshot,
  getViewerSnapshot,
  subscribeViewer,
  writeViewer,
} from "./viewer-store";

/** Ce que la démonstration peut mettre à l'écran, pour montrer les états dessinés. */
export type DisplayState = "normal" | "chargement" | "vide" | "erreur";

export interface JournalEntry {
  id: string;
  at: string;
  message: string;
  tone: "neutral" | "success" | "danger";
}

export interface MissionDraft {
  objective: string;
  projectId: string;
  templateId: string | null;
  /** Garde-fou de temps, en minutes. */
  durationMin: number;
  /** Nombre de reprises autorisées avant que la mission rende la main. */
  maxAttempts: number;
  effort: EffortLevel;
  autonomy: AutonomyLevel;
}

interface MissionPatch {
  status?: MissionStatus;
  /** Garde-fous repoussés par une prolongation approuvée. */
  durationCapMin?: number;
  attemptsMax?: number;
  activity?: ActivityEvent[];
}

interface CockpitValue {
  viewer: Person;
  people: Person[];
  setViewer: (id: PersonId) => void;
  display: DisplayState;
  setDisplay: (state: DisplayState) => void;
  /** Jeu de données déjà teinté par l'état d'affichage de démonstration. */
  data: Dataset;
  /** `true` quand l'écran doit montrer son état d'erreur. */
  hasError: boolean;
  isLoading: boolean;
  journal: JournalEntry[];
  dismissJournalEntry: (id: string) => void;
  controlMission: (
    missionId: string,
    action: "suspendre" | "reprendre" | "relancer" | "annuler",
  ) => void;
  resolveDecision: (decisionId: string, approve: boolean) => void;
  sendInstruction: (missionId: string, text: string) => void;
  createMission: (draft: MissionDraft) => string;
}

const CockpitContext = createContext<CockpitValue | null>(null);

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${(sequence += 1)}`;

const MISSION_ACTION_LABEL: Record<string, string> = {
  suspendre: "suspendue",
  reprendre: "reprise",
  relancer: "relancée",
  annuler: "annulée",
};

const MISSION_ACTION_STATUS: Record<string, MissionStatus> = {
  suspendre: "en_attente",
  reprendre: "en_cours",
  relancer: "en_cours",
  annuler: "annulee",
};

export function CockpitProvider({ children }: { children: ReactNode }) {
  const viewerId = useSyncExternalStore(
    subscribeViewer,
    getViewerSnapshot,
    getViewerServerSnapshot,
  );
  const [display, setDisplayState] = useState<DisplayState>("normal");
  const [missionPatches, setMissionPatches] = useState<Record<string, MissionPatch>>({});
  const [decisionPatches, setDecisionPatches] = useState<
    Record<string, Pick<Decision, "state" | "resolvedAt" | "resolvedById">>
  >({});
  const [createdMissions, setCreatedMissions] = useState<Mission[]>([]);
  const [journal, setJournal] = useState<JournalEntry[]>([]);

  // Le rôle choisi survit à un rechargement. Il est lu dans un store externe, pas
  // dans un effet : le rendu serveur et le premier rendu client restent identiques.
  const setViewer = useCallback((id: PersonId) => {
    writeViewer(id);
  }, []);

  const setDisplay = useCallback((state: DisplayState) => {
    setDisplayState(state);
  }, []);

  const pushJournal = useCallback((message: string, tone: JournalEntry["tone"]) => {
    const entry: JournalEntry = {
      id: nextId("journal"),
      at: DEMO_NOW_ISO,
      message,
      tone,
    };
    setJournal((entries) => [entry, ...entries].slice(0, 4));
  }, []);

  const dismissJournalEntry = useCallback((id: string) => {
    setJournal((entries) => entries.filter((entry) => entry.id !== id));
  }, []);

  const viewer = useMemo(
    () => people.find((person) => person.id === viewerId) ?? people[0],
    [viewerId],
  );

  /** Les fixtures, augmentées de ce que la démonstration a fait bouger. */
  const liveData = useMemo<Dataset>(() => {
    const patchedMissions = [...createdMissions, ...baseMissions].map((mission) => {
      const patch = missionPatches[mission.id];
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

    const patchedDecisions = baseDataset.decisions.map((decision) => {
      const patch = decisionPatches[decision.id];
      return patch ? { ...decision, ...patch } : decision;
    });

    return {
      ...baseDataset,
      missions: patchedMissions,
      decisions: patchedDecisions,
    };
  }, [createdMissions, missionPatches, decisionPatches]);

  // En « vide » comme en « erreur », rien n'est affiché : les compteurs doivent le dire
  // aussi, sinon l'en-tête annonce des éléments que l'écran ne montre pas.
  const data =
    display === "vide" || display === "erreur" ? emptyDataset : liveData;

  const controlMission = useCallback(
    (missionId: string, action: "suspendre" | "reprendre" | "relancer" | "annuler") => {
      const mission = [...createdMissions, ...baseMissions].find(
        (item) => item.id === missionId,
      );
      const status = MISSION_ACTION_STATUS[action];

      setMissionPatches((patches) => ({
        ...patches,
        [missionId]: {
          ...patches[missionId],
          status,
          activity: [
            {
              id: nextId("act"),
              at: DEMO_NOW_ISO,
              kind: action === "annuler" ? "decision" : "systeme",
              actor: viewer.name,
              message: `Mission ${MISSION_ACTION_LABEL[action]}.`,
              source: {
                system: "hermes",
                reference: `Hermes · mission ${mission?.reference ?? missionId}`,
                syncedAt: DEMO_NOW_ISO,
              },
            },
            ...(patches[missionId]?.activity ?? []),
          ],
        },
      }));

      pushJournal(
        `${mission?.title ?? "Mission"} — ${MISSION_ACTION_LABEL[action]}.`,
        action === "annuler" ? "danger" : "neutral",
      );
    },
    [createdMissions, pushJournal, viewer.name],
  );

  const resolveDecision = useCallback(
    (decisionId: string, approve: boolean) => {
      const decision = baseDataset.decisions.find((item) => item.id === decisionId);
      if (!decision) return;

      setDecisionPatches((patches) => ({
        ...patches,
        [decisionId]: {
          state: approve ? "approuvee" : "refusee",
          resolvedAt: DEMO_NOW_ISO,
          resolvedById: viewer.id,
        },
      }));

      // Refuser une prolongation ne tue pas la mission : elle continue jusqu'à sa
      // limite actuelle, puis s'arrête d'elle-même avec ce qu'elle a produit.
      const nextStatus: MissionStatus = approve
        ? "en_cours"
        : decision.kind === "prolongation"
          ? "en_cours"
          : "annulee";

      const prolonged = approve && decision.kind === "prolongation";

      setMissionPatches((patches) => ({
        ...patches,
        [decision.missionId]: {
          ...patches[decision.missionId],
          status: nextStatus,
          durationCapMin: prolonged ? 300 : patches[decision.missionId]?.durationCapMin,
          attemptsMax: prolonged ? 4 : patches[decision.missionId]?.attemptsMax,
          activity: [
            {
              id: nextId("act"),
              at: DEMO_NOW_ISO,
              kind: "decision",
              actor: viewer.name,
              message: approve
                ? `${decision.title} — approuvé.`
                : `${decision.title} — refusé.`,
              source: decision.source,
            },
            ...(patches[decision.missionId]?.activity ?? []),
          ],
        },
      }));

      pushJournal(
        approve ? `${decision.title} — approuvé.` : `${decision.title} — refusé.`,
        approve ? "success" : "danger",
      );
    },
    [pushJournal, viewer.id, viewer.name],
  );

  const sendInstruction = useCallback(
    (missionId: string, text: string) => {
      setMissionPatches((patches) => ({
        ...patches,
        [missionId]: {
          ...patches[missionId],
          activity: [
            {
              id: nextId("act"),
              at: DEMO_NOW_ISO,
              kind: "instruction",
              actor: viewer.name,
              message: text,
              source: {
                system: "hermes",
                reference: "Hermes · instruction",
                syncedAt: DEMO_NOW_ISO,
              },
            },
            ...(patches[missionId]?.activity ?? []),
          ],
        },
      }));
      pushJournal("Instruction transmise à la mission.", "neutral");
    },
    [pushJournal, viewer.name],
  );

  const createMission = useCallback(
    (draft: MissionDraft) => {
      const index = createdMissions.length + 1;
      const id = `m-new-${index}`;
      const mission: Mission = {
        id,
        reference: `M-${300 + index}`,
        title: draft.objective,
        summary:
          "Mission créée depuis le cockpit. Elle démarrera dès qu'un exécutant sera libre.",
        status: "en_attente",
        projectId: draft.projectId,
        ownerId: viewer.id,
        autonomy: draft.autonomy,
        lastActivityAt: DEMO_NOW_ISO,
        effort: draft.effort,
        progress: { done: 0, total: 1, unit: "étapes" },
        duration: { elapsedMin: 0, capMin: draft.durationMin },
        attempts: { current: 0, max: draft.maxAttempts },
        parallelAgents: 1,
        steps: [{ id: `${id}-s1`, label: "Préparer la mission", state: "todo" }],
        agents: [],
        activity: [
          {
            id: nextId("act"),
            at: DEMO_NOW_ISO,
            kind: "instruction",
            actor: viewer.name,
            message: draft.objective,
            source: {
              system: "hermes",
              reference: "Hermes · mise en file",
              syncedAt: DEMO_NOW_ISO,
            },
          },
        ],
        deliverableIds: [],
        decisionIds: [],
        diagnostics: [
          {
            at: DEMO_NOW_ISO,
            level: "info",
            scope: "file",
            message: `queued duration_cap=${draft.durationMin}min attempts_max=${draft.maxAttempts} effort=${draft.effort} autonomy=${draft.autonomy}`,
          },
        ],
        source: {
          system: "hermes",
          reference: `Hermes · mission ${300 + index}`,
          syncedAt: DEMO_NOW_ISO,
        },
      };

      setCreatedMissions((list) => [mission, ...list]);
      pushJournal(`Mission créée : ${draft.objective}`, "success");
      return id;
    },
    [createdMissions.length, pushJournal, viewer.id, viewer.name],
  );

  const value = useMemo<CockpitValue>(
    () => ({
      viewer,
      people,
      setViewer,
      display,
      setDisplay,
      data,
      hasError: display === "erreur",
      isLoading: display === "chargement",
      journal,
      dismissJournalEntry,
      controlMission,
      resolveDecision,
      sendInstruction,
      createMission,
    }),
    [
      viewer,
      setViewer,
      display,
      setDisplay,
      data,
      journal,
      dismissJournalEntry,
      controlMission,
      resolveDecision,
      sendInstruction,
      createMission,
    ],
  );

  return <CockpitContext.Provider value={value}>{children}</CockpitContext.Provider>;
}

export function useCockpit(): CockpitValue {
  const value = useContext(CockpitContext);
  if (!value) {
    throw new Error("useCockpit doit être utilisé à l'intérieur de CockpitProvider.");
  }
  return value;
}
