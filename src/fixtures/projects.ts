import type { Project } from "@/types/domain";
import { hoursAgo, minutesAgo } from "./clock";

/**
 * Cinq projets techniques et un projet client commercial : de quoi vérifier que les
 * différences de permissions se voient réellement à l'écran.
 *
 * DocAgora n'est affecté qu'à Étienne : c'est le témoin qui prouve qu'un projet non
 * affecté disparaît complètement de l'interface des autres rôles.
 *
 * L'activité des agents d'un projet n'est pas stockée ici : elle est recalculée à
 * partir des missions affichées, pour ne jamais pouvoir les contredire.
 */
export const projects: Project[] = [
  {
    id: "propulseo",
    name: "Propul'SEO",
    kind: "interne",
    domain: "technique",
    summary:
      "Site et acquisition de l'agence. Veille technique, contenus, suivi de performance.",
    ownerId: "etienne",
    memberIds: ["etienne", "lyes", "lucas"],
    connectedSources: ["obsidian", "erp", "hermes", "github", "coolify"],
    source: { system: "erp", reference: "ERP · projet P-001", syncedAt: minutesAgo(24) },
  },
  {
    id: "tao",
    name: "Tao",
    kind: "produit",
    domain: "technique",
    summary:
      "Application de gestion du temps pour indépendants. Refonte de l'acquisition en cours.",
    ownerId: "lyes",
    memberIds: ["etienne", "lyes"],
    connectedSources: ["obsidian", "erp", "hermes", "github", "coolify"],
    source: { system: "erp", reference: "ERP · projet P-004", syncedAt: minutesAgo(24) },
  },
  {
    id: "coproflex",
    name: "CoProFlex",
    kind: "produit",
    domain: "technique",
    summary:
      "Plateforme de gestion de copropriété. Landing de lancement et synchronisation des lots.",
    ownerId: "lyes",
    memberIds: ["etienne", "lyes"],
    connectedSources: ["obsidian", "erp", "hermes", "github", "coolify"],
    source: { system: "erp", reference: "ERP · projet P-006", syncedAt: minutesAgo(24) },
  },
  {
    id: "docagora",
    name: "DocAgora",
    kind: "produit",
    domain: "technique",
    summary:
      "Espace documentaire pour associations. Phase de cadrage, pas encore ouvert à l'équipe.",
    ownerId: "etienne",
    memberIds: ["etienne"],
    connectedSources: ["obsidian", "erp", "hermes", "github"],
    source: { system: "erp", reference: "ERP · projet P-009", syncedAt: hoursAgo(3) },
  },
  {
    id: "ocean",
    name: "Ocean",
    kind: "produit",
    domain: "technique",
    summary:
      "Catalogue et moteur de recherche produit. Maintenance et audit des dépendances.",
    ownerId: "lyes",
    memberIds: ["etienne", "lyes"],
    connectedSources: ["obsidian", "erp", "hermes", "github", "coolify"],
    source: { system: "erp", reference: "ERP · projet P-011", syncedAt: minutesAgo(24) },
  },
  {
    id: "vernay",
    name: "Vernay Immobilier",
    kind: "client",
    domain: "commercial",
    summary:
      "Client commercial. Refonte de l'acquisition, séquences de relance et suivi des opportunités.",
    ownerId: "lucas",
    memberIds: ["etienne", "lucas"],
    connectedSources: ["crm", "erp", "hermes", "obsidian"],
    source: { system: "erp", reference: "ERP · projet P-017", syncedAt: minutesAgo(24) },
  },
];

export const projectsById: Record<string, Project> = Object.fromEntries(
  projects.map((project) => [project.id, project]),
);
