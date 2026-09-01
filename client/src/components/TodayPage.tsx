import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, CircleAlert, CircleDot, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { MissionRun, Task } from '@shared/types';
import { fetchMessages, fetchRuntime, type RuntimeStatus } from '../lib/api';
import { useStore } from '../lib/store';
import { RuntimeBadge } from './RuntimeBadge';

type Priority = 'decision' | 'blocked' | 'running' | 'review';

const SECTIONS: Array<{ id: Priority; label: string; empty: string }> = [
  { id: 'decision', label: 'À décider', empty: 'Aucune décision en attente.' },
  { id: 'blocked', label: 'À débloquer', empty: 'Aucun agent bloqué.' },
  { id: 'running', label: 'En cours', empty: 'Aucune mission active.' },
  { id: 'review', label: 'À relire', empty: 'Rien à relire pour le moment.' },
];

function latestRun(runs: MissionRun[] | undefined): MissionRun | null {
  return runs?.reduce<MissionRun | null>((latest, run) => (
    !latest || run.attempt > latest.attempt ? run : latest
  ), null) ?? null;
}

function priorityFor(task: Task, run: MissionRun | null, live: boolean): Priority | null {
  if (run?.status === 'waiting_approval') return 'decision';
  if (run?.status === 'blocked' || run?.status === 'failed') return 'blocked';
  if (live) return 'running';
  if (task.status === 'in_review') return 'review';
  if (task.status === 'in_progress' || run?.status === 'queued' || run?.status === 'running') return 'running';
  return null;
}

function duration(run: MissionRun | null): string {
  if (!run?.startedAt) return '—';
  const end = run.finishedAt ?? run.lastActivityAt;
  const seconds = Math.max(0, Math.floor((end - run.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}min ${seconds % 60}s`;
}

function recent(timestamp: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return 'à l’instant';
  if (minutes < 60) return `il y a ${minutes} min`;
  return `il y a ${Math.floor(minutes / 60)} h`;
}

function actionFor(priority: Priority): string {
  return { decision: 'Décider', blocked: 'Débloquer', running: 'Suivre', review: 'Relire' }[priority];
}

export function TodayPage() {
  const tasks = useStore((state) => state.tasks);
  const histories = useStore((state) => state.missionHistories);
  const taskRuns = useStore((state) => state.taskRuns);
  const setMissionHistory = useStore((state) => state.setMissionHistory);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const pendingHistories = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    void fetchRuntime().then((status) => { if (!cancelled) setRuntime(status); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const missing = tasks.filter((task) => {
      const history = histories.get(task.id);
      return (!history || history.loadedForTaskUpdatedAt < task.updated_at) && !pendingHistories.current.has(task.id);
    });
    void Promise.all(missing.map(async (task) => {
      pendingHistories.current.add(task.id);
      try {
        const response = await fetchMessages(task.id);
        if (!cancelled) setMissionHistory(task.id, {
          runs: response.runs,
          events: response.events,
          loadedForTaskUpdatedAt: task.updated_at,
        });
      } catch {
        // The section keeps its directional empty state while the next SSE update retries.
      } finally {
        pendingHistories.current.delete(task.id);
      }
    }));
    return () => { cancelled = true; };
  }, [histories, setMissionHistory, tasks]);

  const groups = useMemo(() => {
    const result: Record<Priority, Array<{ task: Task; run: MissionRun | null; live: boolean }>> = {
      decision: [], blocked: [], running: [], review: [],
    };
    for (const task of tasks) {
      const run = latestRun(histories.get(task.id)?.runs);
      const live = taskRuns.has(task.id);
      const priority = priorityFor(task, run, live);
      if (priority) result[priority].push({ task, run, live });
    }
    for (const section of SECTIONS) {
      result[section.id].sort((a, b) => (b.run?.lastActivityAt ?? b.task.updated_at) - (a.run?.lastActivityAt ?? a.task.updated_at));
    }
    return result;
  }, [histories, taskRuns, tasks]);

  const pulseMissions = SECTIONS.flatMap((section) => groups[section.id].map((mission) => ({ ...mission, priority: section.id })));
  const currentRun = pulseMissions.find(({ run }) => run?.status === 'running')?.run ?? null;

  return (
    <div className="cockpit-shell flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--cockpit-ink)] text-[var(--cockpit-fog)] sm:flex-row">
      <MissionPulseRail missions={pulseMissions} />
      <div className="min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8 sm:py-8">
        <header className="mb-8 flex flex-wrap items-end justify-between gap-4 border-b border-[var(--cockpit-panel-line)] pb-5">
          <div>
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--cockpit-periwinkle)]">Cockpit personnel · Étienne</p>
            <h1 className="font-[var(--cockpit-mission-font)] text-4xl leading-none sm:text-5xl">Aujourd’hui</h1>
          </div>
          <div className="flex flex-col items-end gap-3">
            <RuntimeBadge status={runtime} run={currentRun} />
            <Link to="/tasks/new" className="inline-flex min-h-10 items-center gap-2 rounded-md bg-[var(--cockpit-periwinkle)] px-3 text-xs font-semibold text-[var(--cockpit-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cockpit-fog)]">
              <Plus aria-hidden="true" size={15} /> Nouvelle mission
            </Link>
          </div>
        </header>

        <div>
          {SECTIONS.map((section) => (
            <MissionSection key={section.id} {...section} missions={groups[section.id]} />
          ))}
          <section className="grid gap-3 border-t border-[var(--cockpit-panel-line)] py-6 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <h2 className="font-[var(--cockpit-mission-font)] text-2xl">Top 5 Obsidian</h2>
            <div className="flex items-center gap-2 text-sm text-[color:var(--cockpit-fog-muted)]">
              <CircleAlert aria-hidden="true" size={15} className="text-[var(--cockpit-amber)]" />
              Connecteur non activé
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

interface MissionSectionProps {
  id: Priority;
  label: string;
  empty: string;
  missions: Array<{ task: Task; run: MissionRun | null; live?: boolean }>;
}

function MissionSection({ id: priority, label, empty, missions }: MissionSectionProps) {
  return (
    <section className="grid gap-3 border-t border-[var(--cockpit-panel-line)] py-6 sm:grid-cols-[12rem_minmax(0,1fr)]">
      <div className="flex items-baseline gap-2">
        <h2 className="font-[var(--cockpit-mission-font)] text-2xl">{label}</h2>
        <span className="font-mono text-[10px] text-[color:var(--cockpit-fog-muted)]">{missions.length.toString().padStart(2, '0')}</span>
      </div>
      {missions.length === 0 ? (
        <p className="py-1 text-sm text-[color:var(--cockpit-fog-muted)]">{empty}</p>
      ) : (
        <div className="divide-y divide-[var(--cockpit-panel-line)]">
          {missions.map(({ task, run }) => <MissionRow key={task.id} task={task} run={run} priority={priority} />)}
        </div>
      )}
    </section>
  );
}

function MissionRow({ task, run, priority }: { task: Task; run: MissionRun | null; priority: Priority }) {
  const activity = run?.lastActivityAt ?? task.updated_at;
  return (
    <article className="group grid gap-3 py-4 md:grid-cols-[minmax(12rem,1fr)_auto] md:items-center">
      <div className="min-w-0">
        <h3 className="truncate font-[var(--cockpit-mission-font)] text-xl">{task.title}</h3>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-[color:var(--cockpit-fog-muted)]">
          <span>Projet · non renseigné</span><span>{run?.provider ?? task.agent_provider ?? 'provider —'}</span>
          <span>{run?.model ?? task.agent_model ?? 'modèle —'}</span><span>{run?.reasoningEffort ?? task.reasoning_effort ?? 'réglage global'}</span>
          <span>{duration(run)}</span><span>Activité {recent(activity)}</span>
        </div>
      </div>
      <Link to={`/tasks/${task.id}`} className="inline-flex min-h-10 items-center gap-2 text-xs font-semibold text-[var(--cockpit-periwinkle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cockpit-periwinkle)]">
        {actionFor(priority)} <ArrowRight aria-hidden="true" size={14} />
      </Link>
    </article>
  );
}

function MissionPulseRail({ missions }: { missions: Array<{ task: Task; run: MissionRun | null; live?: boolean; priority: Priority }> }) {
  return (
    <nav aria-label="Pouls des missions" className="flex h-9 w-full shrink-0 items-center border-b border-[var(--cockpit-panel-line)] px-4 sm:h-auto sm:w-12 sm:flex-col sm:border-b-0 sm:border-r sm:px-0 sm:py-7">
      <CircleDot aria-hidden="true" size={14} className="mr-4 shrink-0 text-[var(--cockpit-periwinkle)] sm:mb-6 sm:mr-0" />
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden sm:flex-col">
        {missions.map(({ task, live, priority }) => (
          <Link key={task.id} to={`/tasks/${task.id}`} aria-label={`${task.title} · ${priority}`} title={task.title} className={`mission-pulse block h-1.5 w-5 shrink-0 rounded-full sm:h-5 sm:w-1.5 ${live ? 'mission-pulse-live' : ''}`} data-priority={priority} />
        ))}
      </div>
    </nav>
  );
}
