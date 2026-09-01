/**
 * Types métier du cockpit Indy.
 *
 * Indy n'est la source de vérité de rien : il agrège. Chaque objet porte donc une
 * `Provenance` qui dit d'où l'information vient et quand elle a été synchronisée.
 *
 * Codex tourne derrière Indy sur l'abonnement de l'utilisateur : le cockpit ne
 * compte donc aucun coût. Ce qu'il encadre et ce qu'il montre sont des garde-fous
 * opérationnels — durée, tentatives, agents en parallèle, échéance, niveau d'effort,
 * dernière activité, blocage et inactivité.
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
  /** Prolonger une mission au-delà de sa durée ou de ses tentatives. */
  | "limits.override"
  /** Voir les identifiants et jetons des sources connectées. */
  | "secrets.view"
  /**
   * Capturer, trier, terminer ou annuler une tâche Obsidian, dans la limite des
   * projets visibles. La commande part vers Hermes, jamais vers le coffre.
   */
  | "tasks.manage"
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
  connectedSources: SourceSystem[];
  source: Provenance;
}

/**
 * Activité des agents sur un projet. Entièrement recalculée à partir des missions
 * affichées, jamais stockée : les chiffres ne peuvent pas contredire la liste.
 */
export interface AgentActivity {
  missionCount: number;
  /** Missions closes, base du taux de réussite. */
  closedCount: number;
  /** Entre 0 et 1. `null` tant qu'aucune mission n'est close. */
  successRate: number | null;
  /** Médiane des durées des missions closes, en minutes. `null` si aucune. */
  medianDurationMin: number | null;
  /** Instructions humaines et décisions tranchées. */
  humanInterventions: number;
  blockedMissions: number;
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

/** Combien la mission a le droit de creuser avant de rendre la main. */
export type EffortLevel = "leger" | "standard" | "approfondi";

export type StepState = "done" | "current" | "todo" | "failed" | "skipped";

export interface MissionStep {
  id: string;
  label: string;
  state: StepState;
  detail?: string;
  finishedAt?: string;
  durationMin?: number;
}

export type AgentState = "actif" | "en_attente" | "termine" | "arrete";

/**
 * Un exécutant. On le nomme par ce qu'il fait dans la mission, pas par son modèle :
 * le modèle est une donnée de diagnostic.
 */
export interface MissionAgent {
  id: string;
  role: string;
  model: string;
  stepIds: string[];
  state: AgentState;
  /** Nombre de tentatives déjà consommées par cet exécutant. */
  attempts: number;
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
  effort: EffortLevel;
  startedAt?: string;
  lastActivityAt: string;
  /** Échéance attendue, quand la mission en a une. */
  dueAt?: string;
  progress: { done: number; total: number; unit: string };
  /** Garde-fou de temps : temps écoulé et limite. */
  duration: { elapsedMin: number; capMin: number };
  /** Garde-fou de reprise : tentative en cours et maximum autorisé. */
  attempts: { current: number; max: number };
  /** Nombre d'exécutants que la mission peut faire travailler en même temps. */
  parallelAgents: number;
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
  /** Repousser la durée ou les tentatives d'une mission arrivée à sa limite. */
  | "prolongation";

export type DecisionState = "en_attente" | "approuvee" | "refusee";

export interface Decision {
  id: string;
  missionId: string;
  projectId: string;
  kind: DecisionKind;
  /** Ce que l'on s'apprête à faire, en une ligne. */
  title: string;
  /** La cible exacte : un domaine, une liste, un dépôt, une mission. */
  target: string;
  environment: string;
  /** Révision de code, extrait du contenu, ou état exact des garde-fous. */
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

/**
 * Ce qu'une exécution a produit. Tout sauf `ok` remonte sur « Aujourd'hui » :
 * échec, blocage, décision demandée, durée dépassée, tentatives multipliées.
 */
export type RunOutcome =
  | "ok"
  | "detection"
  | "decision"
  | "duree"
  | "tentatives"
  | "blocage"
  | "echec";

export interface AutomationRun {
  id: string;
  at: string;
  outcome: RunOutcome;
  durationMin: number;
  /** Tentatives consommées par cette exécution. */
  attempts: number;
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
  /** Repères de normalité, pour dire quand une exécution en sort. */
  typicalDurationMin: number;
  typicalAttempts: number;
  runs: AutomationRun[];
  source: Provenance;
}

/* ------------------------------------------------------------------ */
/* Tâches Obsidian                                                     */
/* ------------------------------------------------------------------ */

/**
 * Une tâche annulée reste dans l'état de démonstration avec un statut écrit :
 * elle n'est jamais retirée en silence.
 */
export type TaskState = "a_faire" | "en_cours" | "fait" | "annulee";

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

/**
 * Commande de tâche envoyée à Hermes. Obsidian reste la source de vérité :
 * Indy ne touche pas au coffre, il demande à Hermes de le faire.
 */
export type TaskCommand =
  | "todo.capture"
  | "todo.triage"
  | "todo.complete"
  | "todo.cancel";

/* ------------------------------------------------------------------ */
/* Modèles de mission                                                  */
/* ------------------------------------------------------------------ */

export interface MissionTemplate {
  id: string;
  name: string;
  objective: string;
  usedFor: string;
  defaultDurationMin: number;
  defaultAttempts: number;
  defaultEffort: EffortLevel;
  defaultAutonomy: AutonomyLevel;
}

/* ------------------------------------------------------------------ */
/* Utilisation du forfait Codex                                        */
/* ------------------------------------------------------------------ */

/**
 * Consommation globale du forfait Codex.
 *
 * Indy ne la calcule pas et ne l'estime pas : il l'affiche seulement si Hermes ou
 * Codex la fournit. Tant que la valeur vaut `null`, l'écran dit qu'elle n'est pas
 * exposée, plutôt que d'inventer un chiffre.
 */
export interface PlanUsage {
  /** Libellé fourni tel quel par la source, jamais reconstruit ni recalculé. */
  label: string;
  source: Provenance;
}
