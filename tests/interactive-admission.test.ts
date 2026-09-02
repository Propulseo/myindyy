import { describe, expect, it, vi } from 'vitest';
import type { AgentRunSettings } from '../server/adapters/types.js';
import type { RuntimeStatus } from '../server/runtime/hermes-runtime.js';
import {
  InteractiveAdmissionError,
  requireInteractiveAdmission,
  toInteractiveAdmissionHttp,
} from '../server/runtime/interactive-admission.js';

const NOW = Date.parse('2026-09-02T08:00:00.000Z');
const SETTINGS: AgentRunSettings = {
  provider: 'openai-codex',
  model: 'gpt-5.6-sol',
  reasoningEffort: 'high',
};

function connected(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    provider: 'openai-codex',
    profileId: 'etienne-openai',
    authState: 'connected',
    checkedAt: new Date(NOW - 30_000).toISOString(),
    models: [{
      id: 'gpt-5.6-sol',
      label: 'GPT 5.6 Sol',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    }],
    ...overrides,
  };
}

async function rejectedCode(status: RuntimeStatus, settings = SETTINGS): Promise<string> {
  try {
    await requireInteractiveAdmission({ getRuntimeStatus: vi.fn().mockResolvedValue(status) }, settings, () => NOW);
  } catch (error) {
    expect(error).toBeInstanceOf(InteractiveAdmissionError);
    return (error as InteractiveAdmissionError).code;
  }
  throw new Error('Expected admission to be rejected');
}

describe('fresh interactive admission', () => {
  it('admits only an exact fresh provider/profile/model/effort tuple', async () => {
    const getRuntimeStatus = vi.fn().mockResolvedValue(connected());

    await expect(requireInteractiveAdmission({ getRuntimeStatus }, SETTINGS, () => NOW))
      .resolves.toEqual(connected());
    expect(getRuntimeStatus).toHaveBeenCalledOnce();
  });

  it.each([
    ['wrong provider', connected({ provider: 'wrong-provider' as RuntimeStatus['provider'] }), SETTINGS, 'RUNTIME_PROVIDER_MISMATCH'],
    ['wrong profile', connected({ profileId: 'another-profile' }), SETTINGS, 'OAUTH_PROFILE_REQUIRED'],
    ['missing profile', connected({ profileId: null }), SETTINGS, 'OAUTH_PROFILE_REQUIRED'],
    ['expired auth', connected({ authState: 'expired' }), SETTINGS, 'OAUTH_NOT_CONNECTED'],
    ['missing auth', connected({ authState: 'missing' }), SETTINGS, 'OAUTH_NOT_CONNECTED'],
    ['error auth', connected({ authState: 'error' }), SETTINGS, 'OAUTH_NOT_CONNECTED'],
    ['stale status', connected({ checkedAt: new Date(NOW - 120_001).toISOString() }), SETTINGS, 'RUNTIME_STALE'],
    ['invalid date', connected({ checkedAt: 'not-a-date' }), SETTINGS, 'RUNTIME_STALE'],
    ['future status', connected({ checkedAt: new Date(NOW + 30_001).toISOString() }), SETTINGS, 'RUNTIME_STALE'],
    ['missing model', connected({ models: [] }), SETTINGS, 'MODEL_UNAVAILABLE'],
    ['unknown effort support', connected({ models: [{ id: 'gpt-5.6-sol', label: 'Sol', reasoningEfforts: null }] }), SETTINGS, 'REASONING_EFFORT_UNAVAILABLE'],
    ['unsupported effort', connected({ models: [{ id: 'gpt-5.6-sol', label: 'Sol', reasoningEfforts: ['low'] }] }), SETTINGS, 'REASONING_EFFORT_UNAVAILABLE'],
    ['missing requested effort', connected(), { ...SETTINGS, reasoningEffort: null }, 'REASONING_EFFORT_REQUIRED'],
  ] as const)('rejects %s with a stable public code', async (_label, status, settings, code) => {
    await expect(rejectedCode(status, settings)).resolves.toBe(code);
  });

  it('fails closed with a secret-free response when the fresh lookup fails', async () => {
    const failure = requireInteractiveAdmission({
      getRuntimeStatus: vi.fn().mockRejectedValue(new Error('Bearer oauth-super-secret')),
    }, SETTINGS, () => NOW).catch((error: unknown) => error);

    const error = await failure;
    expect(error).toBeInstanceOf(InteractiveAdmissionError);
    expect(toInteractiveAdmissionHttp(error)).toEqual({
      status: 503,
      body: {
        error: 'Codex runtime status is unavailable',
        code: 'RUNTIME_UNAVAILABLE',
      },
    });
    expect(JSON.stringify(error)).not.toContain('oauth-super-secret');
    expect(String(error)).not.toContain('oauth-super-secret');
  });

  it('maps a malformed runtime payload to the same stable unavailable boundary', async () => {
    const getRuntimeStatus = vi.fn().mockResolvedValue(null);

    const error = await requireInteractiveAdmission(
      { getRuntimeStatus } as unknown as { getRuntimeStatus(): Promise<RuntimeStatus> },
      SETTINGS,
      () => NOW,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InteractiveAdmissionError);
    expect(error).toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
    expect(toInteractiveAdmissionHttp(error)).toEqual({
      status: 503,
      body: {
        error: 'Codex runtime status is unavailable',
        code: 'RUNTIME_UNAVAILABLE',
      },
    });
  });

  it('performs a fresh lookup for each admission instead of reusing a connected result', async () => {
    const getRuntimeStatus = vi.fn()
      .mockResolvedValueOnce(connected())
      .mockResolvedValueOnce(connected({ authState: 'expired' }));

    await expect(requireInteractiveAdmission({ getRuntimeStatus }, SETTINGS, () => NOW)).resolves.toEqual(connected());
    await expect(requireInteractiveAdmission({ getRuntimeStatus }, SETTINGS, () => NOW))
      .rejects.toMatchObject({ code: 'OAUTH_NOT_CONNECTED' });
    expect(getRuntimeStatus).toHaveBeenCalledTimes(2);
  });
});
