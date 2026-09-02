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
      // indy-model-key-scan: allow-reference
      OPENAI_API_KEY: 'openai-secret', // indy-model-key-scan: allow-reference
      // indy-model-key-scan: allow-reference
      OpenAI_Api_Key: 'openai-mixed-secret', // indy-model-key-scan: allow-reference
      // indy-model-key-scan: allow-reference
      ANTHROPIC_API_KEY: 'anthropic-secret', // indy-model-key-scan: allow-reference
      // indy-model-key-scan: allow-reference
      anthropic_api_key: 'anthropic-lower-secret', // indy-model-key-scan: allow-reference
      // indy-model-key-scan: allow-reference
      OPENROUTER_API_KEY: 'openrouter-secret', // indy-model-key-scan: allow-reference
      // indy-model-key-scan: allow-reference
      Openrouter_Api_Key: 'openrouter-mixed-secret', // indy-model-key-scan: allow-reference
      // indy-model-key-scan: allow-reference
      CODEX_API_KEY: 'codex-secret', // indy-model-key-scan: allow-reference
      // indy-model-key-scan: allow-reference
      codex_api_key: 'codex-lower-secret', // indy-model-key-scan: allow-reference
      PATH: 'safe',
      SAFE_SETTING: 'retained',
    } as NodeJS.ProcessEnv)).toEqual({ PATH: 'safe', SAFE_SETTING: 'retained' });
  });

  it('passes only the sanitized environment and Hermes worker flags to spawn', () => {
    expect(createWorkerEnvironment({
      // indy-model-key-scan: allow-reference
      OpenAI_Api_Key: 'openai-mixed-secret', // indy-model-key-scan: allow-reference
      // indy-model-key-scan: allow-reference
      anthropic_api_key: 'anthropic-lower-secret', // indy-model-key-scan: allow-reference
      // indy-model-key-scan: allow-reference
      Openrouter_Api_Key: 'openrouter-mixed-secret', // indy-model-key-scan: allow-reference
      // indy-model-key-scan: allow-reference
      codex_api_key: 'codex-lower-secret', // indy-model-key-scan: allow-reference
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
