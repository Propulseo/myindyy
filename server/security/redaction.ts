const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PARTS = [
  'token', 'key', 'secret', 'credential', 'authorization', 'cookie',
  'password', 'passwd', 'pwd', 'passphrase',
] as const;

export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /((?:"|')?(?:(?:proxy[_-]?)?authorization)(?:"|')?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi,
      '$1"[REDACTED]"',
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
      return [key, SENSITIVE_KEY_PARTS.some((part) => normalizedKey.includes(part))
        ? REDACTED
        : redactSensitiveValue(child)];
    })) as T;
  }
  return value;
}

export function serializeRedacted(value: unknown): string {
  return JSON.stringify(redactSensitiveValue(value));
}
