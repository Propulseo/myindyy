import { DEMO_NOW_ISO } from "@/fixtures/clock";

const NOW_MS = Date.parse(DEMO_NOW_ISO);
const LOCALE = "fr-FR";
const TIME_ZONE = "Europe/Paris";

const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });

const timeFormatter = new Intl.DateTimeFormat(LOCALE, {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: TIME_ZONE,
});

const dayFormatter = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "short",
  timeZone: TIME_ZONE,
});

const dayTimeFormatter = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: TIME_ZONE,
});

const euro = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
});

/** Écart en minutes entre l'instant de démonstration et une date. Positif = passé. */
export function minutesSince(iso: string): number {
  return Math.round((NOW_MS - Date.parse(iso)) / 60_000);
}

/** « il y a 18 minutes », « il y a 3 heures », « hier », « il y a 4 jours ». */
export function formatRelative(iso: string): string {
  const minutes = minutesSince(iso);
  const abs = Math.abs(minutes);

  if (abs < 1) return "à l'instant";
  if (abs < 60) return relative.format(-minutes, "minute");
  if (abs < 60 * 24) return relative.format(-Math.round(minutes / 60), "hour");
  return relative.format(-Math.round(minutes / (60 * 24)), "day");
}

/** « 14:02 » */
export function formatTime(iso: string): string {
  return timeFormatter.format(new Date(iso));
}

/** « 28 août » */
export function formatDay(iso: string): string {
  return dayFormatter.format(new Date(iso));
}

/** « 28 août, 14:02 » */
export function formatDayTime(iso: string): string {
  return dayTimeFormatter.format(new Date(iso));
}

/** Aujourd'hui : l'heure suffit. Avant : le jour et l'heure. */
export function formatStamp(iso: string): string {
  return minutesSince(iso) < 60 * 12 ? formatTime(iso) : formatDayTime(iso);
}

/** « 2,76 € » */
export function formatEur(value: number): string {
  return euro.format(value);
}

/** « 2 h 48 », « 34 min », « — » */
export function formatDuration(minutes: number): string {
  if (minutes <= 0) return "—";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, "0")}`;
}

/** Ratio borné à 1, pour les jauges. */
export function ratio(value: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.min(1, Math.max(0, value / cap));
}

/** « 3 missions » / « 1 mission » */
export function plural(count: number, singular: string, pluralForm?: string): string {
  const word = count > 1 ? (pluralForm ?? `${singular}s`) : singular;
  return `${count} ${word}`;
}

export const DEMO_DAY_LABEL = new Intl.DateTimeFormat(LOCALE, {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: TIME_ZONE,
}).format(new Date(DEMO_NOW_ISO));

export const DEMO_TIME_LABEL = formatTime(DEMO_NOW_ISO);
