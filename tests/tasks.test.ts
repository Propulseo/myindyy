import { describe, expect, it } from "vitest";
import { can, canManageTask, canSeeTask, taskDenial } from "@/lib/access";
import {
  applyTasks,
  cockpitReducer,
  initialCockpitState,
  type TaskDraft,
} from "@/lib/cockpit-state";
import { baseDataset, visibleTasks } from "@/lib/selectors";
import { inHours, obsidianTasks, peopleById } from "@/fixtures";
import type { ObsidianTask, Person } from "@/types/domain";

const etienne = peopleById.etienne;
const lyes = peopleById.lyes;
const lucas = peopleById.lucas;

function task(id: string): ObsidianTask {
  const found = obsidianTasks.find((item) => item.id === id);
  if (!found) throw new Error(`Tâche ${id} absente des fixtures.`);
  return found;
}

function tasksFor(viewer: Person): ObsidianTask[] {
  return visibleTasks(baseDataset, viewer);
}

describe("périmètre des tâches", () => {
  it("ne montre aucune tâche personnelle à Lyes ni à Lucas", () => {
    for (const viewer of [lyes, lucas]) {
      const personal = tasksFor(viewer).filter(
        (item) => item.visibility === "personnelle",
      );
      expect(personal).toEqual([]);
      expect(can(viewer, "tasks.personal.view")).toBe(false);
    }
  });

  it("montre ses tâches personnelles au propriétaire", () => {
    const personal = tasksFor(etienne).filter(
      (item) => item.visibility === "personnelle",
    );
    expect(personal.length).toBeGreaterThan(0);
    expect(personal.every((item) => item.ownerId === "etienne")).toBe(true);
  });

  it("garde invisibles les tâches d'un projet non affecté", () => {
    // DocAgora n'est affecté qu'à Étienne : c'est le témoin.
    const docagora = tasksFor(lyes).concat(tasksFor(lucas)).filter(
      (item) => item.projectId === "docagora",
    );
    expect(docagora).toEqual([]);
    expect(tasksFor(etienne).some((item) => item.projectId === "docagora")).toBe(true);
  });

  it("laisse Lyes voir les tâches partagées de ses seuls projets", () => {
    const projects = new Set(tasksFor(lyes).map((item) => item.projectId));
    expect([...projects].every((id) => lyes.projectIds.includes(id!))).toBe(true);
    expect(projects.has("vernay")).toBe(false);
  });

  it("range les tâches closes en fin de liste sans les supprimer", () => {
    const list = tasksFor(lucas);
    const done = list.findIndex((item) => item.state === "fait");
    expect(done).toBeGreaterThan(-1);
    expect(list.slice(done).every((item) => item.state === "fait")).toBe(true);
  });
});

describe("permissions d'action sur une tâche", () => {
  it("autorise Étienne sur les tâches partagées comme personnelles", () => {
    expect(canManageTask(etienne, task("t-01"))).toBe(true);
    expect(canManageTask(etienne, task("t-07"))).toBe(true);
  });

  it("refuse à Lucas une tâche personnelle et une tâche hors périmètre", () => {
    expect(canManageTask(lucas, task("t-07"))).toBe(false);
    expect(canSeeTask(lucas, task("t-01"))).toBe(false);
    expect(canManageTask(lucas, task("t-01"))).toBe(false);
  });

  it("autorise Lucas sur les tâches partagées de ses projets", () => {
    expect(canManageTask(lucas, task("t-03"))).toBe(true);
    expect(taskDenial(lucas, task("t-03"))).toBeNull();
  });

  it("explique par écrit chaque refus", () => {
    expect(taskDenial(lyes, task("t-07"))).toBe(
      "Les tâches personnelles ne sont visibles que de leur propriétaire.",
    );
    expect(taskDenial(lyes, task("t-03"))).toBe(
      "Cette tâche appartient à un projet qui ne vous est pas affecté.",
    );
  });
});

describe("commandes de tâches simulées", () => {
  const draft: TaskDraft = {
    title: "Relancer le prestataire d'hébergement",
    projectId: "propulseo",
    ownerId: "lucas",
    dueAt: inHours(3),
    note: "Contrat à renouveler avant octobre.",
  };

  it("capture une tâche partagée avec sa provenance Hermes vers Obsidian", () => {
    const state = cockpitReducer(initialCockpitState, {
      type: "task.capture",
      actor: etienne,
      draft,
    });
    const [created] = applyTasks(state, obsidianTasks);

    expect(created.title).toBe(draft.title);
    expect(created.visibility).toBe("partagee");
    expect(created.state).toBe("a_faire");
    expect(created.source.system).toBe("hermes");
    expect(created.source.reference).toContain("todo.capture");
    expect(created.source.reference).toContain("Obsidian");
    expect(state.journal[0].message).toContain("todo.capture");
  });

  it("capture une tâche personnelle quand aucun projet n'est choisi", () => {
    const state = cockpitReducer(initialCockpitState, {
      type: "task.capture",
      actor: etienne,
      draft: { ...draft, projectId: undefined, ownerId: "etienne" },
    });
    const [created] = applyTasks(state, obsidianTasks);

    expect(created.visibility).toBe("personnelle");
    expect(canSeeTask(etienne, created)).toBe(true);
    expect(canSeeTask(lyes, created)).toBe(false);
    expect(canSeeTask(lucas, created)).toBe(false);
  });

  it("trie une tâche existante sans la dupliquer", () => {
    const before = task("t-04");
    const state = cockpitReducer(initialCockpitState, {
      type: "task.triage",
      actor: etienne,
      task: before,
      draft: { ...draft, title: "Préparer la trame, version courte" },
    });
    const after = applyTasks(state, obsidianTasks);

    expect(after).toHaveLength(obsidianTasks.length);
    const patched = after.find((item) => item.id === before.id)!;
    expect(patched.title).toBe("Préparer la trame, version courte");
    expect(patched.ownerId).toBe("lucas");
    expect(patched.source.reference).toContain("todo.triage");
  });

  it("termine une tâche", () => {
    const state = cockpitReducer(initialCockpitState, {
      type: "task.complete",
      actor: etienne,
      task: task("t-01"),
    });
    const patched = applyTasks(state, obsidianTasks).find(
      (item) => item.id === "t-01",
    )!;

    expect(patched.state).toBe("fait");
    expect(patched.source.reference).toContain("todo.complete");
  });

  it("conserve une tâche annulée, avec un statut écrit", () => {
    const state = cockpitReducer(initialCockpitState, {
      type: "task.cancel",
      actor: etienne,
      task: task("t-01"),
    });
    const list = applyTasks(state, obsidianTasks);
    const patched = list.find((item) => item.id === "t-01")!;

    expect(list).toHaveLength(obsidianTasks.length);
    expect(patched.state).toBe("annulee");
    expect(patched.source.reference).toContain("todo.cancel");
    expect(
      visibleTasks({ ...baseDataset, tasks: list }, etienne).some(
        (item) => item.id === "t-01",
      ),
    ).toBe(true);
  });
});
