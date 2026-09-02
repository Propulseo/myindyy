import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StreamEvent } from '../server/adapters/types.js';
import { createRunRepository, type RunRepository } from '../server/runs/repository.js';
import { normalizeHermesEvent } from '../server/runs/event-normalizer.js';
import { createRunService, type RunService } from '../server/runs/service.js';
import { getRun, startGoalRun, updateRunContext, updateRunStatus } from '../server/live-chat.js';

const schema = readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8');

describe('durable run service', () => {
  let database: Database.Database;
  let repository: RunRepository;
  let service: RunService;
  let nextId: number;
  let now: number;

  beforeEach(() => {
    database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    database.exec(schema);
    database.prepare(`
      INSERT INTO tasks (id, title, status, created_at, updated_at)
      VALUES (?, ?, 'in_progress', 1, 1)
    `).run('mission-1', 'First mission');
    repository = createRunRepository(database);
    nextId = 0;
    now = 100;
    service = createRunService(repository, {
      generateId: () => `id-${++nextId}`,
      now: () => now++,
    });
  });

  afterEach(() => database.close());

  it.each([
    [
      { type: 'tool_progress', tool: 'terminal', status: 'running' },
      { type: 'tool.started', payload: { tool: 'terminal', status: 'running' } },
    ],
    [
      { type: 'done', sessionId: 'native-2' },
      { type: 'run.completed', payload: { sessionId: 'native-2' } },
    ],
    [
      { type: 'error', code: 'provider_error', error: 'expired' },
      { type: 'run.failed', payload: { code: 'provider_error', error: 'expired' } },
    ],
  ] satisfies Array<[StreamEvent, { type: string; payload: Record<string, unknown> }]>) (
    'normalizes Hermes event %# into the durable vocabulary',
    (event, expected) => {
      expect(normalizeHermesEvent({
        id: 'run-1',
        missionId: 'mission-1',
        sessionId: 'indy:mission-1:run-1',
        sessionConfirmedAt: null,
        attempt: 1,
        provider: 'openai-codex',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'high',
        status: 'running',
        startedAt: 10,
        lastActivityAt: 10,
        finishedAt: null,
        finishReason: null,
        previousRunId: null,
      }, event)).toMatchObject(expected);
    },
  );

  it('creates a fresh immutable run and provisional Hermes session for every attempt', () => {
    const first = service.startMission({
      missionId: 'mission-1',
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    });
    const second = service.startMission({
      missionId: 'mission-1',
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'low',
    });

    expect(first).toMatchObject({ runId: 'id-1', sessionId: 'indy:mission-1:id-1' });
    expect(second).toMatchObject({ runId: 'id-4', sessionId: 'indy:mission-1:id-4' });
    expect(repository.listMissionRuns('mission-1')).toMatchObject([
      {
        id: 'id-1', attempt: 1, sessionId: 'indy:mission-1:id-1',
        provider: 'openai-codex', model: 'gpt-5.6-sol', reasoningEffort: 'high',
        status: 'running', previousRunId: null,
      },
      {
        id: 'id-4', attempt: 2, sessionId: 'indy:mission-1:id-4',
        provider: 'openai-codex', model: 'gpt-5.6-sol', reasoningEffort: 'low',
        status: 'running', previousRunId: 'id-1',
      },
    ]);
    expect(repository.listRunEvents(first.runId).map((event) => event.type)).toEqual([
      'run.queued',
      'run.started',
    ]);
  });

  it('persists stream completion and adopts the native session before explicit run completion', () => {
    const started = service.startMission({
      missionId: 'mission-1',
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
    });

    service.consumeEvent(started.runId, { type: 'text_delta', content: 'Hello' });
    service.consumeEvent(started.runId, {
      type: 'done',
      sessionId: 'native-2',
      context: { used_tokens: 7, window_tokens: 100 },
    });

    expect(repository.getRunRecord(started.runId)).toMatchObject({
      sessionId: 'native-2',
      status: 'running',
      finishReason: null,
    });

    service.complete(started.runId);

    expect(repository.getRunRecord(started.runId)).toMatchObject({
      sessionId: 'native-2',
      status: 'completed',
      finishReason: 'completed',
    });
    expect(repository.listRunEvents(started.runId).slice(-2)).toMatchObject([
      { type: 'run.heartbeat', payload: { kind: 'text_delta', content: 'Hello' } },
      {
        type: 'run.completed',
        payload: {
          sessionId: 'native-2',
          context: { used_tokens: 7, window_tokens: 100 },
        },
      },
    ]);
    expect(repository.listRunEvents(started.runId).filter((event) => event.type === 'run.completed'))
      .toHaveLength(1);
  });

  it('keeps goal transport completions non-terminal until one explicit completion', () => {
    const started = service.startMission({
      missionId: 'mission-1', provider: 'openai-codex', model: 'gpt-5.6-sol',
    });

    service.consumeEvent(started.runId, {
      type: 'done', sessionId: 'native-goal', context: { used_tokens: 5, window_tokens: 100 },
    }, { terminal: false });
    service.consumeEvent(started.runId, {
      type: 'done', sessionId: 'native-goal', context: { used_tokens: 8, window_tokens: 100 },
    }, { terminal: false });

    expect(repository.getRunRecord(started.runId)).toMatchObject({ status: 'running' });
    expect(repository.listRunEvents(started.runId).slice(-2)).toMatchObject([
      {
        type: 'run.heartbeat',
        payload: {
          transportDone: true,
          sessionId: 'native-goal',
          context: { used_tokens: 5, window_tokens: 100 },
        },
      },
      {
        type: 'run.heartbeat',
        payload: {
          transportDone: true,
          sessionId: 'native-goal',
          context: { used_tokens: 8, window_tokens: 100 },
        },
      },
    ]);
    expect(repository.listRunEvents(started.runId).filter((event) =>
      ['run.completed', 'run.cancelled', 'run.failed'].includes(event.type),
    )).toHaveLength(0);

    service.complete(started.runId);

    expect(repository.listRunEvents(started.runId).filter((event) => event.type === 'run.completed'))
      .toHaveLength(1);
    expect(repository.getRunRecord(started.runId)).toMatchObject({ status: 'completed' });
  });

  it('cancels an interrupted goal without ever recording run completion', () => {
    const started = service.startMission({
      missionId: 'mission-1', provider: 'openai-codex', model: 'gpt-5.6-sol',
    });
    startGoalRun('mission-1', started.sessionId, null, started.runId);
    const context = { used_tokens: 12, window_tokens: 100 };

    service.consumeEvent(started.runId, {
      type: 'done', sessionId: 'native-goal', context, interrupted: true,
    }, { terminal: false });
    updateRunContext('mission-1', started.runId, context, 'native-goal');
    service.cancel(started.runId, 'operator-interrupt');
    service.cancel(started.runId, 'operator-interrupt');
    updateRunStatus('mission-1', started.runId, 'stopped', { context });

    expect(getRun('mission-1')).toMatchObject({
      runId: started.runId, sessionId: 'native-goal', status: 'stopped', context,
    });
    expect(repository.getRunRecord(started.runId)).toMatchObject({
      sessionId: 'native-goal', status: 'cancelled', finishReason: 'operator-interrupt',
    });
    const events = repository.listRunEvents(started.runId);
    expect(events.find((event) => event.payload.transportDone === true)).toMatchObject({
      type: 'run.heartbeat',
      payload: {
        sessionId: 'native-goal',
        interrupted: true,
        context: { used_tokens: 12, window_tokens: 100 },
      },
    });
    const terminalEvents = events
      .filter((event) => ['run.cancelled', 'run.completed'].includes(event.type));
    expect(terminalEvents).toMatchObject([
      { type: 'run.cancelled', payload: { reason: 'operator-interrupt' } },
    ]);
  });

  it('falls back to the latest confirmed session when a newer attempt fails before done', () => {
    const first = service.startMission({
      missionId: 'mission-1', provider: 'openai-codex', model: 'gpt-5.6-sol',
    });
    service.consumeEvent(first.runId, { type: 'done', sessionId: 'native-1' });
    service.complete(first.runId);
    const second = service.startMission({
      missionId: 'mission-1', provider: 'openai-codex', model: 'gpt-5.6-sol',
    });
    service.fail(second.runId, 'provider unavailable');

    expect(service.getLatestConfirmedSessionId('mission-1')).toBe('native-1');
    expect(repository.getRunRecord(second.runId)).toMatchObject({ sessionConfirmedAt: null });
  });

  it('confirms a Hermes session even when done returns the provisional id unchanged', () => {
    const started = service.startMission({
      missionId: 'mission-1', provider: 'openai-codex', model: 'gpt-5.6-sol',
    });

    service.consumeEvent(started.runId, {
      type: 'done', sessionId: started.sessionId,
    }, { terminal: false });

    expect(repository.getRunRecord(started.runId)?.sessionConfirmedAt).not.toBeNull();
    expect(service.getLatestConfirmedSessionId('mission-1')).toBe(started.sessionId);
  });

  it('does not infer session confirmation when no Hermes done supplied a session id', () => {
    const started = service.startMission({
      missionId: 'mission-1', provider: 'openai-codex', model: 'gpt-5.6-sol',
    });

    service.complete(started.runId);

    expect(repository.getRunRecord(started.runId)?.sessionConfirmedAt).toBeNull();
    expect(service.getLatestConfirmedSessionId('mission-1')).toBeUndefined();
  });

  it('keeps a failed stream terminally consistent and reloadable from a new service instance', () => {
    const started = service.startMission({
      missionId: 'mission-1',
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
    });
    service.fail(started.runId, new Error('worker disconnected'));

    const reloaded = createRunService(repository).getMissionHistory('mission-1');

    expect(reloaded.runs).toHaveLength(1);
    expect(reloaded.runs[0]).toMatchObject({ status: 'failed', finishReason: 'worker disconnected' });
    expect(reloaded.events.slice(-1)).toMatchObject([
      { runId: started.runId, type: 'run.failed', payload: { error: 'worker disconnected' } },
    ]);
  });

  it('preserves append order when several events share the same wall-clock millisecond', () => {
    const ids = ['run-z', 'event-z', 'event-y', 'event-x', 'event-a'];
    const sameMillisecondService = createRunService(repository, {
      generateId: () => ids.shift()!,
      now: () => 500,
    });
    const started = sameMillisecondService.startMission({
      missionId: 'mission-1', provider: 'openai-codex', model: 'gpt-5.6-sol',
    });
    sameMillisecondService.consumeEvent(started.runId, { type: 'text_delta', content: 'A' });
    sameMillisecondService.consumeEvent(started.runId, { type: 'done', sessionId: 'native-1' });

    expect(repository.listRunEvents(started.runId).map((event) => event.type)).toEqual([
      'run.queued', 'run.started', 'run.heartbeat', 'run.completed',
    ]);
  });
});
