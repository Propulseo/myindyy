/**
 * Horloge de démonstration.
 *
 * Toutes les dates des fixtures sont calculées à partir d'un instant fixe. Le rendu
 * est donc identique côté serveur et côté client (pas de décalage d'hydratation), et
 * la démonstration raconte toujours la même journée.
 *
 * 2026-09-01T12:20:00Z = mardi 1er septembre 2026, 14 h 20 à Paris.
 */
export const DEMO_NOW_ISO = "2026-09-01T12:20:00.000Z";

const DEMO_NOW_MS = Date.parse(DEMO_NOW_ISO);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function shift(ms: number): string {
  return new Date(DEMO_NOW_MS - ms).toISOString();
}

export const minutesAgo = (n: number): string => shift(n * MINUTE);
export const hoursAgo = (n: number): string => shift(n * HOUR);
export const daysAgo = (n: number): string => shift(n * DAY);

/** Échéance dans le futur, utilisée par les tâches Obsidian du jour. */
export const inHours = (n: number): string => shift(-n * HOUR);
