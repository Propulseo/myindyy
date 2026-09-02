import { afterEach, describe, expect, it, vi } from 'vitest';
import { HermesWorkerAdapter } from '../server/adapters/hermes-worker.js';
import { HermesOAuthRuntime } from '../server/runtime/hermes-runtime.js';
import type { AgentDefaults } from '../shared/types.js';

const DEFAULTS: AgentDefaults = {
  provider: 'openai-codex',
  model: 'gpt-current',
  reasoningEffort: 'medium',
  baseUrl: null,
  apiMode: null,
  showReasoning: true,
};

function diagnostic(models = ['gpt-current', 'gpt-next']) {
  return {
    provider: 'openai-codex',
    profileId: 'etienne-openai',
    authState: 'connected' as const,
    checkedAt: new Date().toISOString(),
    models: models.map((id) => ({
      id,
      label: id,
      reasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    })),
  };
}

describe('Hermes OAuth defaults admission', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not invent a fresh checkedAt when the worker diagnostic omits its proof', async () => {
    vi.spyOn(HermesWorkerAdapter.prototype, 'getRuntimeDiagnostic').mockResolvedValue({
      ...diagnostic(),
      checkedAt: undefined as unknown as string,
    });
    const runtime = new HermesOAuthRuntime();

    await expect(runtime.getRuntimeStatus()).resolves.toMatchObject({ checkedAt: '' });
  });

  it('rejects a removed catalog model before writing any worker setting', async () => {
    vi.spyOn(HermesWorkerAdapter.prototype, 'getDefaults').mockResolvedValue(DEFAULTS);
    vi.spyOn(HermesWorkerAdapter.prototype, 'getRuntimeDiagnostic').mockResolvedValue(diagnostic(['gpt-current']));
    const write = vi.spyOn(HermesWorkerAdapter.prototype, 'setDefaults').mockResolvedValue(DEFAULTS);
    const runtime = new HermesOAuthRuntime();

    await expect(runtime.setDefaults({ model: 'gpt-removed', reasoningEffort: 'high' }))
      .rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
    expect(write).not.toHaveBeenCalled();
  });

  it('uses the same stable admission authority for a provider mismatch', async () => {
    vi.spyOn(HermesWorkerAdapter.prototype, 'getDefaults').mockResolvedValue(DEFAULTS);
    const status = vi.spyOn(HermesWorkerAdapter.prototype, 'getRuntimeDiagnostic').mockResolvedValue(diagnostic());
    const write = vi.spyOn(HermesWorkerAdapter.prototype, 'setDefaults').mockResolvedValue(DEFAULTS);
    const runtime = new HermesOAuthRuntime();

    await expect(runtime.setDefaults({ provider: 'openai' }))
      .rejects.toMatchObject({ code: 'RUNTIME_PROVIDER_MISMATCH' });
    expect(status).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('validates the complete merged tuple against one fresh snapshot before writing', async () => {
    vi.spyOn(HermesWorkerAdapter.prototype, 'getDefaults').mockResolvedValue(DEFAULTS);
    const status = vi.spyOn(HermesWorkerAdapter.prototype, 'getRuntimeDiagnostic')
      .mockResolvedValue(diagnostic());
    const updated = { ...DEFAULTS, model: 'gpt-next', reasoningEffort: 'high' as const };
    const write = vi.spyOn(HermesWorkerAdapter.prototype, 'setDefaults').mockResolvedValue(updated);
    const runtime = new HermesOAuthRuntime();

    await expect(runtime.setDefaults({ model: 'gpt-next', reasoningEffort: 'high' })).resolves.toEqual(updated);
    expect(status).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith({
      provider: 'openai-codex',
      model: 'gpt-next',
      reasoningEffort: 'high',
    });
  });
});
