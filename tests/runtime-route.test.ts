import express from 'express';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeRouter } from '../server/routes/runtime.js';
import { filterOAuthModels, type RuntimeStatus } from '../server/runtime/hermes-runtime.js';

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
    process.env.MINIONS_HOME = mkdtempSync(join(tmpdir(), 'indy-runtime-model-'));
    vi.resetModules();
    const [{ default: productionApp, adapter }, { default: database }] = await Promise.all([
      import('../server/app.js'),
      import('../server/db/index.js'),
    ]);
    const missionId = `runtime-missing-model-${Date.now()}`;
    database.prepare(`
      INSERT INTO tasks (
        id, title, description, status, agent_model, agent_provider, reasoning_effort,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'in_progress', ?, ?, ?, 1, 1)
    `).run(missionId, 'Unavailable model', 'Do not launch', 'gpt-removed', 'openai-codex', 'high');
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

    const response = await request(productionApp)
      .post(`/api/tasks/${missionId}/messages`)
      .send({ content: 'Launch removed model' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'The requested Codex model is not available for the active OAuth profile',
      code: 'MODEL_UNAVAILABLE',
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM mission_runs WHERE mission_id = ?').get(missionId))
      .toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM run_events
      WHERE run_id IN (SELECT id FROM mission_runs WHERE mission_id = ?)
    `).get(missionId)).toEqual({ count: 0 });
    expect(statusSpy).toHaveBeenCalledOnce();
    expect(generationSpy).not.toHaveBeenCalled();
  });
});
