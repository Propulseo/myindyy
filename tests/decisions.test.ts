import { describe, expect, it } from "vitest";
import {
  applyDecisions,
  applyMissions,
  cockpitReducer,
  initialCockpitState,
  PROLONGATION_EXTRA_ATTEMPTS,
  PROLONGATION_EXTRA_MIN,
  refusalOutcome,
} from "@/lib/cockpit-state";
import { decisions, missions, peopleById } from "@/fixtures";
import type { Decision, Mission } from "@/types/domain";

const etienne = peopleById.etienne;

function mission(id: string): Mission {
  const found = missions.find((item) => item.id === id);
  if (!found) throw new Error(`Mission ${id} absente des fixtures.`);
  return found;
}

function decision(id: string): Decision {
  const found = decisions.find((item) => item.id === id);
  if (!found) throw new Error(`Décision ${id} absente des fixtures.`);
  return found;
}

/** Résout une décision et renvoie la mission et la décision telles qu'affichées. */
function resolve(decisionId: string, approve: boolean) {
  const target = decision(decisionId);
  const before = mission(target.missionId);
  const state = cockpitReducer(initialCockpitState, {
    type: "decision.resolve",
    actor: etienne,
    decision: target,
    mission: before,
    approve,
  });
  return {
    state,
    before,
    mission: applyMissions(state, missions).find(
      (item) => item.id === target.missionId,
    )!,
    decision: applyDecisions(state, decisions).find((item) => item.id === decisionId)!,
  };
}

describe("refus d'une décision sensible", () => {
  it("ne met plus la mission à « annulée » quand on refuse un déploiement", () => {
    const { mission: after, decision: resolved } = resolve("dec-01", false);

    expect(resolved.state).toBe("refusee");
    expect(after.status).not.toBe("annulee");
    expect(after.status).toBe("en_attente");
  });

  it("conserve les étapes et les livrables de la mission refusée", () => {
    const { before, mission: after } = resolve("dec-01", false);

    expect(after.steps).toEqual(before.steps);
    expect(after.deliverableIds).toEqual(before.deliverableIds);
    expect(after.progress).toEqual(before.progress);
  });

  it("n'annule pas non plus une publication ni une communication externe", () => {
    for (const id of ["dec-02", "dec-03"]) {
      const { mission: after, decision: resolved } = resolve(id, false);
      expect(resolved.state).toBe("refusee");
      expect(after.status).toBe("en_attente");
    }
  });

  it("écrit un évènement d'activité et un message de journal explicites", () => {
    const { state, mission: after } = resolve("dec-01", false);

    const event = after.activity[0];
    expect(event.kind).toBe("decision");
    expect(event.actor).toBe(etienne.name);
    expect(event.message).toContain("refusé");
    expect(event.message).toContain("n'est pas annulée");

    expect(state.journal[0].tone).toBe("danger");
    expect(state.journal[0].message).toContain(
      "La mission passe en attente d'une nouvelle instruction.",
    );
  });

  it("laisse une prolongation refusée continuer avec ses limites existantes", () => {
    const { before, mission: after, decision: resolved } = resolve("dec-04", false);

    expect(resolved.state).toBe("refusee");
    expect(after.status).toBe("en_cours");
    expect(after.duration.capMin).toBe(before.duration.capMin);
    expect(after.attempts.max).toBe(before.attempts.max);
  });

  it("nomme les limites conservées dans la conséquence d'un refus de prolongation", () => {
    const outcome = refusalOutcome(decision("dec-04"), mission("m-251"));

    expect(outcome.status).toBe("en_cours");
    expect(outcome.consequence).toContain("4 h");
    expect(outcome.consequence).toContain("3 tentatives");
  });
});

describe("approbation d'une décision", () => {
  it("ajoute une heure et une tentative quand on approuve une prolongation", () => {
    const { before, mission: after, decision: resolved } = resolve("dec-04", true);

    expect(resolved.state).toBe("approuvee");
    expect(after.duration.capMin).toBe(before.duration.capMin + PROLONGATION_EXTRA_MIN);
    expect(after.attempts.max).toBe(
      before.attempts.max + PROLONGATION_EXTRA_ATTEMPTS,
    );
    expect(after.status).toBe("en_cours");
  });

  it("ne touche pas aux garde-fous quand la décision n'est pas une prolongation", () => {
    const { before, mission: after } = resolve("dec-01", true);

    expect(after.duration.capMin).toBe(before.duration.capMin);
    expect(after.attempts.max).toBe(before.attempts.max);
  });
});

describe("annulation d'une mission", () => {
  it("reste une action séparée qui, elle, met la mission à « annulée »", () => {
    const target = mission("m-248");
    const state = cockpitReducer(initialCockpitState, {
      type: "mission.control",
      actor: etienne,
      mission: target,
      action: "annuler",
    });
    const after = applyMissions(state, missions).find((item) => item.id === target.id)!;

    expect(after.status).toBe("annulee");
    expect(after.steps).toEqual(target.steps);
  });
});
