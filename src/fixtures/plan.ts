import type { PlanUsage } from "@/types/domain";

/**
 * Utilisation globale du forfait Codex.
 *
 * Codex tourne sur l'abonnement ChatGPT de l'utilisateur. Indy ne connaît ni le prix
 * d'une mission ni la part de forfait qu'elle consomme, et n'a aucun moyen honnête de
 * le déduire. Il n'affiche donc cette information que si Hermes ou Codex la lui donne.
 *
 * Tant que cette valeur vaut `null`, l'écran le dit explicitement au lieu d'estimer.
 * Le jour où la source expose la donnée, il suffit de la placer ici : l'interface
 * bascule d'elle-même sur l'affichage réel.
 */
export const codexPlanUsage: PlanUsage | null = null;
