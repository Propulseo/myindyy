import express from 'express';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeRouter } from '../server/routes/runtime.js';
import { filterOAuthModels, type RuntimeStatus } from '../server/runtime/hermes-runtime.js';

const TEST_PROXY_SECRET = 'test-only-runtime-route-proxy-secret';

function productionAuthHeaders(): Record<string, string> {
  return {
    'X-Indy-Proxy-Secret': TEST_PROXY_SECRET,
    'X-Indy-User': 'etienne',
  };
}

function sensitiveKeys(value: unknown, path = ''): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = path ? `${path}.${key}` : key;
    return [
      ...(/token|key|credential|authorization|cookie/i.test(key) ? [childPath] : []),
      ...sensitiveKeys(child, childPath),
    ];
  });
}

async function loadProductionAppWithBroadcastSpy(prefix: string) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const secretFile = join(home, 'proxy-secret');
  writeFileSync(secretFile, `${TEST_PROXY_SECRET}\n`, { encoding: 'utf8', mode: 0o600 });
  process.env.MINIONS_HOME = home;
  process.env.NODE_ENV = 'production';
  process.env.INDY_PROXY_SECRET_FILE = secretFile;
  process.env.INDY_TRUSTED_PROXY_CIDRS = '127.0.0.0/8,::1/128';
  vi.resetModules();
  const broadcast = vi.fn();
  vi.doMock('../server/events.js', async () => ({
    ...await vi.importActual<typeof import('../server/events.js')>('../server/events.js'),
    broadcast,
  }));
  const [{ default: app, adapter }, { default: database }] = await Promise.all([
    import('../server/app.js'),
    import('../server/db/index.js'),
  ]);
  return { app, adapter, broadcast, database };
}

describe('Codex OAuth runtime status', () => {
  it('keeps only the exact openai-codex catalog group and projects public model fields', () => {
    expect(filterOAuthModels([
      {
        provider: 'openai-codex',
        models: [{
          id: 'gpt-5.6-sol',
          label: 'gpt-5.6-sol',
          source: 'catalog',
          provider: 'openai-codex',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
          apiKey: 'must-not-escape',
        }],
      },
      {
        provider: 'openai',
        models: [{ id: 'gpt-5.6-sol', label: 'wrong provider', source: 'catalog' }],
      },
    ])).toEqual([
      { id: 'gpt-5.6-sol', label: 'gpt-5.6-sol', reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
    ]);
    expect(filterOAuthModels([{
      provider: 'openai',
      models: [{ id: 'gpt-5.6-sol', label: 'gpt-5.6-sol', source: 'catalog' }],
    }])).toEqual([]);
  });

  it('represents unavailable per-model reasoning metadata as null instead of inventing support', () => {
    expect(filterOAuthModels([{
      provider: 'openai-codex',
      models: [{ id: 'gpt-account-model', label: 'Account model', source: 'catalog' }],
    }])).toEqual([
      { id: 'gpt-account-model', label: 'Account model', reasoningEfforts: null },
    ]);
  });

  it('returns only the public runtime response shape without triggering generation', async () => {
    const status: RuntimeStatus = {
      provider: 'openai-codex',
      profileId: 'etienne-openai',
      authState: 'connected',
      checkedAt: '2026-09-01T08:00:00.000Z',
      models: [{
        id: 'gpt-5.6-sol',
        label: 'gpt-5.6-sol',
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      }],
    };
    const getRuntimeStatus = vi.fn().mockResolvedValue(status);
    const app = express();
    app.use('/api/runtime', createRuntimeRouter({ getRuntimeStatus }));

    const response = await request(app).get('/api/runtime');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(status);
    expect(Object.keys(response.body).sort()).toEqual([
      'authState', 'checkedAt', 'models', 'profileId', 'provider',
    ]);
    expect(sensitiveKeys(response.body)).toEqual([]);
    expect(getRuntimeStatus).toHaveBeenCalledOnce();
  });

  it('classifies a worker transport failure without returning its secret-bearing message', async () => {
    const app = express();
    app.use('/api/runtime', createRuntimeRouter({
      getRuntimeStatus: async () => {
        throw new Error('authorization Bearer oauth-super-secret');
      },
    }));

    const response = await request(app).get('/api/runtime');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      provider: 'openai-codex',
      profileId: null,
      authState: 'error',
      models: [],
    });
    expect(Object.keys(response.body).sort()).toEqual([
      'authState', 'checkedAt', 'models', 'profileId', 'provider',
    ]);
    expect(response.text).not.toContain('oauth-super-secret');
    expect(sensitiveKeys(response.body)).toEqual([]);
  });

  it('rejects a model removed from the refreshed catalog before creating a run or event', async () => {
    const { app: productionApp, adapter, broadcast, database } = await loadProductionAppWithBroadcastSpy(
      'indy-runtime-model-',
    );
    const missionId = `runtime-missing-model-${Date.now()}`;
    database.prepare(`
      INSERT INTO tasks (
        id, title, description, status, agent_model, agent_provider, reasoning_effort,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'done', ?, ?, ?, 1, 1)
    `).run(missionId, 'Unavailable model', 'Do not launch', 'gpt-live', 'openai-codex', 'high');
    const before = database.prepare('SELECT * FROM tasks WHERE id = ?').get(missionId);
    const statusSpy = vi.spyOn(adapter, 'getRuntimeStatus').mockResolvedValue({
      provider: 'openai-codex',
      profileId: 'etienne-openai',
      authState: 'connected',
      checkedAt: '2026-09-01T08:00:00.000Z',
      models: [{ id: 'gpt-live', label: 'gpt-live', reasoningEfforts: null }],
    });
    const generationSpy = vi.spyOn(adapter, 'chatStream').mockImplementation(async function* () {
      yield { type: 'done', sessionId: 'must-not-run' };
    });

    try {
      const response = await request(productionApp)
        .post(`/api/tasks/${missionId}/messages`)
        .set(productionAuthHeaders())
        .send({ content: 'Launch removed model', model: 'gpt-removed', reasoningEffort: 'low' });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: 'The requested Codex model is not available for the active OAuth profile',
        code: 'MODEL_UNAVAILABLE',
      });
      expect(database.prepare('SELECT * FROM tasks WHERE id = ?').get(missionId)).toEqual(before);
      expect(database.prepare('SELECT COUNT(*) AS count FROM mission_runs WHERE mission_id = ?').get(missionId))
        .toEqual({ count: 0 });
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM run_events
        WHERE run_id IN (SELECT id FROM mission_runs WHERE mission_id = ?)
      `).get(missionId)).toEqual({ count: 0 });
      expect(broadcast).not.toHaveBeenCalled();
      expect(statusSpy).toHaveBeenCalledOnce();
      expect(generationSpy).not.toHaveBeenCalled();
    } finally {
      statusSpy.mockRestore();
      generationSpy.mockRestore();
      database.close();
      vi.doUnmock('../server/events.js');
      vi.resetModules();
    }
  });

  it('leaves the task and event streams untouched when runtime diagnosis is unavailable', async () => {
    const { app: productionApp, adapter, broadcast, database } = await loadProductionAppWithBroadcastSpy(
      'indy-runtime-error-',
    );
    const missionId = `runtime-error-${Date.now()}`;
    database.prepare(`
      INSERT INTO tasks (
        id, title, description, status, agent_model, agent_provider, reasoning_effort,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'done', ?, ?, ?, 1, 1)
    `).run(missionId, 'Runtime unavailable', 'Do not mutate', 'gpt-live', 'openai-codex', 'high');
    const before = database.prepare('SELECT * FROM tasks WHERE id = ?').get(missionId);
    const statusSpy = vi.spyOn(adapter, 'getRuntimeStatus').mockRejectedValue(
      new Error('authorization Bearer oauth-super-secret'),
    );
    const generationSpy = vi.spyOn(adapter, 'chatStream').mockImplementation(async function* () {
      yield { type: 'done', sessionId: 'must-not-run' };
    });

    try {
      const response = await request(productionApp)
        .post(`/api/tasks/${missionId}/messages`)
        .set(productionAuthHeaders())
        .send({ content: 'Do not launch', model: 'gpt-other', reasoningEffort: 'low' });

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        error: 'Codex runtime status is unavailable',
        code: 'RUNTIME_UNAVAILABLE',
      });
      expect(response.text).not.toContain('oauth-super-secret');
      expect(database.prepare('SELECT * FROM tasks WHERE id = ?').get(missionId)).toEqual(before);
      expect(database.prepare('SELECT COUNT(*) AS count FROM mission_runs WHERE mission_id = ?').get(missionId))
        .toEqual({ count: 0 });
      expect(database.prepare('SELECT COUNT(*) AS count FROM run_events').get()).toEqual({ count: 0 });
      expect(broadcast).not.toHaveBeenCalled();
      expect(generationSpy).not.toHaveBeenCalled();
    } finally {
      statusSpy.mockRestore();
      generationSpy.mockRestore();
      database.close();
      vi.doUnmock('../server/events.js');
      vi.resetModules();
    }
  });
});
