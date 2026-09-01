import { describe, expect, it } from "vitest";
import {
  applyMissions,
  cockpitReducer,
  initialCockpitState,
  type MissionDraft,
} from "@/lib/cockpit-state";
import { visibleMissions, visibleProjects } from "@/lib/selectors";
import { baseDataset } from "@/lib/selectors";
import { DEMO_NOW_ISO, inHours, peopleById, projects } from "@/fixtures";
import { isoFromLocalInput, localInputFromIso } from "@/lib/format";

const etienne = peopleById.etienne;
const lyes = peopleById.lyes;
const lucas = peopleById.lucas;

const draft: MissionDraft = {
  objective: "Auditer les pages publiques et proposer un plan de correction",
  projectId: "propulseo",
  templateId: null,
  durationMin: 180,
  maxAttempts: 2,
  parallelAgents: 3,
  dueAt: inHours(6),
  effort: "standard",
  autonomy: "encadree",
};

function create(overrides: Partial<MissionDraft> = {}) {
  const state = cockpitReducer(initialCockpitState, {
    type: "mission.create",
    actor: etienne,
    draft: { ...draft, ...overrides },
  });
  return { state, mission: state.createdMissions[0] };
}

describe("création d'une mission", () => {
  it("conserve le nombre d'agents en parallèle et l'échéance", () => {
    const { mission } = create();

    expect(mission.parallelAgents).toBe(3);
    expect(mission.dueAt).toBe(inHours(6));
  });

  it("accepte une mission sans échéance", () => {
    const { mission } = create({ dueAt: undefined });

    expect(mission.dueAt).toBeUndefined();
    expect(mission.parallelAgents).toBe(3);
  });

  it("reporte les garde-fous dans le journal d'exécution", () => {
    const { mission } = create({ parallelAgents: 1, dueAt: undefined });

    expect(mission.diagnostics[0].message).toContain("parallel_agents=1");
    expect(mission.diagnostics[0].message).toContain("due_at=aucune");
    expect(mission.duration.capMin).toBe(180);
    expect(mission.attempts.max).toBe(2);
  });

  it("rend la mission créée visible dans le jeu de données", () => {
    const { state, mission } = create();
    const all = applyMissions(state, baseDataset.missions);

    expect(all[0].id).toBe(mission.id);
    expect(all).toHaveLength(baseDataset.missions.length + 1);
  });
});

describe("saisie d'une échéance", () => {
  it("relit une date et une heure comme une heure de Paris", () => {
    // 1er septembre 2026, 18 h 00 à Paris = 16 h 00 UTC (heure d'été).
    expect(isoFromLocalInput("2026-09-01T18:00")).toBe("2026-09-01T16:00:00.000Z");
  });

  it("fait l'aller-retour sans dériver", () => {
    expect(localInputFromIso(DEMO_NOW_ISO)).toBe("2026-09-01T14:20");
    expect(isoFromLocalInput(localInputFromIso(DEMO_NOW_ISO))).toBe(DEMO_NOW_ISO);
  });

  it("refuse une saisie incomplète plutôt que d'inventer une date", () => {
    expect(isoFromLocalInput("")).toBeUndefined();
    expect(isoFromLocalInput("2026-09-01")).toBeUndefined();
  });
});

describe("périmètre des projets", () => {
  it("cache complètement un projet non affecté", () => {
    for (const viewer of [lyes, lucas]) {
      const visible = visibleProjects(baseDataset, viewer).map((item) => item.id);
      expect(visible).not.toContain("docagora");
      expect(visible).toEqual(viewer.projectIds.filter((id) => visible.includes(id)));
    }
    expect(visibleProjects(baseDataset, etienne)).toHaveLength(projects.length);
  });

  it("cache aussi les missions des projets non affectés", () => {
    const forLucas = visibleMissions(baseDataset, lucas);
    expect(forLucas.some((mission) => mission.projectId === "docagora")).toBe(false);
    expect(forLucas.some((mission) => mission.projectId === "tao")).toBe(false);
    expect(forLucas.every((mission) => lucas.projectIds.includes(mission.projectId))).toBe(
      true,
    );
  });
});
