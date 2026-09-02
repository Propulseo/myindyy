import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from '../server/db/index.js';
import {
  listScheduledTaskOccurrenceManifests,
  type ScheduledTaskOccurrenceManifest,
} from '../server/scheduled-tasks/manifests.js';
import {
  cronMissionId,
  reconcileScheduledTaskOccurrences,
  startScheduledTaskOccurrenceReconciler,
} from '../server/scheduled-tasks/projection.js';

function manifest(overrides: Partial<ScheduledTaskOccurrenceManifest> = {}): ScheduledTaskOccurrenceManifest {
  return {
    schemaVersion: 1,
    hermesRunId: 'run-shared',
    scheduledTaskId: 'deleted-task',
    scheduledTaskName: 'Tâche supprimée',
    startedAt: '2026-09-02T08:00:00.125Z',
    finishedAt: '2026-09-02T08:00:02.875Z',
    status: 'completed',
    error: null,
    outputRef: 'C:/hermes/cron/indy-manifests/deleted-task/run-shared.output.json',
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    workdir: 'C:/work/original',
    dispatchToken: null,
    manifestPath: 'C:/hermes/cron/indy-manifests/deleted-task/run-shared.json',
    ...overrides,
  };
}

describe('terminal Hermes manifest projection', () => {
  it('defers partial, temporary, malformed and unclassified artifacts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'indy-terminal-scan-'));
    const dir = join(root, 'task');
    mkdirSync(dir, { recursive: true });
    const complete = {
      ...manifest({
        provider: '<missing>',
        model: '<missing>',
        reasoningEffort: null,
        status: 'failed',
        error: 'SCHEDULED_PROVIDER_REQUIRED',
      }),
      manifestPath: undefined,
    };
    writeFileSync(join(dir, 'complete.json'), JSON.stringify(complete));
    writeFileSync(join(dir, 'partial.json'), JSON.stringify({ ...complete, finishedAt: null }));
    writeFileSync(join(dir, 'running.json'), JSON.stringify({ ...complete, status: 'running' }));
    writeFileSync(join(dir, 'complete.json.tmp'), JSON.stringify(complete));
    writeFileSync(join(dir, 'raw.md'), '# Cron output still being written');

    const manifests = await listScheduledTaskOccurrenceManifests(root);

    expect(manifests).toHaveLength(1);
    expect(manifests[0]).toMatchObject({
      hermesRunId: 'run-shared',
      status: 'failed',
      provider: '<missing>',
      model: '<missing>',
    });
  });

  it('imports terminal manifests without consulting live jobs and preserves exact evidenced timestamps/config', async () => {
    const database = createDatabase(':memory:');
    const listManifests = vi.fn().mockResolvedValue([manifest()]);
    const source = { listScheduledTasks: vi.fn().mockRejectedValue(new Error('deleted')) };
    try {
      expect(await reconcileScheduledTaskOccurrences(database, source, { listManifests })).toEqual({ seen: 1, imported: 1 });
      expect(source.listScheduledTasks).not.toHaveBeenCalled();
      expect(database.prepare(`
        SELECT started_at, finished_at, last_activity_at, provider, model, reasoning_effort, workdir
        FROM mission_runs
      `).get()).toEqual({
        started_at: Date.parse('2026-09-02T08:00:00.125Z'),
        finished_at: Date.parse('2026-09-02T08:00:02.875Z'),
        last_activity_at: Date.parse('2026-09-02T08:00:02.875Z'),
        provider: 'openai-codex', model: 'gpt-5.6-sol', reasoning_effort: 'high', workdir: 'C:/work/original',
      });
    } finally { database.close(); }
  });

  it('keys same Hermes run id independently per task and remains restart/concurrency idempotent', async () => {
    const database = createDatabase(':memory:');
    const manifests = [manifest(), manifest({ scheduledTaskId: 'other-task', scheduledTaskName: 'Autre tâche' })];
    const source = { listScheduledTasks: vi.fn() };
    const options = { listManifests: vi.fn().mockResolvedValue(manifests) };
    try {
      const [first, concurrent] = await Promise.all([
        reconcileScheduledTaskOccurrences(database, source, options),
        reconcileScheduledTaskOccurrences(database, source, options),
      ]);
      await reconcileScheduledTaskOccurrences(database, source, options);
      expect(first.imported + concurrent.imported).toBe(2);
      expect(database.prepare('SELECT occurrence_key FROM mission_runs ORDER BY occurrence_key').all()).toEqual([
        { occurrence_key: 'cron:deleted-task:run-shared' },
        { occurrence_key: 'cron:other-task:run-shared' },
      ]);
    } finally { database.close(); }
  });

  it('redacts manifest errors/provenance and leaves durable tombstones after source files disappear', async () => {
    const database = createDatabase(':memory:');
    let manifests = [manifest({
      scheduledTaskName: 'Authorization: Basic dXNlcjpwYXNz',
      provider: 'Authorization: Digest username="cron", realm="indy", nonce="provider-secret", uri="/cron"',
      model: 'credential=model-secret',
      workdir: 'api_key=workdir-secret',
      status: 'failed',
      error: 'Bearer oauth-secret token=hidden password=nested-password passwd=nested-passwd pwd=nested-pwd',
    })];
    const source = { listScheduledTasks: vi.fn() };
    const listManifests = vi.fn().mockImplementation(async () => manifests);
    try {
      await reconcileScheduledTaskOccurrences(database, source, { listManifests });
      manifests = [];
      await reconcileScheduledTaskOccurrences(database, source, { listManifests });
      const persisted = JSON.stringify({
        tasks: database.prepare('SELECT title, agent_provider, agent_model FROM tasks').all(),
        runs: database.prepare('SELECT provider, model, workdir, finish_reason, provenance_json FROM mission_runs').all(),
        events: database.prepare('SELECT payload_json FROM run_events').all(),
      });
      expect(persisted).not.toContain('oauth-secret');
      expect(persisted).not.toContain('hidden');
      expect(persisted).not.toContain('provider-secret');
      expect(persisted).not.toContain('model-secret');
      expect(persisted).not.toContain('workdir-secret');
      expect(persisted).not.toContain('dXNlcjpwYXNz');
      expect(persisted).not.toContain('nested-password');
      expect(persisted).not.toContain('nested-passwd');
      expect(persisted).not.toContain('nested-pwd');
      expect(database.prepare('SELECT COUNT(*) AS count FROM mission_runs').get()).toEqual({ count: 1 });
    } finally { database.close(); }
  });

  it('runs as a passive lifecycle loop and never calls a scheduler or trigger', async () => {
    vi.useFakeTimers();
    const database = createDatabase(':memory:');
    const source = { listScheduledTasks: vi.fn(), runScheduledTask: vi.fn(), tickScheduledTasks: vi.fn() };
    const listManifests = vi.fn().mockResolvedValue([manifest()]);
    try {
      const reconciler = startScheduledTaskOccurrenceReconciler(database, source, { listManifests, intervalMs: 100 });
      await reconciler.ready;
      await vi.advanceTimersByTimeAsync(100);
      reconciler.stop();
      expect(source.listScheduledTasks).not.toHaveBeenCalled();
      expect(source.runScheduledTask).not.toHaveBeenCalled();
      expect(source.tickScheduledTasks).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); database.close(); }
  });
});
