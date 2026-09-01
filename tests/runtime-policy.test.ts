import { describe, expect, it } from 'vitest';
import { assertAllowedRuntime, sanitizeWorkerEnv } from '../server/runtime/policy.js';

describe('Codex OAuth runtime policy', () => {
  it('accepts the Hermes Codex OAuth provider with a model', () => {
    expect(assertAllowedRuntime({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    })).toMatchObject({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    });
  });

  it('rejects a non-OAuth provider before it can run', () => {
    expect(() => assertAllowedRuntime({ provider: 'openai', model: 'gpt-5.6-sol' }))
      .toThrow('OAuth-only');
  });

  it('rejects a missing model before it can run', () => {
    expect(() => assertAllowedRuntime({ provider: 'openai-codex', model: null }))
      .toThrow('model');
  });

  it('removes all API-key provider credentials from the worker environment', () => {
    expect(sanitizeWorkerEnv({
      OPENAI_API_KEY: 'openai-secret',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      OPENROUTER_API_KEY: 'openrouter-secret',
      CODEX_API_KEY: 'codex-secret',
      PATH: 'safe',
    } as NodeJS.ProcessEnv)).toEqual({ PATH: 'safe' });
  });
});
