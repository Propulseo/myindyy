import { redactSensitiveText } from './security/redaction.js';

const PUBLIC_ERROR_MESSAGES = Object.freeze({
  auth_error: 'Codex authentication failed.',
  rate_limit: 'Codex rate limit reached.',
  quota_exhausted: 'Codex quota is unavailable.',
  model_error: 'The selected Codex model is unavailable.',
  provider_error: 'Codex provider request failed.',
  import_error: 'Hermes runtime is unavailable.',
  task_busy: 'The Hermes task is already running.',
  bad_request: 'Hermes rejected the request.',
  not_found: 'The requested Hermes resource was not found.',
  hermes_not_found: 'Hermes runtime is unavailable.',
  invalid_provider: 'The selected provider is unavailable.',
  compact_skipped: 'Hermes could not compact this session.',
  compact_unavailable: 'Hermes compaction is unavailable.',
  session_db_unavailable: 'Hermes session storage is unavailable.',
  session_load_error: 'Hermes session history is unavailable.',
  scheduled_task_busy: 'The Hermes scheduled task is already running.',
  worker_error: 'Hermes worker request failed.',
});

export type PublicErrorCode = keyof typeof PUBLIC_ERROR_MESSAGES;

export class PublicError extends Error {
  readonly code: PublicErrorCode;
  readonly diagnostic: string;

  constructor(code: PublicErrorCode, diagnostic = '') {
    super(PUBLIC_ERROR_MESSAGES[code]);
    this.name = 'PublicError';
    this.code = code;
    this.diagnostic = diagnostic ? 'Untrusted diagnostic suppressed.' : '';
  }
}

export function publicError(code: unknown, diagnostic = ''): PublicError {
  const stableCode: PublicErrorCode = typeof code === 'string'
    && Object.hasOwn(PUBLIC_ERROR_MESSAGES, code)
    ? code as PublicErrorCode
    : 'worker_error';
  return new PublicError(stableCode, diagnostic);
}

export function toErrorMessage(error: unknown, fallback = 'Something went wrong'): string {
  return error instanceof PublicError ? error.message : redactSensitiveText(fallback);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
