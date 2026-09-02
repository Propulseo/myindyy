import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HermesWorkerAdapter } from '../server/adapters/hermes-worker.js';

const originalEnvironment = { ...process.env };
const adapters: HermesWorkerAdapter[] = [];

function workerFixture(mode: 'frozen' | 'late-then-ready'): string {
  const directory = mkdtempSync(join(tmpdir(), 'indy-worker-timeout-'));
  const script = join(directory, 'worker.mjs');
  writeFileSync(script, `
import { createInterface } from 'node:readline';
const mode = ${JSON.stringify(mode)};
let runtimeRequests = 0;
const lines = createInterface({ input: process.stdin });
const send = (id, data) => process.stdout.write(JSON.stringify({ id, type: 'result', data }) + '\\n');
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.type === 'health') {
    send(request.id, { ok: true });
    return;
  }
  if (request.type !== 'runtime.status' || mode === 'frozen') return;
  runtimeRequests += 1;
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

function adapterFor(mode: 'frozen' | 'late-then-ready'): HermesWorkerAdapter {
  process.env.HERMES_PYTHON = process.execPath;
  process.env.HERMES_WORKER_SCRIPT = workerFixture(mode);
  const adapter = new HermesWorkerAdapter();
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
});
