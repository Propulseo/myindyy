import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HermesOAuthRuntime } from '../server/runtime/hermes-runtime.js';
import { HermesWorkerAdapter } from '../server/adapters/hermes-worker.js';
import {
  reconcileActiveRuns,
  type RuntimeSessionInspection,
  type RuntimeSessionInspector,
} from '../server/runs/reconcile.js';
import { createRunRepository, type RunRepository } from '../server/runs/repository.js';
import {
  INACTIVE_AFTER_MS,
  WATCHDOG_INTERVAL_MS,
  classifyInactiveRuns,
  runWatchdogOnce,
  startRunWatchdog,
} from '../server/runs/watchdog.js';

const schema = readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8');

function inspectorReturning(
  inspections: Readonly<Record<string, RuntimeSessionInspection | Error>>,
): RuntimeSessionInspector {
  return {
    async inspectSession(sessionId) {
      const inspection = inspections[sessionId];
      if (inspection instanceof Error) throw inspection;
      return inspection ?? { state: 'unknown', processActive: null };
    },
  };
}

describe('mission run reconciliation', () => {
  let database: Database.Database;
  let repository: RunRepository;

  beforeEach(() => {
    database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    database.exec(schema);
    database.prepare(`
      INSERT INTO tasks (id, title, status, created_at, updated_at)
      VALUES (?, ?, 'in_progress', 1, 1)
    `).run('mission-1', 'Mission');
    repository = createRunRepository(database);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    database.close();
  });

  function createRunningRun(id: string, sessionId: string, createdAt = 10) {
    repository.createRun({
      id,
      missionId: 'mission-1',
      sessionId,
      attempt: Number(id.slice(-1)),
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      createdAt,
    });
    repository.appendRunEvent({
      id: `${id}-started`,
      runId: id,
      type: 'run.started',
      occurredAt: createdAt,
      payload: {},
    });
  }

  it('classifies inactivity at the exact 45 minute boundary', () => {
    const now = 4_000_000;

    expect(classifyInactiveRuns(now - 2_699_999, now)).toBe(false);
    expect(classifyInactiveRuns(now - 2_700_000, now)).toBe(true);
    expect(INACTIVE_AFTER_MS).toBe(2_700_000);
  });

  it('reconciles active, completed, missing and uninspectable sessions without relaunching', async () => {
    createRunningRun('run-1', 'active-session');
    createRunningRun('run-2', 'completed-session');
    createRunningRun('run-3', 'missing-session');
    createRunningRun('run-4', 'error-session');
    let nextId = 0;

    await reconcileActiveRuns(repository, inspectorReturning({
      'active-session': { state: 'active', processActive: true },
      'completed-session': { state: 'completed', processActive: false },
      'missing-session': { state: 'missing', processActive: false },
      'error-session': new Error('inspection unavailable'),
    }), 5_000, () => `reconcile-${++nextId}`);

    expect(repository.getRunRecord('run-1')).toMatchObject({
      status: 'running', lastActivityAt: 5_000,
    });
    expect(repository.listRunEvents('run-1').at(-1)).toMatchObject({
      type: 'run.heartbeat', payload: { reason: 'reconciled-active' },
    });
    expect(repository.getRunRecord('run-2')).toMatchObject({
      status: 'completed', finishedAt: 5_000, finishReason: 'completed',
    });
    expect(repository.listRunEvents('run-2').at(-1)?.type).toBe('run.completed');
    expect(repository.getRunRecord('run-3')).toMatchObject({
      status: 'failed', finishedAt: 5_000, finishReason: 'process-lost',
    });
    expect(repository.listRunEvents('run-3').at(-1)).toMatchObject({
      type: 'run.failed', payload: { reason: 'process-lost' },
    });
    expect(repository.getRunRecord('run-4')).toMatchObject({
      status: 'unknown', lastActivityAt: 10, finishedAt: null,
    });
    expect(repository.listRunEvents('run-4')).toHaveLength(1);
  });

  it('does not infer process loss when an inspector reports a process', async () => {
    createRunningRun('run-1', 'ambiguous-session');

    await reconcileActiveRuns(repository, inspectorReturning({
      'ambiguous-session': { state: 'missing', processActive: true },
    }), 5_000);

    expect(repository.getRunRecord('run-1')).toMatchObject({
      status: 'unknown', finishedAt: null, lastActivityAt: 10,
    });
  });

  it('does not infer process loss when process inspection is inconclusive', async () => {
    createRunningRun('run-1', 'ambiguous-session');

    await reconcileActiveRuns(repository, inspectorReturning({
      'ambiguous-session': { state: 'missing', processActive: null },
    }), 5_000);

    expect(repository.getRunRecord('run-1')).toMatchObject({
      status: 'unknown', finishedAt: null, lastActivityAt: 10,
    });
  });

  it('checks stale runs before blocking and records an inactive block only once', async () => {
    createRunningRun('run-1', 'active-session');
    createRunningRun('run-2', 'unknown-session');
    let nextId = 0;
    const inspector = inspectorReturning({
      'active-session': { state: 'active', processActive: true },
      'unknown-session': { state: 'unknown', processActive: null },
    });
    const now = 10 + INACTIVE_AFTER_MS;

    await runWatchdogOnce(repository, inspector, now, () => `watchdog-${++nextId}`);
    await runWatchdogOnce(
      repository,
      inspector,
      now + INACTIVE_AFTER_MS,
      () => `watchdog-${++nextId}`,
    );

    expect(repository.getRunRecord('run-1')).toMatchObject({ status: 'running' });
    expect(repository.listRunEvents('run-1').filter((event) =>
      event.type === 'run.blocked')).toHaveLength(0);
    expect(repository.getRunRecord('run-2')).toMatchObject({ status: 'blocked' });
    expect(repository.listRunEvents('run-2').filter((event) =>
      event.type === 'run.blocked' && event.payload.reason === 'inactive')).toHaveLength(1);
  });

  it('keeps inactive blocking idempotent across restart and independent per run', async () => {
    createRunningRun('run-1', 'first-unknown-session');
    createRunningRun('run-2', 'second-unknown-session');
    repository.appendRunEvent({
      id: 'first-inactive-block',
      runId: 'run-1',
      type: 'run.blocked',
      occurredAt: 20,
      payload: { reason: 'inactive' },
    });
    repository.updateRunStatus('run-1', 'unknown');

    repository = createRunRepository(database);
    let nextId = 0;
    await runWatchdogOnce(repository, inspectorReturning({}), 20 + INACTIVE_AFTER_MS, () =>
      `post-restart-${++nextId}`);

    expect(repository.listRunEvents('run-1').filter((event) =>
      event.type === 'run.blocked' && event.payload.reason === 'inactive')).toHaveLength(1);
    expect(repository.listRunEvents('run-2').filter((event) =>
      event.type === 'run.blocked' && event.payload.reason === 'inactive')).toHaveLength(1);
  });

  it('rechecks activity after inspection before blocking a stale snapshot', async () => {
    createRunningRun('run-1', 'unknown-session');
    const now = 10 + INACTIVE_AFTER_MS;
    const inspector: RuntimeSessionInspector = {
      async inspectSession() {
        repository.appendRunEvent({
          id: 'heartbeat-during-inspection',
          runId: 'run-1',
          type: 'run.heartbeat',
          occurredAt: now,
          payload: { reason: 'live-progress' },
        });
        return { state: 'unknown', processActive: null };
      },
    };

    await runWatchdogOnce(repository, inspector, now, () => 'inactive-event');

    expect(repository.getRunRecord('run-1')).toMatchObject({
      status: 'running', lastActivityAt: now,
    });
    expect(repository.listRunEvents('run-1').some((event) =>
      event.type === 'run.blocked')).toBe(false);
  });

  it('starts an unreferenced watchdog on a 60 second interval', () => {
    const unref = vi.fn();
    const schedule = vi.fn(() => ({ unref })) as unknown as typeof setInterval;

    startRunWatchdog(repository, inspectorReturning({}), { schedule });

    expect(schedule).toHaveBeenCalledWith(expect.any(Function), WATCHDOG_INTERVAL_MS);
    expect(unref).toHaveBeenCalledOnce();
  });

  it('reports only proven live sessions as active in the Hermes runtime inspector', async () => {
    const runtime = new HermesOAuthRuntime();
    vi.spyOn(runtime, 'getSessionMetadata')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'known-session',
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        estimated_cost_usd: null,
        cost_status: null,
        model: 'gpt-5.6-sol',
      });

    await expect(runtime.inspectSession('missing-session')).resolves.toEqual({
      state: 'missing', processActive: false,
    });
    await expect(runtime.inspectSession('known-session')).resolves.toEqual({
      state: 'unknown', processActive: false,
    });
  });

  it('keeps a shared session active until every local stream has finished', async () => {
    const releases: Array<() => void> = [];
    vi.spyOn(HermesWorkerAdapter.prototype, 'chatStream').mockImplementation(async function* (
      sessionId,
    ) {
      await new Promise<void>((resolve) => releases.push(resolve));
      yield { type: 'done', sessionId };
    });
    const runtime = new HermesOAuthRuntime();
    const options = { settings: { provider: 'openai-codex', model: 'gpt-5.6-sol' } };
    const first = runtime.chatStream('shared-session', 'first', options)[Symbol.asyncIterator]();
    const second = runtime.chatStream('shared-session', 'second', options)[Symbol.asyncIterator]();
    const firstEvent = first.next();
    const secondEvent = second.next();
    await vi.waitFor(() => expect(releases).toHaveLength(2));

    await expect(runtime.inspectSession('shared-session')).resolves.toEqual({
      state: 'active', processActive: true,
    });
    releases[0]!();
    await firstEvent;
    await first.next();
    await expect(runtime.inspectSession('shared-session')).resolves.toEqual({
      state: 'active', processActive: true,
    });

    releases[1]!();
    await secondEvent;
    await second.next();
    await expect(runtime.inspectSession('shared-session')).resolves.toEqual({
      state: 'completed', processActive: false,
    });
  });

  it('does not classify an interrupted transport as a completed session', async () => {
    vi.spyOn(HermesWorkerAdapter.prototype, 'chatStream').mockImplementation(async function* (
      sessionId,
    ) {
      yield { type: 'done', sessionId, interrupted: true };
    });
    const runtime = new HermesOAuthRuntime();
    vi.spyOn(runtime, 'getSessionMetadata').mockResolvedValue(null);
    const stream = runtime.chatStream('interrupted-session', 'stop', {
      settings: { provider: 'openai-codex', model: 'gpt-5.6-sol' },
    });
    for await (const _event of stream) {
      // Drain the real runtime wrapper so it observes transport completion.
    }

    await expect(runtime.inspectSession('interrupted-session')).resolves.toEqual({
      state: 'missing', processActive: false,
    });
  });
});
