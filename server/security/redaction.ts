const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PARTS = [
  'token', 'key', 'secret', 'credential', 'authorization', 'cookie',
  'password', 'passwd', 'pwd', 'passphrase',
] as const;
const SAFE_SENSITIVE_LIKE_KEYS = new Set([
  'used_tokens', 'window_tokens', 'input_tokens', 'output_tokens',
  'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens',
  'dispatchtoken', 'idempotencykey',
]);

export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /("(?:proxy[_-]?)?authorization"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
      '$1"[REDACTED]"',
    )
    .replace(
      /('(?:proxy[_-]?)?authorization'\s*:\s*)'(?:\\.|[^'\\])*'/gi,
      "$1'[REDACTED]'",
    )
    .replace(
      /(\b(?:(?:proxy[_-]?)?authorization)\s*[:=]\s*)[^\r\n]*/gi,
      '$1[REDACTED]',
    )
    .replace(/(bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(
      /((?:"|')?(?:(?:access[_-]?)?token|api[_-]?key|secret|credential|password|passwd|pwd|passphrase)(?:"|')?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      '$1[REDACTED]',
    );
}

export function redactSensitiveValue<T>(value: T): T {
  if (typeof value === 'string') return redactSensitiveText(value) as T;
  if (Array.isArray(value)) return value.map((child) => redactSensitiveValue(child)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      const normalizedKey = key.toLowerCase();
      return [key, !SAFE_SENSITIVE_LIKE_KEYS.has(normalizedKey)
        && SENSITIVE_KEY_PARTS.some((part) => normalizedKey.includes(part))
        ? REDACTED
        : redactSensitiveValue(child)];
    })) as T;
  }
  return value;
}

export function serializeRedacted(value: unknown): string {
  return JSON.stringify(redactSensitiveValue(value));
}
