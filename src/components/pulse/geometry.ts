import { minutesSince } from "@/lib/format";
import { PULSE_WINDOW_MINUTES, type PulseEvent } from "@/lib/selectors";

export const PULSE_WIDTH = 200;
export const PULSE_HEIGHT = 28;
export const PULSE_BASELINE = 19;
/** Une graduation par heure sur les douze dernières heures. */
export const PULSE_GRID_STEP = PULSE_WIDTH / 12;

export interface PulseMark {
  id: string;
  kind: PulseEvent["kind"];
  x: number;
  /** Hauteur du trait, pour les missions actives. */
  height: number;
  label: string;
  ageMinutes: number;
}

/**
 * Place les évènements sur la bande de temps : bord droit = maintenant,
 * bord gauche = il y a douze heures. Rien d'aléatoire, rien de décoratif.
 */
export function buildPulseMarks(events: PulseEvent[]): PulseMark[] {
  return events.map((event) => {
    const age = Math.min(Math.max(minutesSince(event.at), 0), PULSE_WINDOW_MINUTES);
    const progress = 1 - age / PULSE_WINDOW_MINUTES;
    const x = Math.min(PULSE_WIDTH - 5, Math.max(5, progress * PULSE_WIDTH));

    return {
      id: event.id,
      kind: event.kind,
      x: Number(x.toFixed(2)),
      height: Number((5 + event.intensity * 12).toFixed(2)),
      label: event.label,
      ageMinutes: age,
    };
  });
}
