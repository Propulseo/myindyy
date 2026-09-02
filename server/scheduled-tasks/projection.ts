import type { Database } from 'better-sqlite3';
import type { ScheduledTask, ScheduledTaskRun } from '../../shared/types.js';
import { createRunRepository } from '../runs/repository.js';
import { listAllScheduledTaskRuns } from './runs.js';

const MISSING_RUNTIME_FIELD = '<missing>';

export interface ScheduledTaskOccurrenceSource {
  listScheduledTasks(includeDisabled?: boolean, limit?: number): Promise<ScheduledTask[]>;
}

export interface ScheduledTaskOccurrenceProjectionOptions {
  readonly listRuns?: (scheduledTaskId: string) => Promise<ScheduledTaskRun[]>;
  readonly now?: () => number;
}

export interface ScheduledTaskOccurrenceReconcilerOptions extends ScheduledTaskOccurrenceProjectionOptions {
  readonly intervalMs?: number;
  readonly onError?: (error: unknown) => void;
}

export interface ScheduledTaskOccurrenceReconciler {
  readonly ready: Promise<void>;
  stop(): void;
}

export interface ScheduledTaskOccurrenceProjectionResult {
  readonly seen: number;
  readonly imported: number;
}

export function cronMissionId(scheduledTaskId: string): string {
  return `cron:${scheduledTaskId}`;
}

export function cronOccurrenceKey(scheduledTaskId: string, hermesRunId: string): string {
  return `cron:${scheduledTaskId}:${hermesRunId}`;
}

function occurredAt(run: ScheduledTaskRun, now: () => number): number {
  if (run.ranAt) {
    const parsed = new Date(run.ranAt).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return now();
}

function ensureCronMission(database: Database, task: ScheduledTask, at: number): void {
  database.prepare(`
    INSERT INTO tasks (
      id, title, description, status, mission_kind, agent_model, agent_provider,
      reasoning_effort, created_at, updated_at
    ) VALUES (?, ?, ?, 'done', 'cron', ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      mission_kind = 'cron',
      agent_model = excluded.agent_model,
      agent_provider = excluded.agent_provider,
      reasoning_effort = excluded.reasoning_effort,
      updated_at = excluded.updated_at
  `).run(
    cronMissionId(task.id),
    task.name || task.id,
    'Projection de l’identité du cron Hermes; Hermes reste la source du planning.',
    task.model,
    task.provider,
    task.reasoningEffort,
    at,
    at,
  );
}

export async function reconcileScheduledTaskOccurrences(
  database: Database,
  source: ScheduledTaskOccurrenceSource,
  options: ScheduledTaskOccurrenceProjectionOptions = {},
): Promise<ScheduledTaskOccurrenceProjectionResult> {
  const listRuns = options.listRuns ?? listAllScheduledTaskRuns;
  const now = options.now ?? Date.now;
  const repository = createRunRepository(database);
  // The worker reserves limit=0 for an internal, unbounded snapshot. The HTTP
  // route never exposes this sentinel, so reconciliation cannot silently skip
  // an occurrence merely because more than 100 Hermes schedules exist.
  const tasks = await source.listScheduledTasks(true, 0);
  let seen = 0;
  let imported = 0;

  for (const task of tasks) {
    const runs = await listRuns(task.id);
    seen += runs.length;
    for (const run of runs) {
      const at = occurredAt(run, now);
      ensureCronMission(database, task, at);
      const occurrenceKey = cronOccurrenceKey(task.id, run.id);
      const status = run.status === 'ok' ? 'completed' : 'failed';
      const finishReason = run.status === 'ok'
        ? 'hermes-cron-completed'
        : run.status === 'error'
          ? 'hermes-cron-failed'
          : 'hermes-cron-output-unclassified';
      const result = repository.upsertCronOccurrence({
        missionId: cronMissionId(task.id),
        occurrenceKey,
        sessionId: occurrenceKey,
        provider: task.provider ?? MISSING_RUNTIME_FIELD,
        model: task.model ?? MISSING_RUNTIME_FIELD,
        reasoningEffort: task.reasoningEffort,
        workdir: task.workdir,
        occurredAt: at,
        status,
        finishReason,
        error: run.status === 'error' ? (run.preview || 'Hermes cron failed') : null,
        provenance: {
          source: 'hermes-cron-output',
          scheduledTaskId: task.id,
          hermesRunId: run.id,
          outputPath: run.path,
        },
      });
      if (result.created) imported += 1;
    }
  }

  return { seen, imported };
}

export function startScheduledTaskOccurrenceReconciler(
  database: Database,
  source: ScheduledTaskOccurrenceSource,
  options: ScheduledTaskOccurrenceReconcilerOptions = {},
): ScheduledTaskOccurrenceReconciler {
  const intervalMs = options.intervalMs ?? 60_000;
  let stopped = false;
  let running = false;

  const scan = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      await reconcileScheduledTaskOccurrences(database, source, options);
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  };

  const ready = scan();
  const timer = setInterval(() => void scan(), intervalMs);
  timer.unref();
  return {
    ready,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
