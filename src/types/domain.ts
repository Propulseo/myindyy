/**
 * Types métier du cockpit Indy.
 *
 * Indy n'est la source de vérité de rien : il agrège. Chaque objet porte donc une
 * `Provenance` qui dit d'où l'information vient et quand elle a été synchronisée.
 */

export type SourceSystem =
  | "obsidian"
  | "erp"
  | "crm"
  | "hermes"
  | "github"
  | "coolify";

export interface Provenance {
  system: SourceSystem;
  /** Référence lisible dans le système d'origine. Fictive dans ce prototype. */
  reference: string;
  /** Horodatage ISO 8601 de la dernière synchronisation. */
  syncedAt: string;
}

/* ------------------------------------------------------------------ */
/* Personnes et permissions                                           */
/* ------------------------------------------------------------------ */

export type PersonId = "etienne" | "lyes" | "lucas";

export type Capability =
  /** Créer et lancer une mission. */
  | "missions.create"
  /** Suspendre, reprendre, relancer. */
  | "missions.control"
  /** Annuler une mission en cours. */
  | "missions.cancel"
  /** Approuver ou refuser une décision. */
  | "missions.approve"
  /** Déclencher un déploiement en production. */
  | "deploy.production"
  /** Publier ou envoyer une communication vers l'extérieur. */
  | "comms.external.send"
  /** Autoriser un dépassement de budget. */
  | "budget.override"
  /** Voir les identifiants et jetons des sources connectées. */
  | "secrets.view"
  /** Voir les tâches personnelles du propriétaire. */
  | "tasks.personal.view"
  /** Voir tous les projets, y compris ceux qui ne sont pas affectés. */
  | "projects.viewAll";

export interface Person {
  id: PersonId;
  name: string;
  initials: string;
  /** Libellé métier affiché dans le sélecteur de rôle. */
  role: string;
  /** Une phrase qui résume ce que la personne voit et peut faire. */
  roleSummary: string;
  capabilities: Capability[];
  /** Projets affectés. Ignoré si la personne a `projects.viewAll`. */
  projectIds: string[];
  source: Provenance;
}

/* ------------------------------------------------------------------ */
/* Projets                                                             */
/* ------------------------------------------------------------------ */

export type ProjectKind = "interne" | "produit" | "client";
export type ProjectDomain = "technique" | "commercial";

export interface Project {
  id: string;
  name: string;
  kind: ProjectKind;
  domain: ProjectDomain;
  summary: string;
  ownerId: PersonId;
  memberIds: PersonId[];
  budgetSpentEur: number;
  budgetCapEur: number;
  connectedSources: SourceSystem[];
  source: Provenance;
}

/* ------------------------------------------------------------------ */
/* Missions                                                            */
/* ------------------------------------------------------------------ */

export type MissionStatus =
  | "en_attente"
  | "en_cours"
  | "attente_validation"
  | "bloquee"
  | "terminee"
  | "echouee"
  | "annulee";

export type AutonomyLevel = "supervisee" | "encadree" | "autonome";

export type StepState = "done" | "current" | "todo" | "failed" | "skipped";

export interface MissionStep {
  id: string;
  label: string;
  state: StepState;
  detail?: string;
  finishedAt?: string;
  durationMin?: number;
}

/**
 * Un exécutant. On le nomme par ce qu'il fait dans la mission, pas par son modèle :
 * le modèle est une donnée de diagnostic.
 */
export interface MissionAgent {
  id: string;
  role: string;
  model: string;
  stepIds: string[];
  costEur: number;
}

export type ActivityKind =
  | "etape"
  | "instruction"
  | "decision"
  | "livrable"
  | "incident"
  | "systeme";

export interface ActivityEvent {
  id: string;
  at: string;
  kind: ActivityKind;
  actor: string;
  message: string;
  source: Provenance;
}

export interface DiagnosticLine {
  at: string;
  level: "info" | "warn" | "error";
  scope: string;
  message: string;
}

export interface Mission {
  id: string;
  /** Référence courte, affichée en monospace. */
  reference: string;
  title: string;
  /** Résumé écrit pour un humain, pas un extrait de prompt. */
  summary: string;
  status: MissionStatus;
  projectId: string;
  ownerId: PersonId;
  automationId?: string;
  autonomy: AutonomyLevel;
  startedAt?: string;
  lastActivityAt: string;
  progress: { done: number; total: number; unit: string };
  duration: { elapsedMin: number; capMin: number };
  budget: { spentEur: number; capEur: number };
  steps: MissionStep[];
  agents: MissionAgent[];
  activity: ActivityEvent[];
  deliverableIds: string[];
  decisionIds: string[];
  diagnostics: DiagnosticLine[];
  source: Provenance;
}

/* ------------------------------------------------------------------ */
/* Décisions sensibles                                                 */
/* ------------------------------------------------------------------ */

export type DecisionKind =
  | "deploiement_production"
  | "publication"
  | "communication_externe"
  | "annulation_mission"
  | "depassement_budget";

export type DecisionState = "en_attente" | "approuvee" | "refusee";

export interface Decision {
  id: string;
  missionId: string;
  projectId: string;
  kind: DecisionKind;
  /** Ce que l'on s'apprête à faire, en une ligne. */
  title: string;
  /** La cible exacte : un domaine, une liste, un dépôt. */
  target: string;
  environment: string;
  /** Révision de code, ou extrait du contenu qui partira. */
  revision: string;
  /** Ce qui se produit une fois confirmé. Jamais « Êtes-vous sûr ? ». */
  consequence: string;
  requestedAt: string;
  requiredCapability: Capability;
  state: DecisionState;
  resolvedAt?: string;
  resolvedById?: PersonId;
  source: Provenance;
}

/* ------------------------------------------------------------------ */
/* Livrables                                                           */
/* ------------------------------------------------------------------ */

export type DeliverableFormat =
  | "rapport"
  | "code"
  | "document"
  | "visuel"
  | "message";

export interface Deliverable {
  id: string;
  title: string;
  format: DeliverableFormat;
  projectId: string;
  missionId?: string;
  producedAt: string;
  /** Poids lisible : « 12 pages », « 4 fichiers », « 1 200 mots ». */
  sizeLabel: string;
  source: Provenance;
}

/* ------------------------------------------------------------------ */
/* Automatisations                                                     */
/* ------------------------------------------------------------------ */

export type AutomationHealth = "saine" | "attention" | "en_echec";

export type RunOutcome =
  | "ok"
  | "detection"
  | "decision"
  | "depassement"
  | "echec";

export interface AutomationRun {
  id: string;
  at: string;
  outcome: RunOutcome;
  durationMin: number;
  costEur: number;
  note?: string;
  missionId?: string;
}

export interface Automation {
  id: string;
  name: string;
  projectId: string;
  ownerId: PersonId;
  /** « Toutes les 30 minutes », « Chaque matin à 7 h 30 ». */
  cadenceLabel: string;
  purpose: string;
  health: AutomationHealth;
  runCount: number;
  lastRunAt: string;
  typicalDurationMin: number;
  typicalCostEur: number;
  runs: AutomationRun[];
  source: Provenance;
}

/* ------------------------------------------------------------------ */
/* Tâches Obsidian                                                     */
/* ------------------------------------------------------------------ */

export type TaskState = "a_faire" | "en_cours" | "fait";

export interface ObsidianTask {
  id: string;
  title: string;
  /** Absent pour une tâche personnelle. */
  projectId?: string;
  visibility: "partagee" | "personnelle";
  ownerId: PersonId;
  state: TaskState;
  dueAt: string;
  note?: string;
  source: Provenance;
}

/* ------------------------------------------------------------------ */
/* Modèles de mission                                                  */
/* ------------------------------------------------------------------ */

export interface MissionTemplate {
  id: string;
  name: string;
  objective: string;
  usedFor: string;
  defaultBudgetEur: number;
  defaultDurationMin: number;
  defaultAutonomy: AutonomyLevel;
}
