import type { Person } from "@/types/domain";
import { hoursAgo } from "./clock";

/**
 * Les trois rôles du prototype. Les permissions sont déclaratives : l'interface
 * n'affiche jamais une action qu'un rôle n'a pas, et n'affiche jamais un projet
 * qui ne lui est pas affecté.
 */
export const people: Person[] = [
  {
    id: "etienne",
    name: "Étienne Guimbard",
    initials: "EG",
    role: "Propriétaire",
    roleSummary:
      "Accès complet. Voit tous les projets, les tâches personnelles et les sources connectées.",
    capabilities: [
      "missions.create",
      "missions.control",
      "missions.cancel",
      "missions.approve",
      "deploy.production",
      "comms.external.send",
      "limits.override",
      "secrets.view",
      "tasks.personal.view",
      "projects.viewAll",
    ],
    projectIds: [],
    source: { system: "erp", reference: "ERP · membre 001", syncedAt: hoursAgo(2) },
  },
  {
    id: "lyes",
    name: "Lyes Benali",
    initials: "LB",
    role: "Développeur",
    roleSummary:
      "Projets techniques affectés uniquement. Contrôle ses missions, déploie en production, publie pour ses projets.",
    capabilities: [
      "missions.create",
      "missions.control",
      "missions.cancel",
      "missions.approve",
      "deploy.production",
      "comms.external.send",
    ],
    projectIds: ["propulseo", "tao", "coproflex", "ocean"],
    source: { system: "erp", reference: "ERP · membre 014", syncedAt: hoursAgo(2) },
  },
  {
    id: "lucas",
    name: "Lucas Marchand",
    initials: "LM",
    role: "Business developer",
    roleSummary:
      "Projets et leads commerciaux affectés uniquement. Contrôle ses missions, approuve et envoie les communications externes.",
    capabilities: [
      "missions.create",
      "missions.control",
      "missions.cancel",
      "missions.approve",
      "comms.external.send",
    ],
    projectIds: ["propulseo", "vernay"],
    source: { system: "erp", reference: "ERP · membre 021", syncedAt: hoursAgo(2) },
  },
];

export const peopleById: Record<string, Person> = Object.fromEntries(
  people.map((person) => [person.id, person]),
);
