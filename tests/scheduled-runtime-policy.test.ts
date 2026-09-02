import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ScheduledTask, ScheduledTaskInput } from '../shared/types.js';
import type { RuntimeStatus } from '../server/runtime/hermes-runtime.js';
import {
  createScheduledTasksRouter,
  recoverPendingCronDispatches,
  startCronDispatchRecoveryLoop,
} from '../server/routes/scheduled-tasks.js';
import { createDatabase } from '../server/db/index.js';
import { createRunRepository, type RunRepository } from '../server/runs/repository.js';
import {
  createScheduledWorkdirRegistry,
  validateScheduledTask,
} from '../server/scheduled-tasks/policy.js';

const CONNECTED_RUNTIME: RuntimeStatus = {
  provider: 'openai-codex',
  profileId: 'etienne-openai',
  authState: 'connected',
  checkedAt: '2026-09-02T08:00:00.000Z',
  models: [{
    id: 'gpt-5.6-sol',
    label: 'gpt-5.6-sol',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
  }],
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'indy-cron-policy-'));
  const allowed = join(root, 'allowed');
  const child = join(allowed, 'client');
  const outside = join(root, 'outside');
  mkdirSync(child, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const registry = createScheduledWorkdirRegistry([allowed]);
  const valid: ScheduledTaskInput = {
    name: 'Brief quotidien',
    prompt: 'Préparer le brief.',
    schedule: '0 8 * * *',
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    workdir: child,
  };
  return { allowed, child, outside, registry, valid };
}

describe('scheduled Codex runtime policy', () => {
  it.each([
    ['provider', undefined, 'SCHEDULED_PROVIDER_REQUIRED'],
    ['provider', 'openai', 'SCHEDULED_PROVIDER_UNSUPPORTED'],
    ['model', undefined, 'SCHEDULED_MODEL_REQUIRED'],
    ['model', 'gpt-retired', 'SCHEDULED_MODEL_UNAVAILABLE'],
    ['reasoningEffort', undefined, 'SCHEDULED_EFFORT_REQUIRED'],
    ['reasoningEffort', 'minimal', 'SCHEDULED_EFFORT_UNSUPPORTED'],
    ['workdir', undefined, 'SCHEDULED_WORKDIR_REQUIRED'],
  ] as const)('rejects invalid %s with an actionable typed error', (field, value, code) => {
    const { registry, valid } = fixture();
    const result = validateScheduledTask({ ...valid, [field]: value }, CONNECTED_RUNTIME, registry);

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code, field }),
    }));
  });

  it('fails closed when Hermes does not publish effort support for the selected model', () => {
    const { registry, valid } = fixture();
    const result = validateScheduledTask(valid, {
      ...CONNECTED_RUNTIME,
      models: [{ id: 'gpt-5.6-sol', label: 'gpt-5.6-sol', reasoningEfforts: null }],
    }, registry);

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'SCHEDULED_EFFORT_CAPABILITIES_UNAVAILABLE' }),
    }));
  });

  it.each([
    [{ ...CONNECTED_RUNTIME, authState: 'expired' as const }, 'SCHEDULED_OAUTH_EXPIRED'],
    [{ ...CONNECTED_RUNTIME, authState: 'missing' as const }, 'SCHEDULED_OAUTH_MISSING'],
    [{ ...CONNECTED_RUNTIME, profileId: 'another-profile' }, 'SCHEDULED_PROFILE_UNSUPPORTED'],
  ])('requires connected OAuth on the exact Etienne profile', (runtime, code) => {
    const { registry, valid } = fixture();
    const result = validateScheduledTask(valid, runtime, registry);

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code }),
    }));
  });

  it('canonicalizes an allowed descendant and rejects traversal outside the registry', () => {
    const { allowed, child, outside, registry, valid } = fixture();
    const accepted = validateScheduledTask({
      ...valid,
      workdir: join(allowed, '.', 'client'),
    }, CONNECTED_RUNTIME, registry);
    const escaped = validateScheduledTask({
      ...valid,
      workdir: join(allowed, '..', 'outside'),
    }, CONNECTED_RUNTIME, registry);

    expect(accepted).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({ workdir: child }),
    }));
    expect(escaped).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: 'SCHEDULED_WORKDIR_NOT_ALLOWED',
        field: 'workdir',
      }),
    }));
    expect(outside).not.toBe(child);
  });

  it('rejects an allowlisted path whose symlink target escapes the registry', () => {
    const { allowed, outside, registry, valid } = fixture();
    const escapeLink = join(allowed, 'linked-outside');
    symlinkSync(outside, escapeLink, 'junction');

    const result = validateScheduledTask({ ...valid, workdir: escapeLink }, CONNECTED_RUNTIME, registry);

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: 'SCHEDULED_WORKDIR_NOT_ALLOWED',
        field: 'workdir',
      }),
    }));
  });

  it('accepts only an explicit supported Codex configuration', () => {
    const { child, registry, valid } = fixture();

    expect(validateScheduledTask(valid, CONNECTED_RUNTIME, registry)).toEqual({
      ok: true,
      value: {
        provider: 'openai-codex',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'high',
        workdir: child,
      },
    });
  });
});

type RuntimeScheduledTask = ScheduledTask & { reasoningEffort: ScheduledTaskInput['reasoningEffort'] };

function scheduledTaskRecord(input: ScheduledTaskInput, id = 'cron-policy-1'): RuntimeScheduledTask {
  return {
    id,
    name: input.name ?? id,
    prompt: input.prompt,
    schedule: { kind: 'cron', expr: input.schedule },
    scheduleDisplay: input.schedule,
    enabled: true,
    state: 'scheduled',
    nextRunAt: '2026-09-03T08:00:00.000Z',
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    lastDeliveryError: null,
    model: input.model ?? null,
    provider: input.provider ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    baseUrl: null,
    deliver: 'local',
    origin: null,
    repeat: null,
    contextFrom: [],
    skills: [],
    workdir: input.workdir ?? null,
    createdAt: '2026-09-02T08:00:00.000Z',
  };
}

function routeFixture(overrides: {
  runtime?: RuntimeStatus;
  task?: RuntimeScheduledTask;
  runtimeError?: Error;
  runRepository?: RunRepository;
} = {}) {
  const paths = fixture();
  const fallbackDatabase = overrides.runRepository ? null : createDatabase(':memory:');
  const task = overrides.task ?? scheduledTaskRecord(paths.valid);
  const adapter = {
    getRuntimeStatus: overrides.runtimeError
      ? vi.fn().mockRejectedValue(overrides.runtimeError)
      : vi.fn().mockResolvedValue(overrides.runtime ?? CONNECTED_RUNTIME),
    listScheduledTasks: vi.fn().mockResolvedValue([task]),
    getScheduledTask: vi.fn().mockResolvedValue(task),
    createScheduledTask: vi.fn().mockImplementation(async (input: ScheduledTaskInput) => scheduledTaskRecord(input, 'created')),
    updateScheduledTask: vi.fn().mockImplementation(async (_id: string, updates: Partial<ScheduledTaskInput>) => (
      { ...task, ...updates }
    )),
    pauseScheduledTask: vi.fn(),
    resumeScheduledTask: vi.fn(),
    getScheduledTaskDispatchReceipt: vi.fn().mockResolvedValue(null),
    runScheduledTask: vi.fn().mockImplementation(async (_id: string, dispatchToken: string) => ({
      scheduledTask: task,
      dispatchReceipt: { token: dispatchToken, state: 'accepted' as const },
    })),
    removeScheduledTask: vi.fn(),
  };
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    _req.actor = { id: 'etienne' };
    next();
  });
  app.use('/api/scheduled-tasks', createScheduledTasksRouter(adapter as never, {
    workdirRegistry: paths.registry,
    runRepository: overrides.runRepository ?? createRunRepository(fallbackDatabase!),
  } as never));
  return { ...paths, adapter, app, task, fallbackDatabase };
}

const INVALID_RUNTIME_FIELDS = [
  { field: 'provider', wrong: 'openai', missing: undefined, wrongCode: 'SCHEDULED_PROVIDER_UNSUPPORTED', missingCode: 'SCHEDULED_PROVIDER_REQUIRED' },
  { field: 'model', wrong: 'gpt-retired', missing: undefined, wrongCode: 'SCHEDULED_MODEL_UNAVAILABLE', missingCode: 'SCHEDULED_MODEL_REQUIRED' },
  { field: 'reasoningEffort', wrong: 'minimal', missing: undefined, wrongCode: 'SCHEDULED_EFFORT_UNSUPPORTED', missingCode: 'SCHEDULED_EFFORT_REQUIRED' },
] as const;

describe('scheduled task HTTP policy boundary', () => {
  it.each(INVALID_RUNTIME_FIELDS.flatMap((entry) => [
    { ...entry, variant: 'wrong' as const, value: entry.wrong, code: entry.wrongCode },
    { ...entry, variant: 'missing' as const, value: entry.missing, code: entry.missingCode },
  ]))('rejects $variant $field on create before mutating Hermes', async ({ field, value, code }) => {
    const { adapter, app, valid } = routeFixture();

    const response = await request(app).post('/api/scheduled-tasks').send({ ...valid, [field]: value });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body).toEqual(expect.objectContaining({ code, field }));
    expect(adapter.createScheduledTask).not.toHaveBeenCalled();
    expect(adapter.getRuntimeStatus).toHaveBeenCalledOnce();
  });

  it.each(INVALID_RUNTIME_FIELDS.flatMap((entry) => [
    { ...entry, variant: 'wrong' as const, value: entry.wrong, code: entry.wrongCode },
    { ...entry, variant: 'missing' as const, value: entry.missing, code: entry.missingCode },
  ]))('rejects $variant $field on update before mutating Hermes', async ({ field, variant, value, code }) => {
    const { adapter, app } = routeFixture();

    const response = await request(app)
      .patch('/api/scheduled-tasks/cron-policy-1')
      .send({ [field]: variant === 'missing' ? null : value });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body).toEqual(expect.objectContaining({ code, field }));
    expect(adapter.updateScheduledTask).not.toHaveBeenCalled();
    expect(adapter.getRuntimeStatus).toHaveBeenCalledOnce();
  });

  it.each(INVALID_RUNTIME_FIELDS.flatMap((entry) => [
    { ...entry, variant: 'wrong' as const, value: entry.wrong, code: entry.wrongCode },
    { ...entry, variant: 'missing' as const, value: entry.missing, code: entry.missingCode },
  ]))('rejects $variant $field on run-now before triggering Hermes', async ({ field, variant, value, code }) => {
    const paths = fixture();
    const invalidTask = scheduledTaskRecord({ ...paths.valid, [field]: value });
    const { adapter, app } = routeFixture({ task: invalidTask });

    const response = await request(app)
      .post('/api/scheduled-tasks/cron-policy-1/run')
      .set('Idempotency-Key', `run-${field}-${variant}`);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body).toEqual(expect.objectContaining({ code, field }));
    expect(adapter.runScheduledTask).not.toHaveBeenCalled();
    expect(adapter.getRuntimeStatus).toHaveBeenCalledOnce();
  });

  it.each(['create', 'update', 'run'] as const)('rejects missing workdir on %s before any Hermes mutation', async (operation) => {
    const paths = fixture();
    const task = scheduledTaskRecord({ ...paths.valid, workdir: undefined });
    const { adapter, app, valid } = routeFixture({ task });
    const response = operation === 'create'
      ? await request(app).post('/api/scheduled-tasks').send({ ...valid, workdir: undefined })
      : operation === 'update'
        ? await request(app).patch('/api/scheduled-tasks/cron-policy-1').send({ workdir: null })
        : await request(app).post('/api/scheduled-tasks/cron-policy-1/run').set('Idempotency-Key', 'missing-workdir');

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({ code: 'SCHEDULED_WORKDIR_REQUIRED', field: 'workdir' }));
    expect(adapter.createScheduledTask).not.toHaveBeenCalled();
    expect(adapter.updateScheduledTask).not.toHaveBeenCalled();
    expect(adapter.runScheduledTask).not.toHaveBeenCalled();
  });

  it.each(['create', 'update', 'run'] as const)('rejects an escaped workdir on %s before any Hermes mutation', async (operation) => {
    const paths = fixture();
    const escapedTask = scheduledTaskRecord({ ...paths.valid, workdir: paths.outside });
    const { adapter, app, valid } = routeFixture({ task: escapedTask });
    const response = operation === 'create'
      ? await request(app).post('/api/scheduled-tasks').send({ ...valid, workdir: paths.outside })
      : operation === 'update'
        ? await request(app).patch('/api/scheduled-tasks/cron-policy-1').send({ workdir: paths.outside })
        : await request(app).post('/api/scheduled-tasks/cron-policy-1/run').set('Idempotency-Key', 'escaped-workdir');

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({ code: 'SCHEDULED_WORKDIR_NOT_ALLOWED', field: 'workdir' }));
    expect(adapter.createScheduledTask).not.toHaveBeenCalled();
    expect(adapter.updateScheduledTask).not.toHaveBeenCalled();
    expect(adapter.runScheduledTask).not.toHaveBeenCalled();
  });

  it.each(['create', 'update'] as const)('fails closed on %s when the fresh runtime catalog cannot be loaded', async (operation) => {
    const { adapter, app, valid } = routeFixture({ runtimeError: new Error('Bearer secret-must-not-escape') });
    const response = operation === 'create'
      ? await request(app).post('/api/scheduled-tasks').send(valid)
      : await request(app).patch('/api/scheduled-tasks/cron-policy-1').send({ prompt: 'Nouveau brief' });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: 'Le catalogue Codex OAuth frais est indisponible.',
      code: 'SCHEDULED_RUNTIME_UNAVAILABLE',
      field: 'runtime',
    });
    expect(response.text).not.toContain('secret-must-not-escape');
    expect(adapter.createScheduledTask).not.toHaveBeenCalled();
    expect(adapter.updateScheduledTask).not.toHaveBeenCalled();
    expect(adapter.runScheduledTask).not.toHaveBeenCalled();
  });

  it('keeps a run command pending across a transient catalog outage and replays one accepted dispatch', async () => {
    const database = createDatabase(':memory:');
    const runRepository = createRunRepository(database);
    const { adapter, app, registry } = routeFixture({ runRepository });
    adapter.getRuntimeStatus
      .mockRejectedValueOnce(new Error('Authorization: Digest username="operator", nonce="catalog-secret"'))
      .mockResolvedValue(CONNECTED_RUNTIME);
    try {
      const pending = await request(app).post('/api/scheduled-tasks/cron-policy-1/run')
        .set('Idempotency-Key', 'runtime-recovers');
      expect(pending.status).toBe(202);
      expect(pending.body).toMatchObject({ accepted: false, pending: true });
      expect(runRepository.listPendingCommands('cron.run')).toHaveLength(1);
      expect(adapter.runScheduledTask).not.toHaveBeenCalled();

      expect(await recoverPendingCronDispatches(adapter as never, runRepository, registry)).toEqual({
        recovered: 1,
        deferred: 0,
      });
      const replay = await request(app).post('/api/scheduled-tasks/cron-policy-1/run')
        .set('Idempotency-Key', 'runtime-recovers');
      expect(replay.status).toBe(202);
      expect(replay.body).toMatchObject({ pending: true, dispatchAccepted: true });
      expect(adapter.runScheduledTask).toHaveBeenCalledOnce();
      expect(runRepository.listPendingCommands('cron.run')).toHaveLength(0);
    } finally { database.close(); }
  });

  it('replays a duplicate manual command without triggering Hermes twice', async () => {
    const database = createDatabase(':memory:');
    const runRepository = createRunRepository(database, { now: () => 100 });
    const { adapter, app } = routeFixture({ runRepository });

    try {
      const first = await request(app)
        .post('/api/scheduled-tasks/cron-policy-1/run')
        .set('Idempotency-Key', 'manual-cron-1')
        .send({ source: 'toolbar' });
      const replay = await request(app)
        .post('/api/scheduled-tasks/cron-policy-1/run')
        .set('Idempotency-Key', 'manual-cron-1')
        .send({ source: 'toolbar' });

      expect(first.status).toBe(202);
      expect(replay.status).toBe(202);
      expect(replay.body).toEqual(first.body);
      expect(first.body).toEqual({
        accepted: false,
        pending: true,
        dispatchAccepted: true,
        durableRun: null,
        dispatchToken: expect.any(String),
        idempotencyKey: 'manual-cron-1',
        scheduledTaskId: 'cron-policy-1',
      });
      expect(adapter.runScheduledTask).toHaveBeenCalledOnce();
      expect(database.prepare('SELECT COUNT(*) AS count FROM mission_runs').get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('claims before lookup/policy so stored refusal replays after deletion/runtime expiry', async () => {
    const database = createDatabase(':memory:');
    const runRepository = createRunRepository(database, { now: () => 100 });
    const invalid = scheduledTaskRecord({ ...fixture().valid, provider: 'openai' });
    const { adapter, app } = routeFixture({ runRepository, task: invalid });
    try {
      const first = await request(app).post('/api/scheduled-tasks/cron-policy-1/run')
        .set('Idempotency-Key', 'stored-refusal');
      adapter.getScheduledTask.mockResolvedValueOnce(null);
      adapter.getRuntimeStatus.mockRejectedValueOnce(new Error('expired'));
      const replay = await request(app).post('/api/scheduled-tasks/cron-policy-1/run')
        .set('Idempotency-Key', 'stored-refusal');

      expect(first.status).toBe(400);
      expect(replay.status).toBe(400);
      expect(replay.body).toEqual(first.body);
      expect(adapter.getScheduledTask).toHaveBeenCalledOnce();
      expect(adapter.getRuntimeStatus).toHaveBeenCalledOnce();
      expect(adapter.runScheduledTask).not.toHaveBeenCalled();
    } finally { database.close(); }
  });

  it('returns a truthful pending replay while the command owner is unresolved', async () => {
    const database = createDatabase(':memory:');
    const runRepository = createRunRepository(database);
    const { adapter, app } = routeFixture({ runRepository });
    let release!: () => void;
    adapter.runScheduledTask.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ scheduledTask: routeFixture().task, dispatchReceipt: { token: 'owner', state: 'accepted' } });
    }));
    try {
      const ownerPromise = request(app).post('/api/scheduled-tasks/cron-policy-1/run')
        .set('Idempotency-Key', 'concurrent-owner').then((response) => response);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const duplicate = await request(app).post('/api/scheduled-tasks/cron-policy-1/run')
        .set('Idempotency-Key', 'concurrent-owner');
      expect(duplicate.status).toBe(202);
      expect(duplicate.body).toMatchObject({ accepted: false, pending: true });
      expect(duplicate.body).not.toHaveProperty('dispatchAccepted');
      release();
      await ownerPromise;
      expect(adapter.runScheduledTask).toHaveBeenCalledOnce();
    } finally { database.close(); }
  });

  it('recovers a crash-before-receipt outbox entry on restart with the same dispatch token', async () => {
    const database = createDatabase(':memory:');
    const runRepository = createRunRepository(database);
    const { adapter, app, registry } = routeFixture({ runRepository });
    adapter.runScheduledTask.mockRejectedValueOnce(new Error('worker died after durable claim'));
    try {
      const pending = await request(app).post('/api/scheduled-tasks/cron-policy-1/run')
        .set('Idempotency-Key', 'restart-recovery');
      expect(pending.status).toBe(202);
      expect(pending.body).toMatchObject({ accepted: false, pending: true });
      expect(runRepository.listPendingCommands('cron.run')).toHaveLength(1);

      const result = await recoverPendingCronDispatches(adapter as never, runRepository, registry);
      const replay = await request(app).post('/api/scheduled-tasks/cron-policy-1/run')
        .set('Idempotency-Key', 'restart-recovery');
      expect(result).toEqual({ recovered: 1, deferred: 0 });
      expect(replay.body).toMatchObject({
        accepted: false, pending: true, dispatchAccepted: true,
        dispatchToken: pending.body.dispatchToken,
      });
      expect(adapter.runScheduledTask).toHaveBeenNthCalledWith(1, 'cron-policy-1', pending.body.dispatchToken);
      expect(adapter.runScheduledTask).toHaveBeenNthCalledWith(2, 'cron-policy-1', pending.body.dispatchToken);
    } finally { database.close(); }
  });

  it('replays an accepted Hermes receipt before task lookup or fresh policy after a crash', async () => {
    const database = createDatabase(':memory:');
    const runRepository = createRunRepository(database);
    const { adapter, app } = routeFixture({ runRepository });
    adapter.getScheduledTaskDispatchReceipt.mockImplementation(async (_id: string, token: string) => ({
      token, scheduledTaskId: 'cron-policy-1', state: 'accepted' as const, acceptedAt: '2026-09-02T08:00:00Z',
    }));
    adapter.getScheduledTask.mockRejectedValue(new Error('deleted'));
    adapter.getRuntimeStatus.mockRejectedValue(new Error('expired'));
    try {
      const response = await request(app).post('/api/scheduled-tasks/cron-policy-1/run')
        .set('Idempotency-Key', 'accepted-before-lookup');

      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({ pending: true, dispatchAccepted: true });
      expect(adapter.getScheduledTask).not.toHaveBeenCalled();
      expect(adapter.getRuntimeStatus).not.toHaveBeenCalled();
      expect(adapter.runScheduledTask).not.toHaveBeenCalled();
    } finally { database.close(); }
  });

  it('replays a failed Hermes receipt before mutable state and redacts its stored response', async () => {
    const database = createDatabase(':memory:');
    const runRepository = createRunRepository(database);
    const { adapter, app } = routeFixture({ runRepository });
    adapter.getScheduledTaskDispatchReceipt.mockImplementation(async (_id: string, token: string) => ({
      token,
      scheduledTaskId: 'cron-policy-1',
      state: 'failed' as const,
      failedAt: '2026-09-02T08:00:00Z',
      code: 'bad_request',
      status: 400,
      message: 'Authorization: Basic failed-receipt-secret',
    }));
    adapter.getScheduledTask.mockRejectedValue(new Error('deleted'));
    adapter.getRuntimeStatus.mockRejectedValue(new Error('expired'));
    try {
      const first = await request(app).post('/api/scheduled-tasks/cron-policy-1/run')
        .set('Idempotency-Key', 'failed-before-lookup');
      const replay = await request(app).post('/api/scheduled-tasks/cron-policy-1/run')
        .set('Idempotency-Key', 'failed-before-lookup');

      expect(first.status).toBe(400);
      expect(replay.body).toEqual(first.body);
      expect(first.text).not.toContain('failed-receipt-secret');
      expect(adapter.getScheduledTaskDispatchReceipt).toHaveBeenCalledOnce();
      expect(adapter.getScheduledTask).not.toHaveBeenCalled();
      expect(adapter.getRuntimeStatus).not.toHaveBeenCalled();
      expect(adapter.runScheduledTask).not.toHaveBeenCalled();
    } finally { database.close(); }
  });

  it('stores deterministic worker refusal and replays it instead of pending forever', async () => {
    const database = createDatabase(':memory:');
    const runRepository = createRunRepository(database);
    const { adapter, app } = routeFixture({ runRepository });
    adapter.runScheduledTask.mockRejectedValue(Object.assign(new Error('terminal'), { code: 'bad_request' }));
    try {
      const first = await request(app).post('/api/scheduled-tasks/cron-policy-1/run')
        .set('Idempotency-Key', 'permanent-worker-refusal');
      const replay = await request(app).post('/api/scheduled-tasks/cron-policy-1/run')
        .set('Idempotency-Key', 'permanent-worker-refusal');

      expect(first.status).toBe(400);
      expect(replay.status).toBe(400);
      expect(replay.body).toEqual(first.body);
      expect(adapter.runScheduledTask).toHaveBeenCalledOnce();
      expect(runRepository.listPendingCommands('cron.run')).toHaveLength(0);
    } finally { database.close(); }
  });

  it('leases a pending command so concurrent recovery never double-dispatches', async () => {
    const database = createDatabase(':memory:');
    const runRepository = createRunRepository(database);
    const { adapter, registry } = routeFixture({ runRepository });
    runRepository.claimCommand({
      idempotencyKey: 'concurrent-recovery', actorId: 'etienne', missionId: 'cron:cron-policy-1',
      commandType: 'cron.run', payloadHash: 'same',
    });
    let release!: () => void;
    adapter.runScheduledTask.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({
        scheduledTask: scheduledTaskRecord(fixture().valid),
        dispatchReceipt: { token: 'token', state: 'accepted' as const },
      });
    }));
    try {
      const first = recoverPendingCronDispatches(adapter as never, runRepository, registry);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const second = recoverPendingCronDispatches(adapter as never, runRepository, registry);
      release();
      await Promise.all([first, second]);
      expect(adapter.runScheduledTask).toHaveBeenCalledOnce();
    } finally { database.close(); }
  });

  it('passively retries transient startup failure with bounded non-overlapping recovery', async () => {
    vi.useFakeTimers();
    const database = createDatabase(':memory:');
    const runRepository = createRunRepository(database);
    const { adapter, registry } = routeFixture({ runRepository });
    runRepository.claimCommand({
      idempotencyKey: 'loop-recovery', actorId: 'etienne', missionId: 'cron:cron-policy-1',
      commandType: 'cron.run', payloadHash: 'same',
    });
    adapter.getScheduledTaskDispatchReceipt.mockRejectedValueOnce(new Error('worker unavailable'));
    try {
      const loop = startCronDispatchRecoveryLoop(adapter as never, runRepository, registry, { intervalMs: 100 });
      await loop.ready;
      expect(runRepository.listPendingCommands('cron.run')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(adapter.runScheduledTask).toHaveBeenCalledOnce();
      expect(runRepository.listPendingCommands('cron.run')).toHaveLength(0);
      loop.stop();
    } finally { vi.useRealTimers(); database.close(); }
  });

  it('returns 409 when a manual idempotency key is reused with a different payload', async () => {
    const database = createDatabase(':memory:');
    const runRepository = createRunRepository(database, { now: () => 100 });
    const { adapter, app } = routeFixture({ runRepository });

    try {
      const first = await request(app)
        .post('/api/scheduled-tasks/cron-policy-1/run')
        .set('Idempotency-Key', 'manual-cron-conflict')
        .send({ source: 'toolbar' });
      const conflict = await request(app)
        .post('/api/scheduled-tasks/cron-policy-1/run')
        .set('Idempotency-Key', 'manual-cron-conflict')
        .send({ source: 'retry-panel' });

      expect(first.status).toBe(202);
      expect(conflict.status).toBe(409);
      expect(conflict.body).toEqual({
        error: 'Cette clé d’idempotence a déjà été utilisée avec une autre commande.',
        code: 'IDEMPOTENCY_KEY_CONFLICT',
      });
      expect(adapter.runScheduledTask).toHaveBeenCalledOnce();
    } finally {
      database.close();
    }
  });

  it('requires an idempotency key before validating or triggering a manual run', async () => {
    const database = createDatabase(':memory:');
    const runRepository = createRunRepository(database);
    const { adapter, app } = routeFixture({ runRepository });

    try {
      const response = await request(app).post('/api/scheduled-tasks/cron-policy-1/run');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'Idempotency-Key est requis pour une exécution manuelle.',
        code: 'IDEMPOTENCY_KEY_REQUIRED',
      });
      expect(adapter.getScheduledTask).not.toHaveBeenCalled();
      expect(adapter.getRuntimeStatus).not.toHaveBeenCalled();
      expect(adapter.runScheduledTask).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it('projects fresh server readiness and the canonical workdir registry on list', async () => {
    const { allowed, adapter, app } = routeFixture();

    const response = await request(app).get('/api/scheduled-tasks?includeDisabled=true');

    expect(response.status).toBe(200);
    expect(response.body.policy).toEqual({
      provider: 'openai-codex',
      profileId: 'etienne-openai',
      authState: 'connected',
      checkedAt: '2026-09-02T08:00:00.000Z',
      models: CONNECTED_RUNTIME.models,
      allowedWorkdirs: [allowed],
    });
    expect(response.body.scheduledTasks[0].readiness).toEqual({
      ready: true,
      code: null,
      reason: null,
    });
    expect(adapter.getRuntimeStatus).toHaveBeenCalledOnce();
  });

  it.each([
    [{ ...CONNECTED_RUNTIME, authState: 'expired' as const }, 'SCHEDULED_OAUTH_EXPIRED'],
    [{ ...CONNECTED_RUNTIME, profileId: 'wrong-profile' }, 'SCHEDULED_PROFILE_UNSUPPORTED'],
    [{ ...CONNECTED_RUNTIME, models: [] }, 'SCHEDULED_MODEL_UNAVAILABLE'],
    [{ ...CONNECTED_RUNTIME, models: [{ ...CONNECTED_RUNTIME.models[0], reasoningEfforts: ['low'] as const }] }, 'SCHEDULED_EFFORT_UNSUPPORTED'],
  ])('projects an exact run-now refusal reason without mutating Hermes', async (runtime, code) => {
    const { adapter, app } = routeFixture({ runtime: runtime as RuntimeStatus });

    const response = await request(app).get('/api/scheduled-tasks');

    expect(response.status).toBe(200);
    expect(response.body.scheduledTasks[0].readiness).toEqual(expect.objectContaining({
      ready: false,
      code,
      reason: expect.any(String),
    }));
    expect(adapter.runScheduledTask).not.toHaveBeenCalled();
  });

  it('redacts secret-looking values from Hermes last errors before returning them to the cockpit', async () => {
    const paths = fixture();
    const task = {
      ...scheduledTaskRecord(paths.valid),
      lastError: 'authorization Bearer oauth-secret-123 failed for token=hidden-value',
      lastDeliveryError: 'api_key=delivery-secret',
    };
    const { app } = routeFixture({ task });

    const response = await request(app).get('/api/scheduled-tasks');
    const serialized = JSON.stringify(response.body);

    expect(response.status).toBe(200);
    expect(serialized).not.toContain('oauth-secret-123');
    expect(serialized).not.toContain('hidden-value');
    expect(serialized).not.toContain('delivery-secret');
    expect(response.body.scheduledTasks[0].lastError).toContain('[REDACTED]');
  });

  it('redacts Basic authorization and a credential-bearing scheduled task name before HTTP projection', async () => {
    const paths = fixture();
    const task = {
      ...scheduledTaskRecord(paths.valid),
      name: 'Authorization: Basic dXNlcjpwYXNz',
      lastError: 'Authorization: Digest username="Mufasa", realm="indy", nonce="secret-fixture", uri="/cron"\r\nPolicy refused',
      deliver: 'credential=delivery-provenance-secret',
      origin: {
        chat_name: 'Authorization: Basic origin-provenance-secret',
        password: 'origin-password-secret',
        nested: { passwd: 'origin-passwd-secret', pwd: 'origin-pwd-secret' },
      },
      contextFrom: ['api_key=context-provenance-secret'],
      skills: ['secret=skill-provenance-secret'],
    };
    const { app } = routeFixture({ task });

    const response = await request(app).get('/api/scheduled-tasks');
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('dXNlcjpwYXNz');
    expect(JSON.stringify(response.body)).not.toContain('secret-fixture');
    expect(JSON.stringify(response.body)).not.toContain('Mufasa');
    expect(JSON.stringify(response.body)).not.toContain('delivery-provenance-secret');
    expect(JSON.stringify(response.body)).not.toContain('origin-provenance-secret');
    expect(JSON.stringify(response.body)).not.toContain('origin-password-secret');
    expect(JSON.stringify(response.body)).not.toContain('origin-passwd-secret');
    expect(JSON.stringify(response.body)).not.toContain('origin-pwd-secret');
    expect(JSON.stringify(response.body)).not.toContain('context-provenance-secret');
    expect(JSON.stringify(response.body)).not.toContain('skill-provenance-secret');
    expect(response.body.scheduledTasks[0].name).toContain('[REDACTED]');
  });

  it('returns a typed generic mutation error without leaking a Hermes credential message', async () => {
    const { adapter, app, valid } = routeFixture();
    adapter.createScheduledTask.mockRejectedValueOnce(new Error('Bearer oauth-secret-should-stay-private'));

    const response = await request(app).post('/api/scheduled-tasks').send(valid);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: 'Hermes scheduled tasks worker unavailable',
      code: 'HERMES_SCHEDULED_TASKS_UNAVAILABLE',
    });
    expect(response.text).not.toContain('oauth-secret-should-stay-private');
  });
});
