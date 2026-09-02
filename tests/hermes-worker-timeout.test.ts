import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureWorkerLaunchContract,
  HermesWorkerAdapter,
} from '../server/adapters/hermes-worker.js';

const originalEnvironment = { ...process.env };
const adapters: HermesWorkerAdapter[] = [];

function workerFixture(mode: 'frozen' | 'late-then-ready' | 'secret-boundary'): string {
  const directory = mkdtempSync(join(tmpdir(), 'indy-worker-timeout-'));
  const script = join(directory, 'worker.mjs');
  const runtimeCounter = join(directory, 'runtime-counter');
  writeFileSync(script, `
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const mode = ${JSON.stringify(mode)};
const runtimeCounter = ${JSON.stringify(runtimeCounter)};
const lines = createInterface({ input: process.stdin });
const send = (id, data) => process.stdout.write(JSON.stringify({ id, type: 'result', data }) + '\\n');
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.type === 'health') {
    send(request.id, { ok: true });
    return;
  }
  if (mode === 'secret-boundary') {
    const detail = 'Authorization: Bearer bearer-worker-secret\\nAuthorization: Basic dXNlcjpwYXNz\\nAuthorization: Digest username="digest-worker-user", nonce="digest-worker-nonce", response="digest-worker-response"\\n{"token":"worker-token-secret","credential":"worker-credential-secret","password":"worker-password-secret"}';
    process.stderr.write('[provider] ' + detail + '\\n');
    process.stdout.write(JSON.stringify({
      id: request.id,
      type: 'error',
      error: { code: 'auth_error', message: detail, hint: detail },
    }) + '\\n');
    if (request.type === 'chat') {
      process.stdout.write(JSON.stringify({ id: request.id, type: 'done', sessionId: request.sessionId }) + '\\n');
    }
    return;
  }
  if (request.type !== 'runtime.status' || mode === 'frozen') return;
  const runtimeRequests = existsSync(runtimeCounter) ? Number(readFileSync(runtimeCounter, 'utf8')) + 1 : 1;
  writeFileSync(runtimeCounter, String(runtimeRequests));
  const first = runtimeRequests === 1;
  setTimeout(() => send(request.id, {
    provider: 'openai-codex',
    profileId: 'etienne-openai',
    authState: 'connected',
    checkedAt: '2026-09-02T08:00:00.000Z',
    models: [{
      id: first ? 'late-model' : 'fresh-model',
      label: first ? 'late-model' : 'fresh-model',
      reasoningEfforts: ['high'],
    }],
  }), first ? 60 : 100);
});
`, 'utf8');
  return script;
}

function adapterFor(mode: 'frozen' | 'late-then-ready' | 'secret-boundary'): HermesWorkerAdapter {
  const adapter = new HermesWorkerAdapter({
    launchContract: captureWorkerLaunchContract({
      ...process.env,
      HERMES_PYTHON: process.execPath,
      HERMES_WORKER_SCRIPT: workerFixture(mode),
      INDY_HERMES_RUNTIME_GUARD: undefined,
    }),
  });
  adapters.push(adapter);
  return adapter;
}

async function outcomeWithin(
  promise: Promise<unknown>,
  guardMs = 200,
): Promise<{ kind: 'resolved' } | { kind: 'rejected'; message: string } | { kind: 'guard' }> {
  return await Promise.race([
    promise.then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({
        kind: 'rejected' as const,
        message: error instanceof Error ? error.message : String(error),
      }),
    ),
    new Promise<{ kind: 'guard' }>((resolve) => {
      setTimeout(() => resolve({ kind: 'guard' }), guardMs);
    }),
  ]);
}

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.stop();
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, originalEnvironment);
});

describe('Hermes worker bounded request lifecycle', () => {
  it('rejects repeated frozen runtime status requests within their deadline', async () => {
    const adapter = adapterFor('frozen');

    const outcomes = await Promise.all([
      outcomeWithin(adapter.getRuntimeDiagnostic(25)),
      outcomeWithin(adapter.getRuntimeDiagnostic(25)),
    ]);

    expect(outcomes).toEqual([
      { kind: 'rejected', message: 'Hermes worker did not respond within 25ms' },
      { kind: 'rejected', message: 'Hermes worker did not respond within 25ms' },
    ]);
  });

  it('ignores a response arriving after timeout and resolves the next request with its own result', async () => {
    const adapter = adapterFor('late-then-ready');

    expect(await outcomeWithin(adapter.getRuntimeDiagnostic(20))).toEqual({
      kind: 'rejected',
      message: 'Hermes worker did not respond within 20ms',
    });
    const fresh = await adapter.getRuntimeDiagnostic(200);

    expect(fresh.models.map((model) => model.id)).toEqual(['fresh-model']);
  });

  it('turns worker failures into stable public errors and redacts captured stderr and stream events', async () => {
    const adapter = adapterFor('secret-boundary');
    const stderr: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    try {
      const diagnostic = await adapter.getRuntimeDiagnostic(200).then(
        () => ({ message: 'resolved', code: undefined }),
        (error: Error & { code?: string }) => ({ message: error.message, code: error.code }),
      );
      const events = [];
      for await (const event of adapter.chatStream('secret-session', 'safe prompt')) events.push(event);

      expect(diagnostic).toEqual({ message: 'Codex authentication failed.', code: 'auth_error' });
      expect(events).toContainEqual({
        type: 'error',
        error: 'Codex authentication failed.',
        code: 'auth_error',
      });
      const exposed = JSON.stringify({ stderr, events, diagnostic });
      for (const secret of [
        'bearer-worker-secret', 'dXNlcjpwYXNz', 'digest-worker-user',
        'digest-worker-nonce', 'digest-worker-response', 'worker-token-secret',
        'worker-credential-secret', 'worker-password-secret',
      ]) expect(exposed).not.toContain(secret);
      expect(stderr.join('')).toContain('[REDACTED]');
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
