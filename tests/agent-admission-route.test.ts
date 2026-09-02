import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createAgentRouter } from '../server/routes/agent.js';
import { InteractiveAdmissionError } from '../server/runtime/interactive-admission.js';

function runtimeStatus() {
  return {
    provider: 'openai-codex' as const,
    profileId: 'etienne-openai',
    authState: 'connected' as const,
    checkedAt: new Date().toISOString(),
    models: [{
      id: 'gpt-live',
      label: 'GPT Live',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] as const,
    }],
  };
}

function agentApp(adapter: Parameters<typeof createAgentRouter>[0]) {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', createAgentRouter(adapter));
  return app;
}

describe('agent runtime admission routes', () => {
  it('projects /models solely from one fresh runtime snapshot', async () => {
    const getModels = vi.fn().mockRejectedValue(new Error('models.list must never run'));
    const adapter = {
      getDefaults: vi.fn(),
      setDefaults: vi.fn(),
      getModels,
      getRuntimeStatus: vi.fn().mockResolvedValue(runtimeStatus()),
    } as unknown as Parameters<typeof createAgentRouter>[0];

    const response = await request(agentApp(adapter)).get('/api/agent/models');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      defaultModel: null,
      activeProvider: 'openai-codex',
      groups: [{
        provider: 'openai-codex',
        models: [{
          id: 'gpt-live',
          label: 'GPT Live',
          source: 'catalog',
          provider: 'openai-codex',
        }],
      }],
    });
    expect(adapter.getRuntimeStatus).toHaveBeenCalledOnce();
    expect(getModels).not.toHaveBeenCalled();
  });

  it('fails closed when /models receives a stale runtime snapshot', async () => {
    const adapter = {
      getDefaults: vi.fn(),
      setDefaults: vi.fn(),
      getModels: vi.fn(),
      getRuntimeStatus: vi.fn().mockResolvedValue({
        ...runtimeStatus(),
        checkedAt: new Date(Date.now() - 120_001).toISOString(),
      }),
    } as unknown as Parameters<typeof createAgentRouter>[0];

    const response = await request(agentApp(adapter)).get('/api/agent/models');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: 'Codex runtime status is stale',
      code: 'RUNTIME_STALE',
    });
    expect(adapter.getModels).not.toHaveBeenCalled();
  });

  it('preserves the stable admission code returned by PATCH /defaults', async () => {
    const adapter = {
      getDefaults: vi.fn(),
      getModels: vi.fn(),
      getRuntimeStatus: vi.fn(),
      setDefaults: vi.fn().mockRejectedValue(new InteractiveAdmissionError('MODEL_UNAVAILABLE')),
    } as unknown as Parameters<typeof createAgentRouter>[0];

    const response = await request(agentApp(adapter))
      .patch('/api/agent/defaults')
      .send({ model: 'gpt-removed' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'The requested Codex model is not available for the active OAuth profile',
      code: 'MODEL_UNAVAILABLE',
    });
  });
});
