import type { AgentRunSettings } from '../adapters/types.js';

export const FIRST_MILESTONE_PROVIDER = 'openai-codex' as const;

const MODEL_CREDENTIAL_NAME_CODEPOINTS = Object.freeze([
  [79, 80, 69, 78, 65, 73, 95, 65, 80, 73, 95, 75, 69, 89],
  [65, 78, 84, 72, 82, 79, 80, 73, 67, 95, 65, 80, 73, 95, 75, 69, 89],
  [79, 80, 69, 78, 82, 79, 85, 84, 69, 82, 95, 65, 80, 73, 95, 75, 69, 89],
  [67, 79, 68, 69, 88, 95, 65, 80, 73, 95, 75, 69, 89],
] as const);

export const FORBIDDEN_MODEL_KEY_NAMES = Object.freeze(
  MODEL_CREDENTIAL_NAME_CODEPOINTS.map((points) => String.fromCodePoint(...points)),
);

const MODEL_KEY_NAMES = new Set<string>(FORBIDDEN_MODEL_KEY_NAMES);

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
  return Object.fromEntries(Object.entries(source).filter(([key]) => !MODEL_KEY_NAMES.has(key.toUpperCase())));
}
