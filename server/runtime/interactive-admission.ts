import type { AgentRunSettings } from '../adapters/types.js';
import type { RuntimeStatus } from './hermes-runtime.js';
import type { Response } from 'express';

export const INTERACTIVE_PROVIDER = 'openai-codex' as const;
export const INTERACTIVE_PROFILE_ID = 'etienne-openai' as const;
export const INTERACTIVE_STATUS_MAX_AGE_MS = 2 * 60_000;
export const INTERACTIVE_STATUS_MAX_FUTURE_SKEW_MS = 30_000;

export type InteractiveAdmissionCode =
  | 'RUNTIME_UNAVAILABLE'
  | 'RUNTIME_STALE'
  | 'RUNTIME_PROVIDER_MISMATCH'
  | 'OAUTH_PROFILE_REQUIRED'
  | 'OAUTH_NOT_CONNECTED'
  | 'MODEL_UNAVAILABLE'
  | 'REASONING_EFFORT_REQUIRED'
  | 'REASONING_EFFORT_UNAVAILABLE';

const FAILURE_DETAILS: Readonly<Record<InteractiveAdmissionCode, {
  readonly status: 409 | 503;
  readonly message: string;
}>> = Object.freeze({
  RUNTIME_UNAVAILABLE: {
    status: 503,
    message: 'Codex runtime status is unavailable',
  },
  RUNTIME_STALE: {
    status: 503,
    message: 'Codex runtime status is stale',
  },
  RUNTIME_PROVIDER_MISMATCH: {
    status: 409,
    message: 'The active runtime is not the required Codex OAuth provider',
  },
  OAUTH_PROFILE_REQUIRED: {
    status: 409,
    message: 'The etienne-openai Codex OAuth profile is required',
  },
  OAUTH_NOT_CONNECTED: {
    status: 409,
    message: 'The etienne-openai Codex OAuth profile is not connected',
  },
  MODEL_UNAVAILABLE: {
    status: 409,
    message: 'The requested Codex model is not available for the active OAuth profile',
  },
  REASONING_EFFORT_REQUIRED: {
    status: 409,
    message: 'A Codex reasoning effort is required',
  },
  REASONING_EFFORT_UNAVAILABLE: {
    status: 409,
    message: 'The requested reasoning effort is not supported by the selected Codex model',
  },
});

export interface InteractiveRuntimeSource {
  getRuntimeStatus(): Promise<RuntimeStatus>;
}

export class InteractiveAdmissionError extends Error {
  readonly code: InteractiveAdmissionCode;
  readonly status: 409 | 503;

  constructor(code: InteractiveAdmissionCode) {
    const detail = FAILURE_DETAILS[code];
    super(detail.message);
    this.name = 'InteractiveAdmissionError';
    this.code = code;
    this.status = detail.status;
  }
}

function reject(code: InteractiveAdmissionCode): never {
  throw new InteractiveAdmissionError(code);
}

export async function requireInteractiveAdmission(
  source: InteractiveRuntimeSource,
  settings: AgentRunSettings,
  now: () => number = Date.now,
): Promise<RuntimeStatus> {
  if (settings.provider !== INTERACTIVE_PROVIDER) {
    reject('RUNTIME_PROVIDER_MISMATCH');
  }

  const requestedModel = settings.model?.trim();
  if (!requestedModel) reject('MODEL_UNAVAILABLE');
  if (!settings.reasoningEffort) reject('REASONING_EFFORT_REQUIRED');

  const runtime = await requireFreshInteractiveCatalog(source, now);

  const model = runtime.models.find((candidate) => candidate.id === requestedModel);
  if (!model) reject('MODEL_UNAVAILABLE');
  if (!model.reasoningEfforts?.includes(settings.reasoningEffort)) {
    reject('REASONING_EFFORT_UNAVAILABLE');
  }

  return runtime;
}

export async function requireFreshInteractiveCatalog(
  source: InteractiveRuntimeSource,
  now: () => number = Date.now,
): Promise<RuntimeStatus> {
  let received: unknown;
  try {
    received = await source.getRuntimeStatus();
  } catch {
    reject('RUNTIME_UNAVAILABLE');
  }

  if (!received || typeof received !== 'object' || Array.isArray(received)) {
    reject('RUNTIME_UNAVAILABLE');
  }
  const runtime = received as Partial<RuntimeStatus>;

  if (runtime.provider !== INTERACTIVE_PROVIDER) {
    reject('RUNTIME_PROVIDER_MISMATCH');
  }
  if (runtime.profileId !== INTERACTIVE_PROFILE_ID) {
    reject('OAUTH_PROFILE_REQUIRED');
  }
  if (runtime.authState !== 'connected') {
    reject('OAUTH_NOT_CONNECTED');
  }

  const checkedAt = typeof runtime.checkedAt === 'string'
    ? Date.parse(runtime.checkedAt)
    : Number.NaN;
  const age = now() - checkedAt;
  if (
    !Number.isFinite(checkedAt)
    || age > INTERACTIVE_STATUS_MAX_AGE_MS
    || age < -INTERACTIVE_STATUS_MAX_FUTURE_SKEW_MS
  ) {
    reject('RUNTIME_STALE');
  }

  if (!Array.isArray(runtime.models) || !runtime.models.every((model) => (
    model
    && typeof model === 'object'
    && typeof model.id === 'string'
    && typeof model.label === 'string'
    && (
      model.reasoningEfforts === null
      || (
        Array.isArray(model.reasoningEfforts)
        && model.reasoningEfforts.every((effort) => typeof effort === 'string')
      )
    )
  ))) {
    reject('RUNTIME_UNAVAILABLE');
  }

  return runtime as RuntimeStatus;
}

export function toInteractiveAdmissionHttp(error: unknown): {
  status: 409 | 503;
  body: { error: string; code: InteractiveAdmissionCode };
} {
  const failure = error instanceof InteractiveAdmissionError
    ? error
    : new InteractiveAdmissionError('RUNTIME_UNAVAILABLE');
  return {
    status: failure.status,
    body: { error: failure.message, code: failure.code },
  };
}

export function sendInteractiveAdmissionError(res: Response, error: unknown): Response {
  const failure = toInteractiveAdmissionHttp(error);
  return res.status(failure.status).json(failure.body);
}
