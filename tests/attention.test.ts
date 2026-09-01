import { describe, expect, it } from "vitest";
import {
  DUE_SOON_MIN,
  STALE_AFTER_MIN,
  attentionItems,
  baseDataset,
  isStalled,
  pulseSnapshot,
  type Dataset,
} from "@/lib/selectors";
import { DEMO_NOW_ISO, inMinutes, minutesAgo, peopleById } from "@/fixtures";
import type { Mission } from "@/types/domain";

const etienne = peopleById.etienne;
const lucas = peopleById.lucas;

/** Une mission minimale, pour n'exercer qu'une règle à la fois. */
function baseMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "m-test",
    reference: "M-TEST",
    title: "Mission de vérification",
    summary: "Sert uniquement aux tests.",
    status: "en_cours",
    projectId: "propulseo",
    ownerId: "etienne",
    autonomy: "encadree",
    effort: "standard",
    lastActivityAt: DEMO_NOW_ISO,
    progress: { done: 1, total: 4, unit: "étapes" },
    duration: { elapsedMin: 10, capMin: 240 },
    attempts: { current: 1, max: 3 },
    parallelAgents: 1,
    steps: [],
    agents: [],
    activity: [],
    deliverableIds: [],
    decisionIds: [],
    diagnostics: [],
    source: { system: "hermes", reference: "Hermes · test", syncedAt: DEMO_NOW_ISO },
    ...overrides,
  };
}

/** Un jeu de données réduit aux seules missions passées en argument. */
function only(missions: Mission[]): Dataset {
  return {
    ...baseDataset,
    missions,
    decisions: [],
    automations: [],
    deliverables: [],
    tasks: [],
  };
}

describe("inactivité", () => {
  it("ne signale rien juste avant le seuil", () => {
    const mission = baseMission({
      lastActivityAt: minutesAgo(STALE_AFTER_MIN - 1),
    });
    expect(isStalled(mission)).toBe(false);
    expect(attentionItems(only([mission]), etienne)).toEqual([]);
  });

  it("remonte une mission inactive dès le seuil, en ton danger", () => {
    const mission = baseMission({ lastActivityAt: minutesAgo(STALE_AFTER_MIN) });
    expect(isStalled(mission)).toBe(true);

    const [item] = attentionItems(only([mission]), etienne);
    expect(item.kind).toBe("inactivite");
    expect(item.tone).toBe("danger");
    expect(item.headline).toContain("Mission inactive");
  });

  it("ne compte pas une mission inactive parmi les actives du Pouls", () => {
    const active = baseMission({ id: "m-active", lastActivityAt: minutesAgo(2) });
    const stalled = baseMission({
      id: "m-stalled",
      lastActivityAt: minutesAgo(STALE_AFTER_MIN + 30),
    });

    const pulse = pulseSnapshot(only([active, stalled]), etienne);
    expect(pulse.active).toBe(1);
    expect(pulse.incidents).toBe(1);
  });
});

describe("échéances", () => {
  it("ne signale rien au-delà de la fenêtre", () => {
    const mission = baseMission({ dueAt: inMinutes(DUE_SOON_MIN + 30) });
    expect(attentionItems(only([mission]), etienne)).toEqual([]);
  });

  it("écrit une attention quand l'échéance tombe dans moins d'une heure", () => {
    const mission = baseMission({ dueAt: inMinutes(DUE_SOON_MIN - 20) });

    const [item] = attentionItems(only([mission]), etienne);
    expect(item.kind).toBe("echeance");
    expect(item.tone).toBe("attention");
    expect(item.headline).toContain("Échéance proche");
  });

  it("écrit un incident en ton danger quand l'échéance est dépassée", () => {
    const mission = baseMission({ dueAt: minutesAgo(25) });

    const [item] = attentionItems(only([mission]), etienne);
    expect(item.kind).toBe("echeance");
    expect(item.tone).toBe("danger");
    expect(item.headline).toContain("Échéance dépassée");
    expect(item.detail).toContain("dépassée de 25 min");
  });

  it("ignore l'échéance d'une mission close", () => {
    const mission = baseMission({ status: "terminee", dueAt: minutesAgo(25) });
    expect(attentionItems(only([mission]), etienne)).toEqual([]);
  });

  it("ne produit pas de seconde ligne quand la mission remonte déjà pour plus urgent", () => {
    const mission = baseMission({
      status: "bloquee",
      dueAt: minutesAgo(25),
      lastActivityAt: minutesAgo(30),
    });

    const items = attentionItems(only([mission]), etienne);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("blocage");
    // L'échéance n'est pas perdue pour autant : elle est rappelée sur la ligne.
    expect(items[0].detail).toContain("Échéance dépassée de 25 min");
  });
});

describe("remontées sur les données de démonstration", () => {
  it("montre l'échéance dépassée de M-250 à Étienne comme à Lucas", () => {
    for (const viewer of [etienne, lucas]) {
      const item = attentionItems(baseDataset, viewer).find(
        (entry) => entry.missionId === "m-250",
      );
      expect(item?.kind).toBe("echeance");
      expect(item?.tone).toBe("danger");
    }
  });

  it("garde l'échéance de M-252 pour le seul rôle à qui DocAgora est affecté", () => {
    const forEtienne = attentionItems(baseDataset, etienne).find(
      (entry) => entry.missionId === "m-252",
    );
    expect(forEtienne?.kind).toBe("echeance");
    expect(forEtienne?.tone).toBe("attention");

    expect(
      attentionItems(baseDataset, lucas).some((entry) => entry.missionId === "m-252"),
    ).toBe(false);
  });

  it("ne remonte chaque mission qu'une seule fois", () => {
    for (const viewer of [etienne, lucas]) {
      const ids = attentionItems(baseDataset, viewer)
        .map((item) => item.missionId)
        .filter((id): id is string => id !== undefined);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
