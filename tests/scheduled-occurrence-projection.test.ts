import { describe, expect, it, vi } from 'vitest';
import type { ScheduledTask } from '../shared/types.js';
import { createDatabase } from '../server/db/index.js';
import type { ScheduledTaskOccurrenceManifest } from '../server/scheduled-tasks/manifests.js';
import {
  cronMissionId,
  reconcileScheduledTaskOccurrences,
  startScheduledTaskOccurrenceReconciler,
} from '../server/scheduled-tasks/projection.js';

const TASK: ScheduledTask = {
  id: 'hermes-daily-brief',
  name: 'Brief quotidien',
  prompt: 'Préparer le brief.',
  schedule: { kind: 'cron', expr: '0 8 * * *' },
  scheduleDisplay: '0 8 * * *',
  enabled: true,
  state: 'scheduled',
  nextRunAt: '2026-09-03T08:00:00.000Z',
  lastRunAt: '2026-09-02T08:00:00.000Z',
  lastStatus: 'error',
  lastError: 'Bearer oauth-secret-must-not-persist',
  lastDeliveryError: null,
  provider: 'openai-codex',
  model: 'gpt-5.6-sol',
  reasoningEffort: 'high',
  baseUrl: null,
  deliver: 'local',
  origin: null,
  repeat: null,
  contextFrom: [],
  skills: [],
  workdir: 'C:\\work\\client',
  createdAt: '2026-09-01T08:00:00.000Z',
};

const MANIFESTS: ScheduledTaskOccurrenceManifest[] = [
  {
    schemaVersion: 1,
    hermesRunId: '2026-09-01_08-00-00',
    scheduledTaskId: TASK.id,
    scheduledTaskName: TASK.name,
    startedAt: '2026-09-01T08:00:00.000Z',
    finishedAt: '2026-09-01T08:00:01.000Z',
    status: 'completed',
    hermesStatus: 'completed',
    error: null,
    outputRef: 'C:\\hermes\\cron\\indy-manifests\\hermes-daily-brief\\2026-09-01_08-00-00.output.json',
    provider: 'openai-codex', model: 'gpt-5.6-sol', reasoningEffort: 'high', workdir: 'C:\\work\\client',
    dispatchToken: null,
    manifestPath: 'C:\\hermes\\cron\\indy-manifests\\hermes-daily-brief\\2026-09-01_08-00-00.json',
  },
  {
    schemaVersion: 1,
    hermesRunId: '2026-09-02_08-00-00',
    scheduledTaskId: TASK.id,
    scheduledTaskName: TASK.name,
    startedAt: '2026-09-02T08:00:00.000Z',
    finishedAt: '2026-09-02T08:00:01.000Z',
    status: 'failed',
    hermesStatus: 'failed',
    error: 'Bearer another-secret-must-not-persist',
    outputRef: 'C:\\hermes\\cron\\indy-manifests\\hermes-daily-brief\\2026-09-02_08-00-00.output.json',
    provider: 'openai-codex', model: 'gpt-5.6-sol', reasoningEffort: 'high', workdir: 'C:\\work\\client',
    dispatchToken: null,
    manifestPath: 'C:\\hermes\\cron\\indy-manifests\\hermes-daily-brief\\2026-09-02_08-00-00.json',
  },
];

function source() {
  return {
    listScheduledTasks: vi.fn().mockResolvedValue([TASK]),
    runScheduledTask: vi.fn(),
    tickScheduledTasks: vi.fn(),
  };
}

describe('Hermes cron occurrence projection', () => {
  it('imports every durable Hermes occurrence exactly once with stable mission identity and provenance', async () => {
    const database = createDatabase(':memory:');
    const adapter = source();
    const listManifests = vi.fn().mockResolvedValue(MANIFESTS);

    try {
      const first = await reconcileScheduledTaskOccurrences(database, adapter, { listManifests });
      const replay = await reconcileScheduledTaskOccurrences(database, adapter, { listManifests });

      expect(first).toEqual({ seen: 2, imported: 2 });
      expect(replay).toEqual({ seen: 2, imported: 0 });
      expect(adapter.listScheduledTasks).not.toHaveBeenCalled();
      expect(database.prepare(`
        SELECT id, mission_kind, title FROM tasks WHERE id = ?
      `).get(cronMissionId(TASK.id))).toEqual({
        id: 'cron:hermes-daily-brief',
        mission_kind: 'cron',
        title: 'Brief quotidien',
      });
      expect(database.prepare(`
        SELECT occurrence_key, status, provider, model, reasoning_effort, workdir
        FROM mission_runs ORDER BY occurrence_key
      `).all()).toEqual([
        {
          occurrence_key: 'cron:hermes-daily-brief:2026-09-01_08-00-00',
          status: 'completed',
          provider: 'openai-codex',
          model: 'gpt-5.6-sol',
          reasoning_effort: 'high',
          workdir: 'C:\\work\\client',
        },
        {
          occurrence_key: 'cron:hermes-daily-brief:2026-09-02_08-00-00',
          status: 'failed',
          provider: 'openai-codex',
          model: 'gpt-5.6-sol',
          reasoning_effort: 'high',
          workdir: 'C:\\work\\client',
        },
      ]);
      expect(database.prepare('SELECT type FROM run_events ORDER BY occurred_at, type').all()).toEqual([
        { type: 'run.started' },
        { type: 'run.completed' },
        { type: 'run.started' },
        { type: 'run.failed' },
      ]);
      const failedEvent = database.prepare(`
        SELECT payload_json FROM run_events WHERE type = 'run.failed'
      `).get() as { payload_json: string };
      expect(JSON.parse(failedEvent.payload_json)).toEqual(expect.objectContaining({
        error: expect.stringContaining('[REDACTED]'),
      }));
      const persisted = JSON.stringify({
        runs: database.prepare('SELECT provenance_json FROM mission_runs').all(),
        events: database.prepare('SELECT payload_json FROM run_events').all(),
      });
      expect(persisted).not.toContain('oauth-secret-must-not-persist');
      expect(persisted).not.toContain('another-secret-must-not-persist');
      expect(adapter.runScheduledTask).not.toHaveBeenCalled();
      expect(adapter.tickScheduledTasks).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it('remains idempotent after a projector restart and relies on a database uniqueness guarantee', async () => {
    const database = createDatabase(':memory:');
    const adapter = source();
    const listManifests = vi.fn().mockResolvedValue([MANIFESTS[0]]);

    try {
      await reconcileScheduledTaskOccurrences(database, adapter, { listManifests });
      await reconcileScheduledTaskOccurrences(database, source(), { listManifests });

      expect(database.prepare('SELECT COUNT(*) AS count FROM mission_runs').get()).toEqual({ count: 1 });
      const row = database.prepare('SELECT * FROM mission_runs').get() as Record<string, unknown>;
      expect(() => database.prepare(`
        INSERT INTO mission_runs (
          id, mission_id, session_id, occurrence_key, attempt, provider, model,
          reasoning_effort, status, last_activity_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'duplicate-run', row.mission_id, 'duplicate-session', row.occurrence_key,
        2, 'openai-codex', 'gpt-5.6-sol', 'high', 'completed', 1,
      )).toThrow(/UNIQUE constraint failed/);
    } finally {
      database.close();
    }
  });

  it('projects a manual Hermes occurrence only after its durable run record appears', async () => {
    const database = createDatabase(':memory:');
    const adapter = source();
    let durableManifests: ScheduledTaskOccurrenceManifest[] = [];
    const listManifests = vi.fn().mockImplementation(async () => durableManifests);

    try {
      const beforeEvidence = await reconcileScheduledTaskOccurrences(database, adapter, { listManifests });
      durableManifests = [MANIFESTS[0]];
      const afterEvidence = await reconcileScheduledTaskOccurrences(database, adapter, { listManifests });
      const replay = await reconcileScheduledTaskOccurrences(database, adapter, { listManifests });

      expect(beforeEvidence).toEqual({ seen: 0, imported: 0 });
      expect(afterEvidence).toEqual({ seen: 1, imported: 1 });
      expect(replay).toEqual({ seen: 1, imported: 0 });
      expect(database.prepare('SELECT COUNT(*) AS count FROM mission_runs').get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it('imports occurrences at startup and passively discovers later files without a browser or scheduler call', async () => {
    vi.useFakeTimers();
    const database = createDatabase(':memory:');
    const adapter = source();
    let durableManifests = [MANIFESTS[0]];
    const listManifests = vi.fn().mockImplementation(async () => durableManifests);

    try {
      const reconciler = startScheduledTaskOccurrenceReconciler(database, adapter, {
        listManifests,
        intervalMs: 60_000,
      });
      await reconciler.ready;
      expect(database.prepare('SELECT COUNT(*) AS count FROM mission_runs').get()).toEqual({ count: 1 });

      durableManifests = MANIFESTS;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(database.prepare('SELECT COUNT(*) AS count FROM mission_runs').get()).toEqual({ count: 2 });
      expect(adapter.runScheduledTask).not.toHaveBeenCalled();
      expect(adapter.tickScheduledTasks).not.toHaveBeenCalled();
      reconciler.stop();
    } finally {
      vi.useRealTimers();
      database.close();
    }
  });
});
