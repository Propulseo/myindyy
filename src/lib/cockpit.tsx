"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Decision, ObsidianTask, Person, PersonId } from "@/types/domain";
import { people } from "@/fixtures";
import {
  applyDecisions,
  applyMissions,
  applyTasks,
  cockpitReducer,
  initialCockpitState,
  type JournalEntry,
  type MissionControl,
  type MissionDraft,
  type TaskDraft,
} from "./cockpit-state";
import { baseDataset, emptyDataset, type Dataset } from "./selectors";
import {
  getViewerServerSnapshot,
  getViewerSnapshot,
  subscribeViewer,
  writeViewer,
} from "./viewer-store";

export type {
  JournalEntry,
  MissionControl,
  MissionDraft,
  TaskDraft,
} from "./cockpit-state";

/** Ce que la démonstration peut mettre à l'écran, pour montrer les états dessinés. */
export type DisplayState = "normal" | "chargement" | "vide" | "erreur";

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
  controlMission: (missionId: string, action: MissionControl) => void;
  resolveDecision: (decisionId: string, approve: boolean) => void;
  sendInstruction: (missionId: string, text: string) => void;
  createMission: (draft: MissionDraft) => string;
  /** Les quatre commandes de tâches, simulées : rien ne part réellement vers Hermes. */
  captureTask: (draft: TaskDraft) => void;
  triageTask: (task: ObsidianTask, draft: TaskDraft) => void;
  completeTask: (task: ObsidianTask) => void;
  cancelTask: (task: ObsidianTask) => void;
}

const CockpitContext = createContext<CockpitValue | null>(null);

export function CockpitProvider({ children }: { children: ReactNode }) {
  const viewerId = useSyncExternalStore(
    subscribeViewer,
    getViewerSnapshot,
    getViewerServerSnapshot,
  );
  const [display, setDisplayState] = useState<DisplayState>("normal");
  const [state, dispatch] = useReducer(cockpitReducer, initialCockpitState);

  // Le rôle choisi survit à un rechargement. Il est lu dans un store externe, pas
  // dans un effet : le rendu serveur et le premier rendu client restent identiques.
  const setViewer = useCallback((id: PersonId) => {
    writeViewer(id);
  }, []);

  const setDisplay = useCallback((next: DisplayState) => {
    setDisplayState(next);
  }, []);

  const viewer = useMemo(
    () => people.find((person) => person.id === viewerId) ?? people[0],
    [viewerId],
  );

  /** Les fixtures, augmentées de ce que la démonstration a fait bouger. */
  const liveData = useMemo<Dataset>(
    () => ({
      ...baseDataset,
      missions: applyMissions(state, baseDataset.missions),
      decisions: applyDecisions(state, baseDataset.decisions),
      tasks: applyTasks(state, baseDataset.tasks),
    }),
    [state],
  );

  // En « vide » comme en « erreur », rien n'est affiché : les compteurs doivent le dire
  // aussi, sinon l'en-tête annonce des éléments que l'écran ne montre pas.
  const data = display === "vide" || display === "erreur" ? emptyDataset : liveData;

  const findMission = useCallback(
    (missionId: string) => liveData.missions.find((item) => item.id === missionId),
    [liveData],
  );

  const dismissJournalEntry = useCallback((id: string) => {
    dispatch({ type: "journal.dismiss", id });
  }, []);

  const controlMission = useCallback(
    (missionId: string, action: MissionControl) => {
      const mission = findMission(missionId);
      if (!mission) return;
      dispatch({ type: "mission.control", actor: viewer, mission, action });
    },
    [findMission, viewer],
  );

  const resolveDecision = useCallback(
    (decisionId: string, approve: boolean) => {
      const decision: Decision | undefined = liveData.decisions.find(
        (item) => item.id === decisionId,
      );
      if (!decision) return;
      dispatch({
        type: "decision.resolve",
        actor: viewer,
        decision,
        mission: findMission(decision.missionId),
        approve,
      });
    },
    [findMission, liveData.decisions, viewer],
  );

  const sendInstruction = useCallback(
    (missionId: string, text: string) => {
      const mission = findMission(missionId);
      if (!mission) return;
      dispatch({ type: "mission.instruct", actor: viewer, mission, text });
    },
    [findMission, viewer],
  );

  // L'identifiant est calculé ici et pas dans le réducteur : l'appelant en a besoin
  // tout de suite, pour ouvrir la mission qu'il vient de créer.
  const createdCount = state.createdMissions.length;
  const createMission = useCallback(
    (draft: MissionDraft) => {
      dispatch({ type: "mission.create", actor: viewer, draft });
      return `m-new-${createdCount + 1}`;
    },
    [createdCount, viewer],
  );

  const captureTask = useCallback(
    (draft: TaskDraft) => {
      dispatch({ type: "task.capture", actor: viewer, draft });
    },
    [viewer],
  );

  const triageTask = useCallback(
    (task: ObsidianTask, draft: TaskDraft) => {
      dispatch({ type: "task.triage", actor: viewer, task, draft });
    },
    [viewer],
  );

  const completeTask = useCallback(
    (task: ObsidianTask) => {
      dispatch({ type: "task.complete", actor: viewer, task });
    },
    [viewer],
  );

  const cancelTask = useCallback(
    (task: ObsidianTask) => {
      dispatch({ type: "task.cancel", actor: viewer, task });
    },
    [viewer],
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
      journal: state.journal,
      dismissJournalEntry,
      controlMission,
      resolveDecision,
      sendInstruction,
      createMission,
      captureTask,
      triageTask,
      completeTask,
      cancelTask,
    }),
    [
      viewer,
      setViewer,
      display,
      setDisplay,
      data,
      state.journal,
      dismissJournalEntry,
      controlMission,
      resolveDecision,
      sendInstruction,
      createMission,
      captureTask,
      triageTask,
      completeTask,
      cancelTask,
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
