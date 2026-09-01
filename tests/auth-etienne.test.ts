import express, { type Express } from 'express';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

const TEST_TRANSPORT_SECRET = 'test-only-proxy-secret-32-bytes-minimum';
const AUTH_ENV_KEYS = [
  'NODE_ENV',
  'INDY_DEV_ACTOR',
  'INDY_PROXY_SECRET_FILE',
  'INDY_TRUSTED_PROXY_CIDRS',
] as const;
const originalAuthEnv = Object.fromEntries(
  AUTH_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof AUTH_ENV_KEYS)[number], string | undefined>;

function createSecretFile(secret = TEST_TRANSPORT_SECRET): string {
  const directory = mkdtempSync(join(tmpdir(), 'indy-auth-secret-'));
  const secretFile = join(directory, 'proxy-secret');
  writeFileSync(secretFile, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
  return secretFile;
}

function secureEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    INDY_PROXY_SECRET_FILE: createSecretFile(),
    INDY_TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
    ...overrides,
  };
}

function validEtienneHeaders(secret = TEST_TRANSPORT_SECRET): Record<string, string> {
  return {
    'X-Indy-Proxy-Secret': secret,
    'X-Indy-User': 'etienne',
  };
}

async function createAuthProbe(options: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly remoteAddress?: string;
}): Promise<Express> {
  const { createRequireEtienne } = await import('../server/auth/etienne.js');
  const probe = express();
  const environment = options.environment ?? secureEnvironment();
  probe.use(options.remoteAddress
    ? createRequireEtienne({ environment, getRemoteAddress: () => options.remoteAddress })
    : createRequireEtienne({ environment }));
  probe.get('/api/probe', (req, res) => res.json({ actor: req.actor }));
  return probe;
}

async function loadProductionApp() {
  process.env.NODE_ENV = 'production';
  process.env.INDY_PROXY_SECRET_FILE = createSecretFile();
  process.env.INDY_TRUSTED_PROXY_CIDRS = '127.0.0.0/8,::1/128';
  process.env.MINIONS_HOME = mkdtempSync(join(tmpdir(), 'indy-auth-app-'));
  vi.resetModules();
  const [{ default: app, adapter }, { default: database }] = await Promise.all([
    import('../server/app.js'),
    import('../server/db/index.js'),
  ]);
  return { app, adapter, database };
}

afterEach(() => {
  for (const key of AUTH_ENV_KEYS) {
    const value = originalAuthEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('Etienne cockpit authentication', () => {
  it('returns 401 to anonymous requests, 403 to an authenticated other user, and accepts exact Etienne', async () => {
    const { app, database } = await loadProductionApp();

    try {
      const anonymous = await request(app).get('/api/tasks');
      const otherUser = await request(app)
        .get('/api/tasks')
        .set(validEtienneHeaders())
        .set('X-Indy-User', 'lucas');
      const wrongCase = await request(app)
        .get('/api/tasks')
        .set(validEtienneHeaders())
        .set('X-Indy-User', 'Etienne');
      const etienne = await request(app).get('/api/tasks').set(validEtienneHeaders());

      expect(anonymous.status).toBe(401);
      expect(otherUser.status).toBe(403);
      expect(wrongCase.status).toBe(403);
      expect(etienne.status).toBe(200);
    } finally {
      database.close();
    }
  }, 15_000);

  it('requires the trusted proxy transport secret without revealing which credential failed', async () => {
    const app = await createAuthProbe({ remoteAddress: '10.20.30.40' });

    const missingSecret = await request(app)
      .get('/api/probe')
      .set('X-Indy-User', 'etienne');
    const wrongSecret = await request(app)
      .get('/api/probe')
      .set(validEtienneHeaders('wrong-test-secret-never-valid'));

    expect(missingSecret.status).toBe(401);
    expect(wrongSecret.status).toBe(401);
    expect(wrongSecret.body).toEqual(missingSecret.body);
    expect(wrongSecret.text).not.toContain(TEST_TRANSPORT_SECRET);
    expect(wrongSecret.text).not.toContain('wrong-test-secret-never-valid');
  });

  it('derives the actor server-side only from an explicitly trusted private proxy source', async () => {
    const trusted = await createAuthProbe({ remoteAddress: '10.20.30.40' });
    const spoofed = await createAuthProbe({ remoteAddress: '203.0.113.40' });

    const accepted = await request(trusted)
      .get('/api/probe')
      .set(validEtienneHeaders());
    const denied = await request(spoofed)
      .get('/api/probe')
      .set(validEtienneHeaders())
      .set('X-Forwarded-For', '10.20.30.40');

    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ actor: { id: 'etienne' } });
    expect(denied.status).toBe(401);
  });

  it('fails closed instead of trusting a configured public proxy network', async () => {
    const app = await createAuthProbe({
      environment: secureEnvironment({ INDY_TRUSTED_PROXY_CIDRS: '203.0.113.0/24' }),
      remoteAddress: '203.0.113.40',
    });

    const response = await request(app)
      .get('/api/probe')
      .set(validEtienneHeaders());

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Authentication unavailable' });
  });

  it('allows the development actor only over the actual loopback socket', async () => {
    const environment = secureEnvironment({
      NODE_ENV: 'development',
      INDY_DEV_ACTOR: 'etienne',
    });
    const loopback = await createAuthProbe({ environment });
    const nonLoopback = await createAuthProbe({ environment, remoteAddress: '10.20.30.40' });

    const accepted = await request(loopback).get('/api/probe');
    const denied = await request(nonLoopback).get('/api/probe');

    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ actor: { id: 'etienne' } });
    expect(denied.status).toBe(401);
  });

  it('never enables the development actor in test or production', async () => {
    for (const nodeEnvironment of ['test', 'production']) {
      const app = await createAuthProbe({
        environment: secureEnvironment({
          NODE_ENV: nodeEnvironment,
          INDY_DEV_ACTOR: 'etienne',
          INDY_TRUSTED_PROXY_CIDRS: '127.0.0.0/8',
        }),
        remoteAddress: '127.0.0.1',
      });

      const response = await request(app).get('/api/probe');
      expect(response.status).toBe(401);
    }
  });

  it('fails closed in production when the mounted secret file is unavailable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'indy-auth-missing-'));
    const app = await createAuthProbe({
      environment: secureEnvironment({
        INDY_PROXY_SECRET_FILE: join(directory, 'does-not-exist'),
      }),
      remoteAddress: '10.20.30.40',
    });

    const response = await request(app)
      .get('/api/probe')
      .set(validEtienneHeaders());

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Authentication unavailable' });
    expect(response.text).not.toContain('does-not-exist');
  });

  it.each([
    {
      name: 'a relative secret path',
      environment: () => secureEnvironment({ INDY_PROXY_SECRET_FILE: 'relative/proxy-secret' }),
    },
    {
      name: 'a malformed CIDR mixed with a valid range',
      environment: () => secureEnvironment({
        INDY_TRUSTED_PROXY_CIDRS: '10.0.0.0/8,not-a-cidr',
      }),
    },
    {
      name: 'a public CIDR mixed with a private range',
      environment: () => secureEnvironment({
        INDY_TRUSTED_PROXY_CIDRS: '10.0.0.0/8,203.0.113.0/24',
      }),
    },
    {
      name: 'a transport secret shorter than 32 bytes',
      environment: () => secureEnvironment({ INDY_PROXY_SECRET_FILE: createSecretFile('too-short') }),
    },
  ])('fails closed for $name', async ({ environment }) => {
    const app = await createAuthProbe({
      environment: environment(),
      remoteAddress: '10.20.30.40',
    });

    const response = await request(app)
      .get('/api/probe')
      .set(validEtienneHeaders());

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Authentication unavailable' });
  });

  it('requires anonymous API preflight to pass the authentication boundary', async () => {
    const { app, database } = await loadProductionApp();

    try {
      const response = await request(app)
        .options('/api/tasks')
        .set('Origin', 'https://hostile.example')
        .set('Access-Control-Request-Method', 'POST');

      expect(response.status).toBe(401);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('rejects an authenticated hostile-origin mutation before it changes state', async () => {
    const { app, database } = await loadProductionApp();
    const before = database.prepare('SELECT COUNT(*) AS count FROM tasks').get();

    try {
      const response = await request(app)
        .post('/api/tasks')
        .set(validEtienneHeaders())
        .set('Host', 'indy.example.test')
        .set('Origin', 'https://hostile.example')
        .set('Sec-Fetch-Site', 'cross-site')
        .send({ description: 'Must not be created' });

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Forbidden' });
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
      expect(database.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual(before);
    } finally {
      database.close();
    }
  });

  it('accepts exact same-origin browser mutations without emitting permissive CORS headers', async () => {
    const { app, database } = await loadProductionApp();

    try {
      const response = await request(app)
        .post('/api/tasks')
        .set(validEtienneHeaders())
        .set('Host', 'indy.example.test')
        .set('Origin', 'https://indy.example.test')
        .set('Sec-Fetch-Site', 'same-origin')
        .send({ description: 'Same-origin task' });

      expect(response.status).toBe(201);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
      expect(response.body.task).toMatchObject({ description: 'Same-origin task' });
    } finally {
      database.close();
    }
  });

  it('rejects unsafe browser-shaped requests when Origin or Fetch Metadata is missing', async () => {
    const { app, database } = await loadProductionApp();

    try {
      const missingFetchMetadata = await request(app)
        .post('/api/tasks')
        .set(validEtienneHeaders())
        .set('Host', 'indy.example.test')
        .set('Origin', 'https://indy.example.test')
        .send({ description: 'Missing fetch metadata' });
      const missingOrigin = await request(app)
        .post('/api/tasks')
        .set(validEtienneHeaders())
        .set('Host', 'indy.example.test')
        .set('Sec-Fetch-Site', 'same-origin')
        .send({ description: 'Missing origin' });

      expect(missingFetchMetadata.status).toBe(403);
      expect(missingOrigin.status).toBe(403);
    } finally {
      database.close();
    }
  });

  it('supports an authenticated non-browser proxy request with no Origin metadata', async () => {
    const { app, database } = await loadProductionApp();

    try {
      const response = await request(app)
        .post('/api/tasks')
        .set(validEtienneHeaders())
        .send({ description: 'Internal proxy task' });

      expect(response.status).toBe(201);
      expect(response.body.task).toMatchObject({ description: 'Internal proxy task' });
    } finally {
      database.close();
    }
  });

  it('protects every API family, including health and commands, before route handling', async () => {
    const { app, adapter, database } = await loadProductionApp();
    vi.spyOn(adapter, 'healthCheck').mockResolvedValue(true);

    try {
      const responses = await Promise.all([
        request(app).get('/api/files/not-a-route'),
        request(app).get('/api/tasks'),
        request(app).get('/api/agent/not-a-route'),
        request(app).get('/api/scheduled-tasks/not-a-route/not-a-route'),
        request(app).get('/api/skills/not-a-route/not-a-route'),
        request(app).get('/api/runtime/not-a-route'),
        request(app).post('/api/missions/not-a-mission/commands'),
        request(app).get('/api/health'),
        request(app).get('/api/version'),
      ]);

      expect(responses.map((response) => response.status)).toEqual(Array(9).fill(401));
    } finally {
      database.close();
    }
  });

  it('rejects SSE authentication before opening stream headers', async () => {
    const { app, database } = await loadProductionApp();

    try {
      const response = await request(app)
        .get('/api/events')
        .timeout({ deadline: 500 });

      expect(response.status).toBe(401);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.text).not.toContain('task_runs_snapshot');
    } finally {
      database.close();
    }
  });

  it('rejects per-task live SSE before opening stream headers', async () => {
    const { app, database } = await loadProductionApp();

    try {
      const created = await request(app)
        .post('/api/tasks')
        .set(validEtienneHeaders())
        .send({ description: 'Live stream auth probe' });
      const response = await request(app)
        .get(`/api/tasks/${created.body.task.id}/live`)
        .timeout({ deadline: 500 });

      expect(response.status).toBe(401);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.headers['content-type']).not.toContain('text/event-stream');
    } finally {
      database.close();
    }
  });

  it('allows representative authenticated GET and POST requests while ignoring body identity fields', async () => {
    const { app, database } = await loadProductionApp();

    try {
      const created = await request(app)
        .post('/api/tasks')
        .set(validEtienneHeaders())
        .send({
          description: 'Task created through the private proxy',
          actorId: 'mallory',
          user: 'lucas',
          role: 'admin',
        });
      const listed = await request(app).get('/api/tasks').set(validEtienneHeaders());

      expect(created.status).toBe(201);
      expect(listed.status).toBe(200);
      expect(listed.body.tasks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: created.body.task.id }),
      ]));
    } finally {
      database.close();
    }
  });

  it('journals accepted commands as Etienne even when query identity is spoofed', async () => {
    const { app, database } = await loadProductionApp();
    const [{ createRunRepository }, { createRunService }] = await Promise.all([
      import('../server/runs/repository.js'),
      import('../server/runs/service.js'),
    ]);

    try {
      const created = await request(app)
        .post('/api/tasks')
        .set(validEtienneHeaders())
        .send({ description: 'Journal verified actor' });
      const repository = createRunRepository(database);
      const service = createRunService(repository, {
        generateId: () => 'auth-command-run',
        now: () => 100,
      });
      const run = service.startMission({
        missionId: created.body.task.id,
        provider: 'openai-codex',
        model: 'gpt-test',
        reasoningEffort: 'high',
      });
      repository.appendRunEvent({
        id: 'auth-command-blocked',
        runId: run.runId,
        type: 'run.blocked',
        occurredAt: 101,
        payload: { reason: 'inactive' },
      });

      const response = await request(app)
        .post(`/api/missions/${created.body.task.id}/commands`)
        .query({ actorId: 'mallory', user: 'lucas', role: 'admin' })
        .set(validEtienneHeaders())
        .set('Idempotency-Key', 'auth-command-1')
        .send({ type: 'stop', runId: run.runId });
      const command = database.prepare(`
        SELECT actor_id FROM operator_commands WHERE idempotency_key = ?
      `).get('auth-command-1');

      expect(response.status).toBe(202);
      expect(command).toEqual({ actor_id: 'etienne' });
    } finally {
      database.close();
    }
  });
});
