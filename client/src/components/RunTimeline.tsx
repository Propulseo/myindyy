import { Box, CircleAlert, CircleCheck, Clock3, TerminalSquare } from 'lucide-react';
import type { MissionRun, RunEvent } from '@shared/types';

interface RunTimelineProps {
  runs: MissionRun[];
  events: RunEvent[];
}

function payloadText(payload: Readonly<Record<string, unknown>>, keys: string[]): string | null {
  for (const key of keys) {
    if (typeof payload[key] === 'string' && payload[key]) return payload[key];
  }
  return null;
}

function eventPresentation(event: RunEvent) {
  const detail = payloadText(event.payload, ['label', 'tool', 'path', 'error', 'reason']);
  if (event.type === 'tool.started') return { Icon: TerminalSquare, label: detail ?? 'Outil', state: 'En cours' };
  if (event.type === 'tool.completed') return { Icon: CircleCheck, label: detail ?? 'Outil', state: 'Terminé' };
  if (event.type === 'artifact.produced') return { Icon: Box, label: detail ?? 'Artefact produit', state: 'Artefact' };
  if (event.type === 'run.failed' || event.type === 'run.blocked') return { Icon: CircleAlert, label: detail ?? 'Action requise', state: 'Erreur' };
  if (event.type === 'run.completed' || event.type === 'run.cancelled') return { Icon: CircleCheck, label: detail ?? 'Fin du run', state: 'Fin' };
  return { Icon: Clock3, label: detail ?? event.type, state: 'Événement' };
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(timestamp);
}

export function RunTimeline({ runs, events }: RunTimelineProps) {
  if (runs.length === 0) {
    return <p className="border-l border-[var(--cockpit-panel-line)] py-8 pl-5 text-sm text-[color:var(--cockpit-fog-muted)]">Lancez la mission pour voir son exécution ici.</p>;
  }

  return (
    <div className="space-y-8" aria-label="Timeline d’exécution">
      {[...runs].sort((a, b) => b.attempt - a.attempt).map((run) => {
        const runEvents = events.filter((event) => event.runId === run.id).sort((a, b) => a.occurredAt - b.occurredAt);
        return (
          <section key={run.id} className="relative border-l border-[var(--cockpit-panel-line)] pl-5">
            <span className="absolute -left-1.5 top-1 h-3 w-3 rounded-full border-2 border-[var(--cockpit-ink)] bg-[var(--cockpit-periwinkle)]" />
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-[var(--cockpit-mission-font)] text-xl text-[var(--cockpit-fog)]">Tentative {run.attempt}</h2>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[color:var(--cockpit-fog-muted)]">{run.status}</span>
            </div>
            <ol className="space-y-1">
              {runEvents.map((event) => {
                const presentation = eventPresentation(event);
                return (
                  <li key={event.id} className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-3 border-t border-[var(--cockpit-panel-line)] py-3">
                    <presentation.Icon aria-hidden="true" className="mt-0.5 text-[var(--cockpit-periwinkle)]" size={15} />
                    <span className="min-w-0 text-sm text-[var(--cockpit-fog)]">{presentation.label}</span>
                    <span className="text-right font-mono text-[10px] text-[color:var(--cockpit-fog-muted)]">
                      <span className="block">{presentation.state}</span>
                      <time dateTime={new Date(event.occurredAt).toISOString()}>{formatTime(event.occurredAt)}</time>
                    </span>
                  </li>
                );
              })}
            </ol>
            {run.finishReason && <p className="mt-3 text-xs text-[var(--cockpit-amber)]">Motif de fin · {run.finishReason}</p>}
          </section>
        );
      })}
    </div>
  );
}
