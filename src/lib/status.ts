import type {
  AgentState,
  AutomationHealth,
  DecisionKind,
  EffortLevel,
  MissionStatus,
  RunOutcome,
  SourceSystem,
  StepState,
  TaskState,
} from "@/types/domain";

/**
 * Quatre tons d'état, plus le neutre et l'accent. La couleur n'est jamais seule :
 * chaque état porte aussi une forme de pastille distincte (`Shape`) et un libellé écrit.
 */
export type Tone = "neutral" | "active" | "attention" | "danger" | "success" | "waiting";

export type Shape = "filled" | "ring" | "diamond" | "bar" | "cross" | "dash";

export interface ToneClasses {
  /** Couleur du texte. */
  text: string;
  /** Couleur de la pastille et du rail de ligne. */
  mark: string;
  /** Fond très sourd, pour les pastilles de statut. */
  chip: string;
  /** Bordure assortie. */
  border: string;
}

export const toneClasses: Record<Tone, ToneClasses> = {
  neutral: {
    text: "text-muted",
    mark: "bg-muted",
    chip: "bg-muted/10",
    border: "border-muted/25",
  },
  active: {
    text: "text-indy",
    mark: "bg-indy",
    chip: "bg-indy/12",
    border: "border-indy/30",
  },
  attention: {
    text: "text-attention",
    mark: "bg-attention",
    chip: "bg-attention/12",
    border: "border-attention/30",
  },
  danger: {
    text: "text-danger",
    mark: "bg-danger",
    chip: "bg-danger/12",
    border: "border-danger/30",
  },
  success: {
    text: "text-ok",
    mark: "bg-ok",
    chip: "bg-ok/12",
    border: "border-ok/30",
  },
  waiting: {
    text: "text-waiting",
    mark: "bg-waiting",
    chip: "bg-waiting/12",
    border: "border-waiting/30",
  },
};

export interface StatusMeta {
  label: string;
  tone: Tone;
  shape: Shape;
  /** Phrase courte utilisée dans les regroupements et les infobulles. */
  hint: string;
}

export const missionStatusMeta: Record<MissionStatus, StatusMeta> = {
  en_attente: {
    label: "En attente",
    tone: "waiting",
    shape: "ring",
    hint: "En file, pas encore démarrée",
  },
  en_cours: {
    label: "En cours",
    tone: "active",
    shape: "filled",
    hint: "Une étape est en train de tourner",
  },
  attente_validation: {
    label: "Attend une validation",
    tone: "attention",
    shape: "diamond",
    hint: "Arrêtée volontairement, attend une décision humaine",
  },
  bloquee: {
    label: "Bloquée",
    tone: "danger",
    shape: "bar",
    hint: "Ne peut pas continuer sans arbitrage",
  },
  terminee: {
    label: "Terminée",
    tone: "success",
    shape: "filled",
    hint: "Toutes les étapes sont passées",
  },
  echouee: {
    label: "Échouée",
    tone: "danger",
    shape: "cross",
    hint: "Interrompue par une erreur",
  },
  annulee: {
    label: "Annulée",
    tone: "neutral",
    shape: "dash",
    hint: "Arrêtée par une personne",
  },
};

/** Ordre d'affichage : ce qui demande une action d'abord. */
export const missionStatusOrder: MissionStatus[] = [
  "attente_validation",
  "bloquee",
  "echouee",
  "en_cours",
  "en_attente",
  "terminee",
  "annulee",
];

export const automationHealthMeta: Record<AutomationHealth, StatusMeta> = {
  saine: {
    label: "État sain",
    tone: "success",
    shape: "ring",
    hint: "Les dernières exécutions se sont passées comme prévu",
  },
  attention: {
    label: "À surveiller",
    tone: "attention",
    shape: "diamond",
    hint: "Une détection, une durée dépassée ou des tentatives répétées",
  },
  en_echec: {
    label: "En échec",
    tone: "danger",
    shape: "cross",
    hint: "La dernière exécution n'est pas allée au bout",
  },
};

export const runOutcomeMeta: Record<RunOutcome, StatusMeta> = {
  ok: { label: "Sans remarque", tone: "success", shape: "filled", hint: "Rien à signaler" },
  detection: {
    label: "A détecté quelque chose",
    tone: "attention",
    shape: "diamond",
    hint: "Un point relevé qui mérite un regard",
  },
  decision: {
    label: "Demande une décision",
    tone: "attention",
    shape: "diamond",
    hint: "Attend une réponse humaine",
  },
  duree: {
    label: "Plus longue que d'habitude",
    tone: "attention",
    shape: "bar",
    hint: "Durée nettement au-dessus de son habitude",
  },
  tentatives: {
    label: "Tentatives multipliées",
    tone: "attention",
    shape: "bar",
    hint: "A dû reprendre plusieurs fois pour aboutir",
  },
  blocage: {
    label: "Bloquée",
    tone: "danger",
    shape: "bar",
    hint: "S'est arrêtée sans pouvoir continuer",
  },
  echec: { label: "Échec", tone: "danger", shape: "cross", hint: "Interrompue par une erreur" },
};

/**
 * Une exécution ne remonte sur « Aujourd'hui » que si elle sort de l'ordinaire :
 * échec, blocage, décision demandée, durée dépassée, tentatives multipliées.
 */
export const notableOutcomes: RunOutcome[] = [
  "detection",
  "decision",
  "duree",
  "tentatives",
  "blocage",
  "echec",
];

export const stepStateMeta: Record<StepState, StatusMeta> = {
  done: { label: "Faite", tone: "success", shape: "filled", hint: "Étape terminée" },
  current: { label: "En cours", tone: "active", shape: "ring", hint: "Étape en cours" },
  todo: { label: "À venir", tone: "neutral", shape: "ring", hint: "Pas encore commencée" },
  failed: { label: "En échec", tone: "danger", shape: "cross", hint: "Étape interrompue" },
  skipped: { label: "Passée", tone: "neutral", shape: "dash", hint: "Non exécutée" },
};

export const taskStateMeta: Record<TaskState, StatusMeta> = {
  a_faire: { label: "À faire", tone: "waiting", shape: "ring", hint: "Pas commencée" },
  en_cours: { label: "En cours", tone: "active", shape: "filled", hint: "Commencée" },
  fait: { label: "Faite", tone: "success", shape: "filled", hint: "Terminée" },
};

export const decisionKindMeta: Record<
  DecisionKind,
  { label: string; verb: string; confirmLabel: string; tone: Tone }
> = {
  deploiement_production: {
    label: "Déploiement en production",
    verb: "Déployer",
    confirmLabel: "Déployer en production",
    tone: "danger",
  },
  publication: {
    label: "Publication",
    verb: "Publier",
    confirmLabel: "Publier",
    tone: "attention",
  },
  communication_externe: {
    label: "Communication externe",
    verb: "Envoyer",
    confirmLabel: "Envoyer la communication",
    tone: "attention",
  },
  annulation_mission: {
    label: "Annulation d'une mission",
    verb: "Annuler",
    confirmLabel: "Annuler la mission",
    tone: "danger",
  },
  prolongation: {
    label: "Prolongation d'une mission",
    verb: "Prolonger",
    confirmLabel: "Prolonger la mission",
    tone: "attention",
  },
};

export const sourceMeta: Record<SourceSystem, { label: string; role: string }> = {
  obsidian: { label: "Obsidian", role: "Tâches et mémoire" },
  erp: { label: "ERP", role: "Projets, personnes et affectations" },
  crm: { label: "CRM", role: "Leads et opportunités" },
  hermes: { label: "Hermes", role: "Missions et exécutions" },
  github: { label: "GitHub", role: "Code, commits et demandes de fusion" },
  coolify: { label: "Coolify", role: "Déploiements" },
};

export const autonomyMeta = {
  supervisee: {
    label: "Supervisée",
    hint: "Chaque action sortante demande une validation.",
  },
  encadree: {
    label: "Encadrée",
    hint: "Travaille seule, s'arrête avant toute action sortante.",
  },
  autonome: {
    label: "Autonome",
    hint: "Va au bout sans interruption, dans la limite de la durée et des tentatives.",
  },
} as const;

/** Combien la mission a le droit de creuser avant de rendre la main. */
export const effortMeta: Record<EffortLevel, { label: string; hint: string }> = {
  leger: {
    label: "Léger",
    hint: "Va au plus direct, explore peu.",
  },
  standard: {
    label: "Standard",
    hint: "Explore, vérifie, reprend une fois si nécessaire.",
  },
  approfondi: {
    label: "Approfondi",
    hint: "Explore largement et contrôle son travail. Plus long.",
  },
};

export const agentStateMeta: Record<AgentState, StatusMeta> = {
  actif: { label: "Actif", tone: "active", shape: "filled", hint: "Travaille en ce moment" },
  en_attente: {
    label: "En attente",
    tone: "waiting",
    shape: "ring",
    hint: "Prêt, attend son tour",
  },
  termine: { label: "Terminé", tone: "success", shape: "filled", hint: "A fini sa part" },
  arrete: { label: "Arrêté", tone: "neutral", shape: "dash", hint: "N'a pas repris la main" },
};
