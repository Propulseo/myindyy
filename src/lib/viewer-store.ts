import type { PersonId } from "@/types/domain";

/**
 * Le rôle de démonstration choisi, conservé hors de React.
 *
 * Passer par un store externe plutôt que par un effet évite deux choses : un rendu
 * en cascade au montage, et un écart entre le rendu serveur et le premier rendu
 * client — `getServerSnapshot` renvoie toujours le rôle par défaut.
 */
const STORAGE_KEY = "indy.demo.viewer";
const DEFAULT_VIEWER: PersonId = "etienne";
const KNOWN: PersonId[] = ["etienne", "lyes", "lucas"];

let cached: PersonId | null = null;
const listeners = new Set<() => void>();

function isKnown(value: string | null): value is PersonId {
  return value !== null && (KNOWN as string[]).includes(value);
}

export function subscribeViewer(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getViewerSnapshot(): PersonId {
  if (cached) return cached;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    cached = isKnown(stored) ? stored : DEFAULT_VIEWER;
  } catch {
    cached = DEFAULT_VIEWER;
  }
  return cached;
}

export function getViewerServerSnapshot(): PersonId {
  return DEFAULT_VIEWER;
}

export function writeViewer(id: PersonId): void {
  cached = id;
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Navigation privée ou stockage refusé : le choix reste valable pour la session.
  }
  listeners.forEach((listener) => listener());
}
