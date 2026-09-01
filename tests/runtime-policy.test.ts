import { describe, expect, it } from 'vitest';
import { createWorkerEnvironment } from '../server/adapters/hermes-worker.js';
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

  it('removes API-key provider credentials regardless of Windows environment-variable casing', () => {
    expect(sanitizeWorkerEnv({
      OPENAI_API_KEY: 'openai-secret',
      OpenAI_Api_Key: 'openai-mixed-secret',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      anthropic_api_key: 'anthropic-lower-secret',
      OPENROUTER_API_KEY: 'openrouter-secret',
      Openrouter_Api_Key: 'openrouter-mixed-secret',
      CODEX_API_KEY: 'codex-secret',
      codex_api_key: 'codex-lower-secret',
      PATH: 'safe',
      SAFE_SETTING: 'retained',
    } as NodeJS.ProcessEnv)).toEqual({ PATH: 'safe', SAFE_SETTING: 'retained' });
  });

  it('passes only the sanitized environment and Hermes worker flags to spawn', () => {
    expect(createWorkerEnvironment({
      OpenAI_Api_Key: 'openai-mixed-secret',
      anthropic_api_key: 'anthropic-lower-secret',
      Openrouter_Api_Key: 'openrouter-mixed-secret',
      codex_api_key: 'codex-lower-secret',
      PATH: 'safe',
      SAFE_SETTING: 'retained',
    } as NodeJS.ProcessEnv)).toEqual({
      PATH: 'safe',
      SAFE_SETTING: 'retained',
      HERMES_QUIET: '1',
      HERMES_YOLO_MODE: '1',
    });
  });
});
