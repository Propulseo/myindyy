import type { Database } from 'better-sqlite3';
import type { ScheduledTask } from '../../shared/types.js';
import { createRunRepository } from '../runs/repository.js';
import {
  listScheduledTaskOccurrenceManifests,
  type ScheduledTaskOccurrenceManifest,
} from './manifests.js';
import { redactSensitiveText } from '../security/redaction.js';

export interface ScheduledTaskOccurrenceSource {
  listScheduledTasks(includeDisabled?: boolean, limit?: number): Promise<ScheduledTask[]>;
}

export interface ScheduledTaskOccurrenceProjectionOptions {
  readonly listManifests?: () => Promise<ScheduledTaskOccurrenceManifest[]>;
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

function ensureCronMission(database: Database, manifest: ScheduledTaskOccurrenceManifest, at: number): void {
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
    cronMissionId(manifest.scheduledTaskId),
    redactSensitiveText(manifest.scheduledTaskName || manifest.scheduledTaskId),
    'Projection de l’identité du cron Hermes; Hermes reste la source du planning.',
    redactSensitiveText(manifest.model),
    redactSensitiveText(manifest.provider),
    manifest.reasoningEffort,
    at,
    at,
  );
}

export async function reconcileScheduledTaskOccurrences(
  database: Database,
  _source: ScheduledTaskOccurrenceSource,
  options: ScheduledTaskOccurrenceProjectionOptions = {},
): Promise<ScheduledTaskOccurrenceProjectionResult> {
  const listManifests = options.listManifests ?? listScheduledTaskOccurrenceManifests;
  const repository = createRunRepository(database);
  const manifests = await listManifests();
  let seen = 0;
  let imported = 0;

  for (const manifest of manifests) {
      seen += 1;
      const startedAt = Date.parse(manifest.startedAt);
      const finishedAt = Date.parse(manifest.finishedAt);
      ensureCronMission(database, manifest, finishedAt);
      const occurrenceKey = cronOccurrenceKey(manifest.scheduledTaskId, manifest.hermesRunId);
      const status = manifest.status;
      const finishReason = status === 'completed' ? 'hermes-cron-completed' : 'hermes-cron-failed';
      const result = repository.upsertCronOccurrence({
        missionId: cronMissionId(manifest.scheduledTaskId),
        occurrenceKey,
        sessionId: occurrenceKey,
        provider: redactSensitiveText(manifest.provider),
        model: redactSensitiveText(manifest.model),
        reasoningEffort: manifest.reasoningEffort,
        workdir: manifest.workdir ? redactSensitiveText(manifest.workdir) : null,
        startedAt,
        finishedAt,
        status,
        finishReason,
        error: status === 'failed' ? redactSensitiveText(manifest.error || 'Hermes cron failed') : null,
        provenance: {
          source: 'indy-hermes-occurrence-manifest',
          scheduledTaskId: redactSensitiveText(manifest.scheduledTaskId),
          hermesRunId: redactSensitiveText(manifest.hermesRunId),
          outputRef: manifest.outputRef ? redactSensitiveText(manifest.outputRef) : null,
          manifestPath: manifest.manifestPath ? redactSensitiveText(manifest.manifestPath) : null,
          dispatchToken: manifest.dispatchToken ? redactSensitiveText(manifest.dispatchToken) : null,
          originalHermesStatus: manifest.hermesStatus,
        },
      });
      if (result.created) imported += 1;
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
