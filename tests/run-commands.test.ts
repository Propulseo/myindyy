import Database from 'better-sqlite3';
import express, { type Express } from 'express';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunsRouter, type LaunchCommandRun } from '../server/routes/runs.js';
import {
  InjectedCommandCrashError,
  recoverPendingInteractiveCommands,
  type CommandCrashSeams,
} from '../server/runs/operator-command-outbox.js';
import { createRunRepository, type RunRepository } from '../server/runs/repository.js';
import { createRunService, type RunService } from '../server/runs/service.js';
import type { MissionRun, SessionMetadata, Task } from '../shared/types.js';

const schema = readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8');
const TEST_PROXY_SECRET = 'test-only-run-command-proxy-secret';
const PRODUCTION_ENV_KEYS = [
  'NODE_ENV',
  'INDY_PUBLIC_ORIGIN',
  'INDY_PROXY_SECRET_FILE',
  'INDY_TRUSTED_PROXY_CIDRS',
  'MINIONS_HOME',
] as const;
const originalProductionEnv = Object.fromEntries(
  PRODUCTION_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof PRODUCTION_ENV_KEYS)[number], string | undefined>;

function configureProductionAuth(prefix: string): void {
  const directory = mkdtempSync(join(tmpdir(), 'indy-run-auth-'));
  const secretFile = join(directory, 'proxy-secret');
  writeFileSync(secretFile, `${TEST_PROXY_SECRET}\n`, { encoding: 'utf8', mode: 0o600 });
  process.env.NODE_ENV = 'production';
  process.env.INDY_PUBLIC_ORIGIN = 'https://indy.example.test';
  process.env.INDY_PROXY_SECRET_FILE = secretFile;
  process.env.INDY_TRUSTED_PROXY_CIDRS = '127.0.0.0/8,::1/128';
  process.env.MINIONS_HOME = mkdtempSync(join(tmpdir(), prefix));
}

function productionAuthHeaders(): Record<string, string> {
  return {
    'X-Indy-Proxy-Secret': TEST_PROXY_SECRET,
    'X-Indy-User': 'etienne',
  };
}

async function loadProductionApp(prefix: string) {
  configureProductionAuth(prefix);
  vi.resetModules();
  const [{ default: productionApp, adapter }, { default: productionDb }, liveChat] = await Promise.all([
    import('../server/app.js'),
    import('../server/db/index.js'),
    import('../server/live-chat.js'),
  ]);
  return { productionApp, adapter, productionDb, liveChat };
}

function restoreProductionEnvironment(): void {
  for (const key of PRODUCTION_ENV_KEYS) {
    const value = originalProductionEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

class FakeHermesBoundary {
  readonly interruptions: Array<{ sessionId: string; reason?: string }> = [];
  readonly sessions = new Map<string, SessionMetadata>();
  interruptResult = true;
  runtimeStatusError: Error | null = null;

  async interruptChat(sessionId: string, reason?: string): Promise<boolean> {
    this.interruptions.push({ sessionId, reason });
    return this.interruptResult;
  }

  async getSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async getRuntimeStatus() {
    if (this.runtimeStatusError) throw this.runtimeStatusError;
    return {
      provider: 'openai-codex' as const,
      profileId: 'etienne-openai',
      authState: 'connected' as const,
      checkedAt: new Date().toISOString(),
      models: [
        'gpt-source', 'gpt-original', 'gpt-mutated', 'task-current-model', 'gpt-race',
      ].map((id) => ({
        id,
        label: id,
        reasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const,
      })),
    };
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

  function mountCommandApp(options: {
    crashSeams?: CommandCrashSeams;
    leaseOwner?: () => string;
    leaseMs?: number;
    now?: () => number;
  } = {}): void {
    app = express();
    app.use((req, _res, next) => {
      req.actor = { id: 'etienne' };
      next();
    });
    app.use(express.json());
    app.use('/api/missions', createRunsRouter({
      database,
      adapter: hermes,
      runService: service,
      launchCommandRun: (...args) => launched.push(args),
      ...options,
    }));
  }

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
    mountCommandApp();
  });

  afterEach(() => {
    database.close();
    restoreProductionEnvironment();
    vi.resetModules();
  });

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
    const { productionApp, productionDb } = await loadProductionApp('indy-run-commands-');

    try {
      const response = await request(productionApp)
        .post('/api/missions/missing/commands')
        .set(productionAuthHeaders())
        .set('Idempotency-Key', 'cmd-route')
        .send({ type: 'interrupt', runId: 'missing-run' });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Mission not found' });
    } finally {
      productionDb.close();
    }
  });

  it('keeps a corrected successor streaming when the interrupted goal finishes late', async () => {
    const { productionApp, adapter, productionDb, liveChat } = await loadProductionApp('indy-run-race-');
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
      profileId: 'etienne-openai',
      authState: 'connected',
      checkedAt: new Date().toISOString(),
      models: [{ id: 'gpt-race', label: 'gpt-race', reasoningEfforts: ['high'] }],
    });
    const writes: string[] = [];
    let closeSubscriber = () => {};

    try {
      const goal = await request(productionApp)
        .post(`/api/tasks/${taskId}/messages`)
        .set(productionAuthHeaders())
        .send({ content: 'Original goal', mode: 'goal' });
      expect(goal.status).toBe(202);
      await oldConsumed;

      const correction = await request(productionApp)
        .post(`/api/missions/${taskId}/commands`)
        .set(productionAuthHeaders())
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
        .set(productionAuthHeaders())
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
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      productionDb.close();
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

  it('serializes different command keys for the same mission before any second effect', async () => {
    const current = startRun();
    let releaseInterrupt!: () => void;
    const interruptGate = new Promise<void>((resolve) => { releaseInterrupt = resolve; });
    vi.spyOn(hermes, 'interruptChat').mockImplementation(async (sessionId, reason) => {
      hermes.interruptions.push({ sessionId, reason });
      await interruptGate;
      return true;
    });

    const firstPromise = command('mission-lock-a', {
      type: 'interrupt', runId: current.runId, reason: 'first',
    });
    await vi.waitFor(() => {
      expect(repository.getCommand('mission-lock-a')?.phase).toBe('interrupting');
    });
    const second = await command('mission-lock-b', {
      type: 'interrupt', runId: current.runId, reason: 'second',
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('MISSION_COMMAND_BUSY');
    expect(repository.getCommand('mission-lock-b')).toBeUndefined();
    expect(hermes.interruptions).toHaveLength(1);

    releaseInterrupt();
    expect((await firstPromise).status).toBe(202);
  });

  it('rejects a stale overlapping correction after another key advances the current attempt', async () => {
    const current = startRun();
    confirm(current.runId, 'native-overlap');
    const runtimeStatus = await hermes.getRuntimeStatus();
    let enteredAdmissions = 0;
    let bothAdmissionsEntered!: () => void;
    const admissionsEntered = new Promise<void>((resolve) => { bothAdmissionsEntered = resolve; });
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstAdmission = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondAdmission = new Promise<void>((resolve) => { releaseSecond = resolve; });
    vi.spyOn(hermes, 'getRuntimeStatus').mockImplementation(async () => {
      const admission = enteredAdmissions++ === 0 ? firstAdmission : secondAdmission;
      if (enteredAdmissions === 2) bothAdmissionsEntered();
      await admission;
      return runtimeStatus;
    });

    const firstPromise = command('overlap-correct-a', {
      type: 'correct', runId: current.runId, reason: 'first correction',
    });
    const secondPromise = command('overlap-correct-b', {
      type: 'correct', runId: current.runId, reason: 'second correction',
    });
    await admissionsEntered;

    releaseFirst();
    const first = await firstPromise;
    expect(first.status).toBe(202);
    releaseSecond();
    const second = await secondPromise;

    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: 'runId must be the current attempt for this mission' });
    expect(repository.getCommand('overlap-correct-b')).toBeUndefined();
    expect(repository.listMissionRuns('mission-1')).toHaveLength(2);
    expect(hermes.interruptions).toHaveLength(1);
    expect(launched).toHaveLength(1);
  });

  it('keeps worker credential diagnostics out of HTTP and the durable command result', async () => {
    const current = startRun();
    const diagnostic = [
      'Authorization: Bearer http-bearer-secret',
      'Authorization: Basic aHR0cC11c2VyOmh0dHAtcGFzcw==',
      'Authorization: Digest username="http-digest-user", nonce="http-digest-nonce", response="http-digest-response"',
      '{"token":"http-token-secret","credential":"http-credential-secret","password":"http-password-secret"}',
    ].join('\n');
    vi.spyOn(hermes, 'interruptChat').mockRejectedValue(new Error(diagnostic));

    const response = await command('http-secret-boundary', {
      type: 'interrupt', runId: current.runId, reason: 'safe reason',
    });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'Command outcome requires operator reconciliation',
      code: 'COMMAND_OUTCOME_UNKNOWN',
      type: 'interrupt',
      missionId: 'mission-1',
      runId: current.runId,
      status: 'unknown',
    });
    expect(repository.getCommand('http-secret-boundary')).toMatchObject({
      status: 'needs_reconciliation', phase: 'needs_reconciliation',
    });
    expect(repository.getRunRecord(current.runId)?.status).toBe('unknown');
    const persisted = database.prepare(`
      SELECT payload_json, effect_receipt_json, result_json
      FROM operator_commands WHERE idempotency_key = ?
    `).get('http-secret-boundary');
    const exposed = JSON.stringify({ response: response.body, persisted });
    for (const secret of [
      'http-bearer-secret', 'aHR0cC11c2VyOmh0dHAtcGFzcw==',
      'http-digest-user', 'http-digest-nonce', 'http-digest-response',
      'http-token-secret', 'http-credential-secret', 'http-password-secret',
    ]) expect(exposed).not.toContain(secret);
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

  it('rejects every generic run command for a cron projection before any Hermes side effect', async () => {
    database.prepare(`
      INSERT INTO tasks (
        id, title, description, status, mission_kind, agent_model, agent_provider,
        reasoning_effort, created_at, updated_at
      ) VALUES (?, ?, ?, 'done', 'cron', ?, ?, ?, 1, 1)
    `).run('cron:scheduled-1', 'Projected cron', 'Hermes-owned', 'gpt-5.6-sol', 'openai-codex', 'high');
    database.prepare(`
      INSERT INTO mission_runs (
        id, mission_id, session_id, attempt, provider, model, reasoning_effort,
        status, last_activity_at, occurrence_key
      ) VALUES (?, ?, ?, 1, ?, ?, ?, 'failed', 1, ?)
    `).run('cron-run-1', 'cron:scheduled-1', 'cron-session', 'openai-codex', 'gpt-5.6-sol', 'high', 'cron:scheduled-1:occurrence-1');

    for (const type of ['interrupt', 'correct', 'resume', 'retry', 'stop'] as const) {
      const response = await request(app)
        .post('/api/missions/cron:scheduled-1/commands')
        .set('Idempotency-Key', `cron-generic-${type}`)
        .send({ type, runId: 'cron-run-1', ...(type === 'correct' ? { reason: 'mutate cron' } : {}) });
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Mission not found' });
    }

    expect(hermes.interruptions).toEqual([]);
    expect(launched).toEqual([]);
    expect(database.prepare("SELECT status FROM tasks WHERE id = 'cron:scheduled-1'").get()).toEqual({ status: 'done' });
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

  it('keeps the targeted current runtime while reusing an older confirmed session', async () => {
    const confirmedRun = startRun({ model: 'gpt-source', reasoningEffort: 'high' });
    confirm(confirmedRun.runId, 'native-old-session');
    service.complete(confirmedRun.runId);
    const current = startRun({ model: 'task-current-model', reasoningEffort: 'low' });

    const response = await command('correct-runtime-source', {
      type: 'correct', runId: current.runId, reason: 'use current selection',
    });

    expect(response.status).toBe(202);
    expect(repository.getRunRecord(response.body.runId)).toMatchObject({
      sessionId: 'native-old-session',
      model: 'task-current-model',
      reasoningEffort: 'low',
    });
    expect(launched[0]?.[3]).toEqual({
      provider: 'openai-codex', model: 'task-current-model', reasoningEffort: 'low',
    });
  });

  it.each(['correct', 'resume', 'retry'] as const)(
    'rejects %s admission before claiming, interrupting, cancelling, or creating a run',
    async (type) => {
      const current = startRun();
      if (type === 'correct' || type === 'resume') confirm(current.runId, 'native-admission');
      if (type === 'resume' || type === 'retry') service.fail(current.runId, 'retryable');
      hermes.runtimeStatusError = new Error('Authorization: Bearer should-not-escape');
      const beforeRuns = repository.listMissionRuns('mission-1');

      const response = await command(`admission-${type}`, {
        type, runId: current.runId, reason: 'continue',
      });

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        error: 'Codex runtime status is unavailable', code: 'RUNTIME_UNAVAILABLE',
      });
      expect(repository.getCommand(`admission-${type}`)).toBeUndefined();
      expect(repository.listMissionRuns('mission-1')).toEqual(beforeRuns);
      expect(hermes.interruptions).toEqual([]);
      expect(launched).toEqual([]);
    },
  );

  it.each(['interrupt', 'stop'] as const)(
    'allows %s while runtime admission is unavailable',
    async (type) => {
      const current = startRun();
      hermes.runtimeStatusError = new Error('runtime unavailable');
      const response = await command(`runtime-down-${type}`, { type, runId: current.runId });
      expect(response.status).toBe(202);
      expect(hermes.interruptions).toHaveLength(1);
    },
  );

  it('admits a correction before its first interrupt side effect', async () => {
    const current = startRun();
    confirm(current.runId, 'native-order');
    const admission = vi.spyOn(hermes, 'getRuntimeStatus');
    const interrupt = vi.spyOn(hermes, 'interruptChat');

    expect((await command('admit-before-interrupt', {
      type: 'correct', runId: current.runId, reason: 'correct',
    })).status).toBe(202);
    expect(admission.mock.invocationCallOrder[0]).toBeLessThan(interrupt.mock.invocationCallOrder[0]!);
  });

  it('startup recovery terminalizes a legacy claimed command without repeating an effect', () => {
    const current = startRun();
    repository.claimCommand({
      idempotencyKey: 'legacy-interactive', actorId: 'etienne', missionId: 'mission-1',
      runId: current.runId, commandType: 'interrupt', payloadHash: 'legacy-hash', createdAt: 1,
    });

    expect(recoverPendingInteractiveCommands({
      database,
      runService: service,
      now: () => 100,
      leaseOwner: () => 'startup-owner',
    })).toBe(1);
    expect(repository.getCommand('legacy-interactive')).toMatchObject({
      status: 'needs_reconciliation', phase: 'needs_reconciliation',
      result: {
        httpStatus: 409,
        body: { code: 'COMMAND_OUTCOME_UNKNOWN', status: 'unknown' },
      },
    });
    expect(hermes.interruptions).toEqual([]);
  });

  it('startup recovery drains every expired command beyond one lease page', () => {
    for (let index = 0; index < 101; index += 1) {
      repository.claimCommand({
        idempotencyKey: `startup-page-${index}`,
        actorId: 'etienne',
        missionId: `recovery-mission-${index}`,
        runId: null,
        commandType: 'retry',
        payloadHash: `hash-${index}`,
        createdAt: index,
      });
    }

    expect(recoverPendingInteractiveCommands({
      database,
      runService: service,
      now: () => 1_000,
      leaseOwner: () => 'startup-page-owner',
    })).toBe(101);
    expect(repository.listPendingCommands()).toEqual([]);
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

  it('treats an unknown current attempt as potentially active before stopping it', async () => {
    const current = startRun();
    repository.updateRunStatus(current.runId, 'unknown');

    const response = await command('stop-unknown', {
      type: 'stop', runId: current.runId,
    });

    expect(response.status).toBe(202);
    expect(hermes.interruptions).toEqual([{ sessionId: current.sessionId, reason: undefined }]);
  });

  it('rejects retry of an unknown attempt before claiming or launching', async () => {
    const current = startRun();
    repository.updateRunStatus(current.runId, 'unknown');

    const response = await command('retry-unknown', {
      type: 'retry', runId: current.runId, reason: 'again',
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'Cannot retry an active attempt' });
    expect(repository.getCommand('retry-unknown')).toBeUndefined();
    expect(launched).toEqual([]);
  });

  it('returns the durable mission fence before unknown-state retry validation', async () => {
    const current = startRun();
    repository.updateRunStatus(current.runId, 'unknown');
    repository.claimCommand({
      idempotencyKey: 'unknown-fence', actorId: 'etienne', missionId: 'mission-1',
      runId: current.runId, commandType: 'interrupt', payloadHash: 'unknown-fence-hash',
    });
    const owner = 'unknown-fence-owner';
    expect(repository.leasePendingCommands({ owner, idempotencyKey: 'unknown-fence' })).toHaveLength(1);
    repository.markCommandNeedsReconciliation({
      idempotencyKey: 'unknown-fence', owner,
      result: { httpStatus: 409, body: { code: 'COMMAND_OUTCOME_UNKNOWN' } },
    });
    const beforeRun = repository.getRunRecord(current.runId);
    const beforeTask = database.prepare('SELECT * FROM tasks WHERE id = ?').get('mission-1');

    const response = await command('retry-behind-unknown-fence', {
      type: 'retry', runId: current.runId, reason: 'again',
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'Another operator command is already in progress for this mission',
      code: 'MISSION_COMMAND_BUSY',
    });
    expect(repository.getCommand('retry-behind-unknown-fence')).toBeUndefined();
    expect(repository.getRunRecord(current.runId)).toEqual(beforeRun);
    expect(database.prepare('SELECT * FROM tasks WHERE id = ?').get('mission-1')).toEqual(beforeTask);
    expect(hermes.interruptions).toEqual([]);
    expect(launched).toEqual([]);
  });

  it('returns the durable mission fence before stopped-mission validation', async () => {
    const current = startRun();
    service.complete(current.runId);
    database.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run('mission-1');
    repository.claimCommand({
      idempotencyKey: 'done-fence', actorId: 'etienne', missionId: 'mission-1',
      runId: current.runId, commandType: 'interrupt', payloadHash: 'done-fence-hash',
    });
    const owner = 'done-fence-owner';
    expect(repository.leasePendingCommands({ owner, idempotencyKey: 'done-fence' })).toHaveLength(1);
    repository.markCommandNeedsReconciliation({
      idempotencyKey: 'done-fence', owner,
      result: { httpStatus: 409, body: { code: 'COMMAND_OUTCOME_UNKNOWN' } },
    });
    const beforeRun = repository.getRunRecord(current.runId);
    const beforeTask = database.prepare('SELECT * FROM tasks WHERE id = ?').get('mission-1');

    const response = await command('stop-behind-done-fence', {
      type: 'stop', runId: current.runId,
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'Another operator command is already in progress for this mission',
      code: 'MISSION_COMMAND_BUSY',
    });
    expect(repository.getCommand('stop-behind-done-fence')).toBeUndefined();
    expect(repository.getRunRecord(current.runId)).toEqual(beforeRun);
    expect(database.prepare('SELECT * FROM tasks WHERE id = ?').get('mission-1')).toEqual(beforeTask);
    expect(hermes.interruptions).toEqual([]);
    expect(launched).toEqual([]);
  });

  it('recovers a proved interrupt without repeating it after a crash', async () => {
    const current = startRun();
    let clock = 100;
    mountCommandApp({
      now: () => clock,
      leaseMs: 5,
      leaseOwner: () => 'owner-a',
      crashSeams: {
        afterInterrupt: () => { throw new InjectedCommandCrashError('afterInterrupt'); },
      },
    });

    const first = await command('crash-after-interrupt', {
      type: 'interrupt', runId: current.runId, reason: 'pause',
    });
    expect(first.status).toBe(503);
    expect(repository.getCommand('crash-after-interrupt')).toMatchObject({
      status: 'claimed', phase: 'interrupted', effectReceipt: { interrupted: true },
    });

    clock = 106;
    mountCommandApp({ now: () => clock, leaseMs: 5, leaseOwner: () => 'owner-b' });
    const replay = await command('crash-after-interrupt', {
      type: 'interrupt', runId: current.runId, reason: 'pause',
    });
    expect(replay.status).toBe(202);
    expect(repository.getCommand('crash-after-interrupt')).toMatchObject({
      status: 'completed', phase: 'completed',
    });
    expect(hermes.interruptions).toHaveLength(1);
  });

  it('terminalizes an ambiguous post-interrupt crash as unknown without a duplicate effect', async () => {
    const current = startRun();
    let clock = 100;
    mountCommandApp({
      now: () => clock,
      leaseMs: 5,
      leaseOwner: () => 'owner-a',
      crashSeams: {
        afterInterruptBeforeReceipt: () => {
          throw new InjectedCommandCrashError('afterInterruptBeforeReceipt');
        },
      },
    });

    expect((await command('ambiguous-interrupt', {
      type: 'interrupt', runId: current.runId,
    })).status).toBe(503);
    expect(repository.getCommand('ambiguous-interrupt')?.phase).toBe('interrupting');

    clock = 106;
    mountCommandApp({ now: () => clock, leaseMs: 5, leaseOwner: () => 'owner-b' });
    const replay = await command('ambiguous-interrupt', {
      type: 'interrupt', runId: current.runId,
    });
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({ code: 'COMMAND_OUTCOME_UNKNOWN', status: 'unknown' });
    expect(repository.getCommand('ambiguous-interrupt')).toMatchObject({
      status: 'needs_reconciliation', phase: 'needs_reconciliation',
    });
    expect(hermes.interruptions).toHaveLength(1);

    const fenced = await command('after-ambiguous-interrupt', {
      type: 'stop', runId: current.runId,
    });
    expect(fenced.status).toBe(409);
    expect(fenced.body).toMatchObject({ code: 'MISSION_COMMAND_BUSY' });
    expect(repository.getCommand('after-ambiguous-interrupt')).toBeUndefined();
    expect(hermes.interruptions).toHaveLength(1);
  });

  it.each([
    ['afterAttemptCreationBeforeReceipt', 'attempt_prepared', 0, 'unknown'],
    ['afterAttemptCreated', 'attempt_created', 0, 'unknown'],
    ['afterLaunchBeforeReceipt', 'launching', 1, 'unknown'],
    ['afterLaunch', 'launched', 1, 'accepted'],
  ] as const)(
    'converges from %s without creating or launching a second retry',
    async (boundary, expectedPhase, expectedLaunches, expectedOutcome) => {
      const current = startRun();
      service.fail(current.runId, 'retryable failure');
      let clock = 100;
      mountCommandApp({
        now: () => clock,
        leaseMs: 5,
        leaseOwner: () => 'owner-a',
        crashSeams: {
          [boundary]: () => { throw new InjectedCommandCrashError(boundary); },
        },
      });

      const payload = { type: 'retry', runId: current.runId, reason: 'again' };
      expect((await command(`crash-${boundary}`, payload)).status).toBe(503);
      expect(repository.getCommand(`crash-${boundary}`)?.phase).toBe(expectedPhase);
      expect(repository.listMissionRuns('mission-1')).toHaveLength(2);
      expect(launched).toHaveLength(expectedLaunches);

      clock = 106;
      mountCommandApp({ now: () => clock, leaseMs: 5, leaseOwner: () => 'owner-b' });
      const replay = await command(`crash-${boundary}`, payload);
      expect(replay.status).toBe(expectedOutcome === 'accepted' ? 202 : 409);
      expect(replay.body.status).toBe(expectedOutcome);
      expect(repository.listMissionRuns('mission-1')).toHaveLength(2);
      expect(launched).toHaveLength(expectedLaunches);
      expect(repository.getCommand(`crash-${boundary}`)?.status).toBe(
        expectedOutcome === 'accepted' ? 'completed' : 'needs_reconciliation',
      );
    },
  );

  it('terminalizes an ordinary post-launch acknowledgement failure as unknown immediately', async () => {
    const current = startRun();
    service.fail(current.runId, 'retryable failure');
    mountCommandApp({
      crashSeams: {
        afterLaunchBeforeReceipt: () => {
          throw new Error('provider rejected opaque-launch-secret-123456789');
        },
      },
    });

    const response = await command('ordinary-post-launch-failure', {
      type: 'retry', runId: current.runId, reason: 'again',
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'COMMAND_OUTCOME_UNKNOWN', status: 'unknown',
    });
    expect(JSON.stringify(response.body)).not.toContain('opaque-launch-secret-123456789');
    expect(repository.getCommand('ordinary-post-launch-failure')).toMatchObject({
      status: 'needs_reconciliation', phase: 'needs_reconciliation',
    });
    expect(repository.listMissionRuns('mission-1').at(-1)?.status).toBe('unknown');
    expect(launched).toHaveLength(1);
  });

  it('recovers a durable stop mutation without interrupting or stopping twice', async () => {
    const current = startRun();
    let clock = 100;
    mountCommandApp({
      now: () => clock,
      leaseMs: 5,
      leaseOwner: () => 'owner-a',
      crashSeams: {
        afterStopMutation: () => { throw new InjectedCommandCrashError('afterStopMutation'); },
      },
    });
    const payload = { type: 'stop', runId: current.runId, reason: 'done' };
    expect((await command('crash-stop', payload)).status).toBe(503);
    expect(repository.getCommand('crash-stop')?.phase).toBe('stopped');

    clock = 106;
    mountCommandApp({ now: () => clock, leaseMs: 5, leaseOwner: () => 'owner-b' });
    const replay = await command('crash-stop', payload);
    expect(replay.status).toBe(202);
    expect(hermes.interruptions).toHaveLength(1);
    expect(repository.listRunEvents(current.runId).filter((event) => event.type === 'run.cancelled'))
      .toHaveLength(1);
  });

  it('terminalizes a stop crash before its receipt without repeating the mutation', async () => {
    const current = startRun();
    let clock = 100;
    mountCommandApp({
      now: () => clock,
      leaseMs: 5,
      leaseOwner: () => 'owner-a',
      crashSeams: {
        afterStopMutationBeforeReceipt: () => {
          throw new InjectedCommandCrashError('afterStopMutationBeforeReceipt');
        },
      },
    });
    const payload = { type: 'stop', runId: current.runId, reason: 'done' };

    expect((await command('ambiguous-stop', payload)).status).toBe(503);
    expect(repository.getCommand('ambiguous-stop')).toMatchObject({
      status: 'claimed', phase: 'stopping',
    });
    expect(repository.getRunRecord(current.runId)?.status).toBe('cancelled');
    expect((database.prepare('SELECT status FROM tasks WHERE id = ?').get('mission-1') as Task).status)
      .toBe('done');

    clock = 106;
    mountCommandApp({ now: () => clock, leaseMs: 5, leaseOwner: () => 'owner-b' });
    const replay = await command('ambiguous-stop', payload);

    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({ code: 'COMMAND_OUTCOME_UNKNOWN', status: 'unknown' });
    expect(repository.getCommand('ambiguous-stop')).toMatchObject({
      status: 'needs_reconciliation', phase: 'needs_reconciliation',
    });
    expect(hermes.interruptions).toHaveLength(1);
    expect(repository.listRunEvents(current.runId).filter((event) => event.type === 'run.cancelled'))
      .toHaveLength(1);
  });

  it.each(['interrupt', 'correct', 'resume', 'retry', 'stop'] as const)(
    'replays %s from its effect receipt when completion crashes',
    async (type) => {
      const current = startRun();
      if (type === 'correct' || type === 'resume') confirm(current.runId, 'native-session-receipt');
      if (type === 'resume' || type === 'retry') service.fail(current.runId, 'retryable failure');
      let clock = 100;
      mountCommandApp({
        now: () => clock,
        leaseMs: 5,
        leaseOwner: () => 'owner-a',
        crashSeams: {
          beforeCompleteCommand: () => {
            throw new InjectedCommandCrashError('beforeCompleteCommand');
          },
        },
      });
      const payload = {
        type,
        runId: current.runId,
        ...((type === 'correct' || type === 'resume' || type === 'retry') ? { reason: 'continue' } : {}),
      };

      expect((await command(`before-complete-${type}`, payload)).status).toBe(503);
      clock = 106;
      mountCommandApp({ now: () => clock, leaseMs: 5, leaseOwner: () => 'owner-b' });
      const replay = await command(`before-complete-${type}`, payload);
      expect(replay.status).toBe(202);
      expect(replay.body.status).toBe('accepted');
      expect(repository.getCommand(`before-complete-${type}`)?.status).toBe('completed');
      expect(launched).toHaveLength(['correct', 'resume', 'retry'].includes(type) ? 1 : 0);
      expect(hermes.interruptions).toHaveLength(['interrupt', 'correct', 'stop'].includes(type) ? 1 : 0);
    },
  );
});
