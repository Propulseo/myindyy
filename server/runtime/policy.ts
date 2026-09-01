import type { AgentRunSettings } from '../adapters/types.js';

export const FIRST_MILESTONE_PROVIDER = 'openai-codex' as const;

const MODEL_KEY_NAMES = new Set([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'CODEX_API_KEY',
]);

export interface ResolvedRuntimePolicy {
  provider: typeof FIRST_MILESTONE_PROVIDER;
  model: string;
  reasoningEffort: AgentRunSettings['reasoningEffort'];
}

export class RuntimePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimePolicyError';
  }
}

export function assertAllowedRuntime(settings: AgentRunSettings): ResolvedRuntimePolicy {
  if (settings.provider !== FIRST_MILESTONE_PROVIDER) {
    throw new RuntimePolicyError('OAuth-only provider required');
  }
  if (!settings.model?.trim()) {
    throw new RuntimePolicyError('A model is required');
  }
  return {
    provider: FIRST_MILESTONE_PROVIDER,
    model: settings.model.trim(),
    reasoningEffort: settings.reasoningEffort ?? null,
  };
}

export function sanitizeWorkerEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !MODEL_KEY_NAMES.has(key)));
}
