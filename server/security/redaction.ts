const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PARTS = ['token', 'key', 'secret', 'credential', 'authorization', 'cookie'] as const;

export function redactSensitiveText(value: string): string {
  return value
    .replace(/(bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(
      /((?:"|')?(?:(?:access[_-]?)?token|api[_-]?key|secret|credential|authorization|password)(?:"|')?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      '$1[REDACTED]',
    );
}

export function serializeRedacted(value: unknown): string {
  return JSON.stringify(value, (key, child: unknown) => {
    const normalizedKey = key.toLowerCase();
    if (SENSITIVE_KEY_PARTS.some((part) => normalizedKey.includes(part))) return REDACTED;
    return typeof child === 'string' ? redactSensitiveText(child) : child;
  });
}
