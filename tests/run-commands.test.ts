import Database from 'better-sqlite3';
import express, { type Express } from 'express';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../server/adapters/types.js';
import { createRunsRouter, type LaunchCommandRun } from '../server/routes/runs.js';
import { createRunRepository, type RunRepository } from '../server/runs/repository.js';
import { createRunService, type RunService } from '../server/runs/service.js';
import type { MissionRun, SessionMetadata, Task } from '../shared/types.js';

const schema = readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8');

class FakeHermesBoundary {
  readonly interruptions: Array<{ sessionId: string; reason?: string }> = [];
  readonly sessions = new Map<string, SessionMetadata>();
  interruptResult = true;

  async interruptChat(sessionId: string, reason?: string): Promise<boolean> {
    this.interruptions.push({ sessionId, reason });
    return this.interruptResult;
  }

  async getSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
    return this.sessions.get(sessionId) ?? null;
  }
}

describe('operator run commands', () => {
  let database: Database.Database;
  let repository: RunRepository;
  let service: RunService;
  let hermes: FakeHermesBoundary;
  let app: Express;
  let launched: Parameters<LaunchCommandRun>[];
  let nextId: number;

  beforeEach(() => {
    database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    database.exec(schema);
    database.prepare(`
      INSERT INTO tasks (
        id, title, description, status, agent_model, agent_provider, reasoning_effort,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'in_progress', ?, ?, ?, 1, 1)
    `).run('mission-1', 'First mission', 'Ship it', 'task-current-model', 'openai-codex', 'low');
    repository = createRunRepository(database);
    nextId = 0;
    service = createRunService(repository, {
      generateId: () => `id-${++nextId}`,
      now: () => 100 + nextId,
    });
    hermes = new FakeHermesBoundary();
    launched = [];
    app = express();
    app.use(express.json());
    app.use('/api/missions', createRunsRouter({
      database,
      adapter: hermes as Pick<AgentAdapter, 'interruptChat' | 'getSessionMetadata'>,
      runService: service,
      launchCommandRun: (...args) => launched.push(args),
    }));
  });

  afterEach(() => database.close());

  function startRun(settings: Partial<Pick<MissionRun, 'provider' | 'model' | 'reasoningEffort'>> = {}) {
    return service.startMission({
      missionId: 'mission-1',
      provider: settings.provider ?? 'openai-codex',
      model: settings.model ?? 'gpt-source',
      reasoningEffort: settings.reasoningEffort ?? 'high',
    });
  }

  function confirm(runId: string, sessionId: string): void {
    service.consumeEvent(runId, { type: 'done', sessionId }, { terminal: false });
    hermes.sessions.set(sessionId, {
      id: sessionId,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      estimated_cost_usd: null,
      cost_status: null,
      model: 'gpt-source',
    });
  }

  async function command(key: string, body: Record<string, unknown>) {
    return request(app)
      .post('/api/missions/mission-1/commands')
      .set('Idempotency-Key', key)
      .send(body);
  }

  it('registers the mission command route in the application', async () => {
    process.env.MINIONS_HOME = mkdtempSync(join(tmpdir(), 'indy-run-commands-'));
    const { default: productionApp } = await import('../server/app.js');

    const response = await request(productionApp)
      .post('/api/missions/missing/commands')
      .set('Idempotency-Key', 'cmd-route')
      .send({ type: 'interrupt', runId: 'missing-run' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Mission not found' });
  });

  it('keeps a corrected successor streaming when the interrupted goal finishes late', async () => {
    process.env.MINIONS_HOME ||= mkdtempSync(join(tmpdir(), 'indy-run-race-'));
    const [{ default: productionApp, adapter }, { default: productionDb }, liveChat] = await Promise.all([
      import('../server/app.js'),
      import('../server/db/index.js'),
      import('../server/live-chat.js'),
    ]);
    const taskId = `mission-race-${Date.now()}`;
    productionDb.prepare(`
      INSERT INTO tasks (
        id, title, description, status, agent_model, agent_provider, reasoning_effort,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'in_progress', ?, ?, ?, 1, 1)
    `).run(taskId, 'Race mission', 'Keep working', 'gpt-race', 'openai-codex', 'high');

    let releaseOld!: () => void;
    let oldDoneConsumed!: () => void;
    let releaseSuccessor!: () => void;
    const oldRelease = new Promise<void>((resolve) => { releaseOld = resolve; });
    const oldConsumed = new Promise<void>((resolve) => { oldDoneConsumed = resolve; });
    const successorRelease = new Promise<void>((resolve) => { releaseSuccessor = resolve; });
    let streamCall = 0;
    async function* oldGoalStream() {
      yield {
        type: 'done' as const,
        sessionId: 'native-race-session',
        interrupted: true,
      };
      oldDoneConsumed();
      await oldRelease;
      yield {
        type: 'done' as const,
        sessionId: 'late-old-session',
        context: { used_tokens: 7, window_tokens: 100 },
        interrupted: true,
      };
    }
    async function* successorStream() {
      await successorRelease;
      yield { type: 'done' as const, sessionId: 'native-race-session' };
    }

    const chatStreamSpy = vi.spyOn(adapter, 'chatStream').mockImplementation(() => (
      streamCall++ === 0 ? oldGoalStream() : successorStream()
    ));
    const setGoalSpy = vi.spyOn(adapter, 'setGoal').mockResolvedValue({
      goal: 'Original goal',
      status: 'active',
      turnsUsed: 0,
      maxTurns: 20,
      lastReason: null,
      pausedReason: null,
    });
    const interruptSpy = vi.spyOn(adapter, 'interruptChat').mockResolvedValue(true);
    const runtimeStatusSpy = vi.spyOn(adapter, 'getRuntimeStatus').mockResolvedValue({
      provider: 'openai-codex',
      profileId: 'test-profile',
      authState: 'connected',
      checkedAt: '2026-09-01T08:00:00.000Z',
      models: [{ id: 'gpt-race', label: 'gpt-race', reasoningEfforts: null }],
    });
    const writes: string[] = [];
    let closeSubscriber = () => {};

    try {
      const goal = await request(productionApp)
        .post(`/api/tasks/${taskId}/messages`)
        .send({ content: 'Original goal', mode: 'goal' });
      expect(goal.status).toBe(202);
      await oldConsumed;

      const correction = await request(productionApp)
        .post(`/api/missions/${taskId}/commands`)
        .set('Idempotency-Key', `correct-race-${taskId}`)
        .send({ type: 'correct', runId: goal.body.runId, reason: 'Corrected instruction' });
      expect(correction.status).toBe(202);
      expect(liveChat.getRunStatus(taskId)).toMatchObject({
        runId: correction.body.runId,
        status: 'streaming',
      });
      expect(liveChat.getRun(taskId)).toMatchObject({
        sessionId: 'native-race-session',
        context: null,
      });

      const fakeResponse = {
        write(chunk: string) {
          writes.push(chunk);
          return true;
        },
        on(event: string, callback: () => void) {
          if (event === 'close') closeSubscriber = callback;
          return this;
        },
      } as unknown as import('express').Response;
      liveChat.subscribe(taskId, fakeResponse);

      releaseOld();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(liveChat.getRunStatus(taskId)).toMatchObject({
        runId: correction.body.runId,
        status: 'streaming',
      });
      expect(writes.join('')).not.toContain('"status":"stopped"');

      const concurrent = await request(productionApp)
        .post(`/api/tasks/${taskId}/messages`)
        .send({ content: 'Concurrent launch' });
      expect(concurrent.status).toBe(409);
    } finally {
      releaseOld();
      releaseSuccessor();
      closeSubscriber();
      chatStreamSpy.mockRestore();
      setGoalSpy.mockRestore();
      interruptSpy.mockRestore();
      runtimeStatusSpy.mockRestore();
    }
  });

  it('returns the durable prior result for a duplicate and rejects a changed payload without a second effect', async () => {
    const started = startRun();
    const body = { type: 'interrupt', runId: started.runId, reason: 'Corriger le périmètre' };

    const first = await command('cmd-1', body);
    const duplicate = await command('cmd-1', {
      reason: 'Corriger le périmètre', runId: started.runId, type: 'interrupt',
    });
    const conflict = await command('cmd-1', { ...body, reason: 'autre' });
    service.consumeEvent(started.runId, { type: 'done', sessionId: started.sessionId });
    service.complete(started.runId);

    expect(first.status).toBe(202);
    expect(duplicate.status).toBe(202);
    expect(duplicate.body).toEqual(first.body);
    expect(conflict.status).toBe(409);
    expect(hermes.interruptions).toEqual([
      { sessionId: started.sessionId, reason: 'Corriger le périmètre' },
    ]);
    expect(repository.listRunEvents(started.runId).filter((event) => event.type === 'run.cancelled'))
      .toHaveLength(1);
    expect(repository.listRunEvents(started.runId).filter((event) => event.type === 'run.completed'))
      .toHaveLength(0);
    expect(repository.getRunRecord(started.runId)?.status).toBe('cancelled');
    expect(database.prepare(`
      SELECT actor_id, status, result_json, completed_at
      FROM operator_commands WHERE idempotency_key = ?
    `).get('cmd-1')).toMatchObject({
      actor_id: 'etienne',
      status: 'completed',
      result_json: JSON.stringify({ httpStatus: 202, body: first.body }),
      completed_at: expect.any(Number),
    });
  });

  it('rejects missing keys, client actors, stale runs, empty corrections, and incompatible states', async () => {
    const old = startRun();
    service.cancel(old.runId, 'superseded');
    const current = startRun();
    service.complete(current.runId);

    const missingKey = await request(app)
      .post('/api/missions/mission-1/commands')
      .send({ type: 'interrupt', runId: current.runId });
    const clientActor = await command('bad-actor', {
      type: 'interrupt', runId: current.runId, actorId: 'mallory',
    });
    const stale = await command('stale', { type: 'retry', runId: old.runId });
    const emptyCorrection = await command('empty-correct', {
      type: 'correct', runId: current.runId, reason: '   ',
    });
    const incompatible = await command('completed-interrupt', {
      type: 'interrupt', runId: current.runId,
    });

    expect(missingKey.status).toBe(400);
    expect(clientActor.status).toBe(400);
    expect(stale.status).toBe(409);
    expect(emptyCorrection.status).toBe(400);
    expect(incompatible.status).toBe(409);
    expect(hermes.interruptions).toEqual([]);
  });

  it('corrects in the latest confirmed session after interrupting and links a new attempt', async () => {
    const current = startRun();
    confirm(current.runId, 'native-session-1');

    const response = await command('correct-1', {
      type: 'correct', runId: current.runId, reason: 'Concentre-toi sur le lot 5',
    });

    expect(response.status).toBe(202);
    expect(hermes.interruptions).toEqual([
      { sessionId: 'native-session-1', reason: 'Concentre-toi sur le lot 5' },
    ]);
    const runs = repository.listMissionRuns('mission-1');
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ id: current.runId, status: 'cancelled' });
    expect(runs[1]).toMatchObject({
      id: response.body.runId,
      previousRunId: current.runId,
      sessionId: 'native-session-1',
      sessionConfirmedAt: expect.any(Number),
      provider: 'openai-codex',
      model: 'gpt-source',
      reasoningEffort: 'high',
    });
    expect(launched).toHaveLength(1);
    expect(launched[0]?.[1]).toMatchObject({ runId: response.body.runId, sessionId: 'native-session-1' });
    expect(launched[0]?.[2]).toBe('Concentre-toi sur le lot 5');
    expect(launched[0]?.[3]).toEqual({
      provider: 'openai-codex', model: 'gpt-source', reasoningEffort: 'high',
    });
  });

  it('does not start a correction while Hermes reports the current attempt was not interrupted', async () => {
    const current = startRun();
    confirm(current.runId, 'native-session-1');
    hermes.interruptResult = false;

    const response = await command('correct-not-interrupted', {
      type: 'correct', runId: current.runId, reason: 'Change de périmètre',
    });

    expect(response.status).toBe(409);
    expect(repository.listMissionRuns('mission-1')).toHaveLength(1);
    expect(repository.getRunRecord(current.runId)?.status).toBe('running');
    expect(launched).toEqual([]);
  });

  it('resumes only a confirmed session Hermes can retrieve and creates a linked attempt in it', async () => {
    const current = startRun();
    confirm(current.runId, 'native-session-1');
    service.fail(current.runId, 'worker stopped');

    const response = await command('resume-1', {
      type: 'resume', runId: current.runId, reason: 'Continue depuis le dernier point sûr',
    });

    expect(response.status).toBe(202);
    expect(repository.listMissionRuns('mission-1').at(-1)).toMatchObject({
      id: response.body.runId,
      previousRunId: current.runId,
      sessionId: 'native-session-1',
      provider: 'openai-codex',
      model: 'gpt-source',
      reasoningEffort: 'high',
    });
    expect(launched[0]?.[2]).toBe('Continue depuis le dernier point sûr');
  });

  it('does not create a resume attempt when Hermes cannot retrieve the confirmed session', async () => {
    const current = startRun();
    confirm(current.runId, 'native-session-1');
    service.fail(current.runId, 'worker stopped');
    hermes.sessions.clear();

    const response = await command('resume-missing', {
      type: 'resume', runId: current.runId, reason: 'Continue',
    });

    expect(response.status).toBe(409);
    expect(repository.listMissionRuns('mission-1')).toHaveLength(1);
    expect(launched).toEqual([]);
  });

  it('retries in a new session with the targeted attempt runtime rather than mutable mission defaults', async () => {
    const current = startRun({
      provider: 'openai-codex', model: 'gpt-original', reasoningEffort: 'xhigh',
    });
    service.fail(current.runId, 'rate limit');
    database.prepare(`
      UPDATE tasks SET agent_model = 'gpt-mutated', reasoning_effort = 'low' WHERE id = ?
    `).run('mission-1');

    const response = await command('retry-1', {
      type: 'retry', runId: current.runId, reason: 'Réessaie le même travail',
    });

    expect(response.status).toBe(202);
    const retry = repository.listMissionRuns('mission-1').at(-1)!;
    expect(retry).toMatchObject({
      id: response.body.runId,
      previousRunId: current.runId,
      provider: 'openai-codex',
      model: 'gpt-original',
      reasoningEffort: 'xhigh',
    });
    expect(retry.sessionId).not.toBe(current.sessionId);
    expect(launched[0]?.[3]).toEqual({
      provider: 'openai-codex', model: 'gpt-original', reasoningEffort: 'xhigh',
    });
  });

  it('stops the mission without deleting durable events or session references', async () => {
    const current = startRun();
    repository.appendRunEvent({
      id: 'artifact-event',
      runId: current.runId,
      type: 'artifact.produced',
      occurredAt: 500,
      payload: { path: 'report.md' },
    });

    const response = await command('stop-1', {
      type: 'stop', runId: current.runId, reason: 'Travail abandonné',
    });

    expect(response.status).toBe(202);
    expect((database.prepare('SELECT * FROM tasks WHERE id = ?').get('mission-1') as Task).status)
      .toBe('done');
    expect(repository.getRunRecord(current.runId)).toMatchObject({
      sessionId: current.sessionId,
      status: 'cancelled',
      finishReason: 'operator-stop',
    });
    expect(repository.listRunEvents(current.runId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'artifact.produced', payload: { path: 'report.md' } }),
      expect.objectContaining({ type: 'run.cancelled', payload: { reason: 'operator-stop' } }),
    ]));
  });

  it('terminally cancels a blocked current attempt when stopping the mission', async () => {
    const current = startRun();
    repository.appendRunEvent({
      id: 'blocked-event',
      runId: current.runId,
      type: 'run.blocked',
      occurredAt: 500,
      payload: { reason: 'inactive' },
    });

    const response = await command('stop-blocked', {
      type: 'stop', runId: current.runId,
    });

    expect(response.status).toBe(202);
    expect(repository.getRunRecord(current.runId)).toMatchObject({
      status: 'cancelled', finishReason: 'operator-stop',
    });
    expect(hermes.interruptions).toEqual([]);
  });
});
