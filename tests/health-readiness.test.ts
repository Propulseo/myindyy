import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../server/db/index.js';
import { createHealthRouter } from '../server/health/readiness.js';
import { probeReady } from '../server/healthcheck.js';

const databases: Array<ReturnType<typeof createDatabase>> = [];

function database() {
  const value = createDatabase(':memory:');
  databases.push(value);
  return value;
}

function connectedRuntime(checkedAt = new Date().toISOString()) {
  return {
    healthCheck: vi.fn().mockResolvedValue(true),
    getRuntimeStatus: vi.fn().mockResolvedValue({
      provider: 'openai-codex' as const,
      profileId: 'etienne-openai',
      authState: 'connected' as const,
      checkedAt,
      models: [{
        id: 'gpt-5.6-sol',
        label: 'gpt-5.6-sol',
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] as const,
      }],
    }),
  };
}

function healthApp(options: {
  readonly db?: ReturnType<typeof createDatabase>;
  readonly runtime?: ReturnType<typeof connectedRuntime>;
  readonly controlLoopsReady?: () => boolean;
  readonly now?: () => number;
} = {}) {
  const app = express();
  app.use('/api/health', createHealthRouter({
    database: options.db ?? database(),
    runtime: options.runtime ?? connectedRuntime(),
    controlLoopsReady: options.controlLoopsReady ?? (() => true),
    now: options.now,
  }));
  return app;
}

afterEach(() => {
  for (const value of databases.splice(0)) value.close();
  vi.restoreAllMocks();
});

describe('operational health', () => {
  it('reports process liveness without touching SQLite, Hermes, or startup loops', async () => {
    const runtime = connectedRuntime();
    const db = database();
    const prepare = vi.spyOn(db, 'prepare');
    const loops = vi.fn(() => {
      throw new Error('liveness must not inspect readiness state');
    });

    const response = await request(healthApp({ db, runtime, controlLoopsReady: loops }))
      .get('/api/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'live' });
    expect(prepare).not.toHaveBeenCalled();
    expect(runtime.healthCheck).not.toHaveBeenCalled();
    expect(runtime.getRuntimeStatus).not.toHaveBeenCalled();
    expect(loops).not.toHaveBeenCalled();
  });

  it('is ready only after writable migrations, control loops, worker, and a fresh exact OAuth catalog pass', async () => {
    const runtime = connectedRuntime('2026-09-02T08:00:00.000Z');
    const response = await request(healthApp({
      runtime,
      now: () => Date.parse('2026-09-02T08:00:30.000Z'),
    })).get('/api/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ready' });
    expect(runtime.healthCheck).toHaveBeenCalledOnce();
    expect(runtime.getRuntimeStatus).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'startup control loops are not ready',
      arrange: () => ({ controlLoopsReady: () => false }),
    },
    {
      name: 'the Hermes worker is down',
      arrange: () => {
        const runtime = connectedRuntime();
        runtime.healthCheck.mockResolvedValue(false);
        return { runtime };
      },
    },
    {
      name: 'the OAuth profile is not exact',
      arrange: () => {
        const runtime = connectedRuntime();
        runtime.getRuntimeStatus.mockResolvedValue({
          provider: 'openai-codex', profileId: 'another-profile', authState: 'connected',
          checkedAt: '2026-09-02T08:00:00.000Z',
          models: [{ id: 'gpt-test', label: 'gpt-test', reasoningEfforts: ['high'] }],
        });
        return { runtime, now: () => Date.parse('2026-09-02T08:00:30.000Z') };
      },
    },
    {
      name: 'the authenticated catalog is empty',
      arrange: () => {
        const runtime = connectedRuntime();
        runtime.getRuntimeStatus.mockResolvedValue({
          provider: 'openai-codex', profileId: 'etienne-openai', authState: 'connected',
          checkedAt: '2026-09-02T08:00:00.000Z', models: [],
        });
        return { runtime, now: () => Date.parse('2026-09-02T08:00:30.000Z') };
      },
    },
    {
      name: 'the authenticated catalog is stale',
      arrange: () => ({
        runtime: connectedRuntime('2026-09-02T07:55:00.000Z'),
        now: () => Date.parse('2026-09-02T08:00:30.000Z'),
      }),
    },
  ])('fails closed without operational detail when $name', async ({ arrange }) => {
    const response = await request(healthApp(arrange())).get('/api/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'not-ready' });
    expect(response.text).not.toMatch(/sqlite|migration|worker|profile|catalog|oauth/i);
  });

  it('fails readiness when a required migration is absent or SQLite is read-only', async () => {
    const missingMigration = database();
    missingMigration.exec('ALTER TABLE mission_runs RENAME TO mission_runs_old');
    const readOnly = database();
    readOnly.pragma('query_only = ON');

    const missingResponse = await request(healthApp({ db: missingMigration })).get('/api/health/ready');
    const readOnlyResponse = await request(healthApp({ db: readOnly })).get('/api/health/ready');

    expect(missingResponse.status).toBe(503);
    expect(readOnlyResponse.status).toBe(503);
    expect(missingResponse.body).toEqual({ status: 'not-ready' });
    expect(readOnlyResponse.body).toEqual({ status: 'not-ready' });
  });
});

describe('container healthcheck client', () => {
  it('reads the mounted secret outside argv and sends only the internal authenticated probe headers', async () => {
    const secret = 'healthcheck-test-secret-at-least-32-bytes';
    const directory = mkdtempSync(join(tmpdir(), 'indy-healthcheck-'));
    const secretFile = join(directory, 'proxy-secret');
    writeFileSync(secretFile, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
    let receivedHeaders: typeof import('node:http').IncomingHttpHeaders = {};
    const server = createServer((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ready"}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    try {
      await expect(probeReady({
        port: address.port,
        host: 'indy.example.test',
        secretFile,
      })).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }

    expect(receivedHeaders).toMatchObject({
      host: 'indy.example.test',
      'x-indy-user': 'etienne',
      'x-indy-proxy-secret': secret,
    });
    expect(receivedHeaders.origin).toBeUndefined();
  });
});
