/**
 * Le réducteur est le point de passage de toute mutation. L'interface filtre déjà
 * ce qu'elle propose, mais un appel direct au contexte contournerait ce filtrage :
 * ces tests appellent donc `cockpitReducer` sans passer par un composant.
 */
import { describe, expect, it } from "vitest";
import {
  applyDecisions,
  applyMissions,
  applyTasks,
  cockpitReducer,
  initialCockpitState,
  TASK_CANCEL_CONSEQUENCE,
  TASK_COMMAND_DENIED,
  type CockpitAction,
  type CockpitState,
  type TaskDraft,
} from "@/lib/cockpit-state";
import { authorizeTaskCommand, taskDenialMessage } from "@/lib/access";
import { baseDataset, visibleTasks } from "@/lib/selectors";
import { decisions, inHours, missions, obsidianTasks, peopleById } from "@/fixtures";
import { taskStateMeta } from "@/lib/status";
import type { ObsidianTask } from "@/types/domain";

const etienne = peopleById.etienne;
const lyes = peopleById.lyes;
const lucas = peopleById.lucas;

function task(id: string): ObsidianTask {
  const found = obsidianTasks.find((item) => item.id === id);
  if (!found) throw new Error(`Tâche ${id} absente des fixtures.`);
  return found;
}

const baseDraft: Omit<TaskDraft, "projectId" | "ownerId"> = {
  title: "Vérifier le renouvellement du certificat",
  dueAt: inHours(3),
};

/** Joue une commande sur l'état initial et rend tout ce qu'elle a pu toucher. */
function run(action: CockpitAction) {
  const after = cockpitReducer(initialCockpitState, action);
  return {
    state: after,
    tasks: applyTasks(after, obsidianTasks),
    missions: applyMissions(after, missions),
    decisions: applyDecisions(after, decisions),
  };
}

/** Une commande refusée ne laisse qu'une ligne de journal générique. */
function expectRefused(after: CockpitState) {
  expect(after.createdTasks).toEqual([]);
  expect(after.taskPatches).toEqual({});
  expect(after.createdMissions).toEqual([]);
  expect(after.missionPatches).toEqual({});
  expect(after.decisionPatches).toEqual({});
  expect(after.journal).toHaveLength(1);
  expect(after.journal[0].message).toBe(TASK_COMMAND_DENIED);
  expect(after.journal[0].tone).toBe("danger");
}

describe("commandes de tâches refusées par le réducteur", () => {
  it("Lucas ne peut pas terminer une tâche personnelle d'Étienne", () => {
    const personal = task("t-07");
    const { state, tasks } = run({
      type: "task.complete",
      actor: lucas,
      task: personal,
    });

    expectRefused(state);
    expect(tasks.find((item) => item.id === personal.id)?.state).toBe(personal.state);
  });

  it("Lyes ne peut pas annuler une tâche Vernay, hors de son périmètre", () => {
    const vernay = task("t-03");
    expect(lyes.projectIds).not.toContain("vernay");

    const { state, tasks } = run({ type: "task.cancel", actor: lyes, task: vernay });

    expectRefused(state);
    expect(tasks.find((item) => item.id === vernay.id)?.state).toBe("a_faire");
  });

  it("Lucas ne peut pas capturer une tâche sur DocAgora, projet non affecté", () => {
    const { state } = run({
      type: "task.capture",
      actor: lucas,
      draft: { ...baseDraft, projectId: "docagora", ownerId: "lucas" },
    });

    expectRefused(state);
  });

  it("Lyes ne peut pas capturer une tâche personnelle", () => {
    const { state } = run({
      type: "task.capture",
      actor: lyes,
      draft: { ...baseDraft, projectId: undefined, ownerId: "lyes" },
    });

    expectRefused(state);
  });

  it("Lyes ne peut pas transformer une tâche partagée en tâche personnelle", () => {
    const shared = task("t-01");
    const { state } = run({
      type: "task.triage",
      actor: lyes,
      task: shared,
      draft: { ...baseDraft, projectId: undefined, ownerId: "lyes" },
    });

    expectRefused(state);
  });

  it("personne ne peut affecter une tâche à quelqu'un qui n'est pas du projet", () => {
    // Lyes n'est pas membre de Vernay Immobilier.
    const { state } = run({
      type: "task.capture",
      actor: etienne,
      draft: { ...baseDraft, projectId: "vernay", ownerId: "lyes" },
    });

    expectRefused(state);
    expect(
      authorizeTaskCommand(etienne, "todo.capture", {
        target: { projectId: "vernay", ownerId: "lyes" },
      }).reason,
    ).toBe("membership");
  });

  it("Étienne ne peut pas confier sa tâche personnelle à quelqu'un d'autre", () => {
    const { state } = run({
      type: "task.triage",
      actor: etienne,
      task: task("t-07"),
      draft: { ...baseDraft, projectId: undefined, ownerId: "lyes" },
    });

    expectRefused(state);
  });

  it("un rôle sans « tasks.manage » ne passe aucune commande", () => {
    const spectateur = { ...lucas, capabilities: [] };
    const { state } = run({
      type: "task.complete",
      actor: spectateur,
      task: task("t-03"),
    });

    expectRefused(state);
    expect(
      authorizeTaskCommand(spectateur, "todo.complete", { task: task("t-03") }).reason,
    ).toBe("capability");
  });
});

describe("commandes de tâches acceptées par le réducteur", () => {
  it("Étienne gère sa tâche personnelle", () => {
    const personal = task("t-07");
    const { state, tasks } = run({
      type: "task.complete",
      actor: etienne,
      task: personal,
    });

    expect(tasks.find((item) => item.id === personal.id)?.state).toBe("fait");
    expect(state.journal[0].message).toContain("todo.complete");
  });

  it("Étienne capture une tâche personnelle pour lui-même", () => {
    const { state, tasks } = run({
      type: "task.capture",
      actor: etienne,
      draft: { ...baseDraft, projectId: undefined, ownerId: "etienne" },
    });

    expect(state.createdTasks).toHaveLength(1);
    expect(tasks[0].visibility).toBe("personnelle");
    expect(tasks[0].ownerId).toBe("etienne");
  });

  it("Lyes gère une tâche partagée d'un projet qui lui est affecté", () => {
    const tao = task("t-01");
    expect(lyes.projectIds).toContain("tao");

    const { state, tasks } = run({ type: "task.cancel", actor: lyes, task: tao });

    expect(tasks.find((item) => item.id === tao.id)?.state).toBe("annulee");
    expect(state.journal[0].message).toContain("todo.cancel");
  });

  it("Lucas gère une tâche partagée d'un projet qui lui est affecté", () => {
    const vernay = task("t-03");
    expect(lucas.projectIds).toContain("vernay");

    const { tasks } = run({ type: "task.complete", actor: lucas, task: vernay });

    expect(tasks.find((item) => item.id === vernay.id)?.state).toBe("fait");
  });

  it("Lucas trie une tâche Propul'SEO vers un membre du projet", () => {
    const partagee = task("t-04");
    const { tasks } = run({
      type: "task.triage",
      actor: lucas,
      task: partagee,
      draft: { ...baseDraft, projectId: "propulseo", ownerId: "lyes" },
    });

    const patched = tasks.find((item) => item.id === partagee.id);
    expect(patched?.ownerId).toBe("lyes");
    expect(patched?.visibility).toBe("partagee");
  });
});

describe("texte d'annulation d'une tâche", () => {
  it("décrit ce que l'interface fait vraiment : la tâche reste affichée", () => {
    const cible = task("t-03");
    const { tasks } = run({ type: "task.cancel", actor: lucas, task: cible });
    const annulee = tasks.find((item) => item.id === cible.id);

    // Ce que le panneau annonce.
    expect(TASK_CANCEL_CONSEQUENCE).toContain("marquer la tâche comme annulée");
    expect(TASK_CANCEL_CONSEQUENCE).toContain("n'est pas supprimée");
    expect(TASK_CANCEL_CONSEQUENCE).toContain("reste affichée");
    expect(TASK_CANCEL_CONSEQUENCE).toContain("« Annulée »");
    expect(TASK_CANCEL_CONSEQUENCE).not.toContain("sort de la journée");

    // Ce que l'interface fait.
    expect(annulee?.state).toBe("annulee");
    expect(taskStateMeta.annulee.label).toBe("Annulée");
    expect(annulee?.title).toBe(cible.title);
    expect(annulee?.projectId).toBe(cible.projectId);
    expect(annulee?.ownerId).toBe(cible.ownerId);
    expect(annulee?.dueAt).toBe(cible.dueAt);
    expect(annulee?.source.reference).toContain("Obsidian");
    expect(
      visibleTasks({ ...baseDataset, tasks }, lucas).some(
        (item) => item.id === cible.id,
      ),
    ).toBe(true);
  });

  it("dit la même chose dans le journal", () => {
    const { state } = run({ type: "task.cancel", actor: lucas, task: task("t-03") });

    expect(state.journal[0].message).toContain("marquée annulée");
    expect(state.journal[0].message).toContain("conservée dans la journée");
  });
});

describe("règle d'autorisation partagée", () => {
  it("rend une raison écrite pour chaque refus", () => {
    expect(taskDenialMessage.capability).toContain("ne permet pas");
    expect(taskDenialMessage.personal).toContain("personnelles");
    expect(taskDenialMessage.project).toContain("pas affecté");
    expect(taskDenialMessage.membership).toContain("membre du projet");
  });

  it("refuse une commande sans cible ni destination", () => {
    expect(authorizeTaskCommand(etienne, "todo.complete", {}).allowed).toBe(false);
  });
});
