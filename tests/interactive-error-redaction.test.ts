import type { Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyEvent,
  broadcast,
  getRun,
  startRun,
  subscribe,
} from '../server/live-chat.js';
import { redactSensitiveText } from '../server/security/redaction.js';
import { publicError, toErrorMessage } from '../server/errors.js';

const SECRETS = [
  'bearer-secret',
  'dXNlcjpwYXNzd29yZA==',
  'digest-user',
  'digest-nonce',
  'digest-response',
  'token-secret',
  'credential-secret',
  'password-secret',
  'opaque-oauth-value-123456789',
] as const;

const SECRET_ERROR = [
  'Authorization: Bearer bearer-secret',
  'Authorization: Basic dXNlcjpwYXNzd29yZA==',
  'Authorization: Digest username="digest-user", nonce="digest-nonce", response="digest-response"',
  '{"token":"token-secret","credential":"credential-secret","password":"password-secret"}',
].join('\n');

function expectSecretFree(value: unknown): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of SECRETS) expect(serialized).not.toContain(secret);
}

describe('interactive error redaction boundary', () => {
  let closeSubscriber = () => {};

  afterEach(() => closeSubscriber());

  it('scrubs authorization schemes and structured credential aliases from text', () => {
    const scrubbed = redactSensitiveText(SECRET_ERROR);

    expectSecretFree(scrubbed);
    expect(scrubbed).toContain('[REDACTED]');
  });

  it('maps hostile or unknown worker codes to the stable generic code', () => {
    const error = publicError('constructor', `${SECRET_ERROR}\nopaque-oauth-value-123456789`);
    expect(error).toMatchObject({
      code: 'worker_error',
      message: 'Hermes worker request failed.',
    });
    expect(error.diagnostic).toBe('Untrusted diagnostic suppressed.');
    expectSecretFree(error);
  });

  it('does not publish opaque messages from untyped errors', () => {
    expect(toErrorMessage(
      new Error('provider rejected opaque-oauth-value-123456789'),
      'Hermes request failed.',
    )).toBe('Hermes request failed.');
  });

  it('redacts live state and the exact serialized SSE payload before writing', () => {
    const taskId = `secret-live-${Date.now()}`;
    const runId = `secret-run-${Date.now()}`;
    const writes: string[] = [];
    const response = {
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
      on(event: string, callback: () => void) {
        if (event === 'close') closeSubscriber = callback;
        return this;
      },
    } as unknown as Response;
    startRun(taskId, 'session', 'safe prompt', runId);
    subscribe(taskId, response);
    const event = { type: 'error' as const, code: 'auth_error', error: SECRET_ERROR };

    expect(applyEvent(taskId, runId, event)).toBe(true);
    broadcast(taskId, event);

    expectSecretFree(getRun(taskId));
    expectSecretFree(writes.join(''));
    expect(writes.join('')).toContain('[REDACTED]');
  });
});
