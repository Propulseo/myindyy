import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

type WorkerModule = typeof import('../server/adapters/hermes-worker.js');

const originalEnvironment = { ...process.env };
const adapters: Array<{ stop(): Promise<void> }> = [];

function restoreEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, originalEnvironment);
}

function workerFixture(model: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'indy-worker-frozen-launch-'));
  const script = join(directory, 'worker.mjs');
  writeFileSync(script, `
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
const send = (id, data) => process.stdout.write(JSON.stringify({ id, type: 'result', data }) + '\\n');
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.type === 'health') send(request.id, { ok: true });
  if (request.type === 'runtime.status') send(request.id, {
    provider: 'openai-codex', profileId: 'etienne-openai', authState: 'connected',
    checkedAt: '2026-09-02T08:00:00.000Z',
    models: [{
      id: ${JSON.stringify(model)} + ':' + process.env.FROZEN_WORKER_VALUE,
      label: ${JSON.stringify(model)},
      reasoningEfforts: ['high'],
    }],
  });
});
`, 'utf8');
  return script;
}

type FakeBehavior = {
  health?: 'ignore' | 'respond';
  runtime?: 'ignore' | 'respond';
  terminate?: 'exit' | 'error-then-exit';
  terminationDelayMs?: number;
  synchronousTerminationEvent?: boolean;
  stderrChunks?: string[];
  stdoutChunks?: string[];
};

class FakeWorkerChild extends EventEmitter {
  readonly pid: number;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private input = '';
  private terminated = false;

  constructor(
    readonly ordinal: number,
    private readonly behavior: FakeBehavior,
    private readonly onTerminal: () => void,
  ) {
    super();
    this.pid = ordinal;
    this.stdin = new Writable({
      write: (chunk, _encoding, done) => {
        this.input += String(chunk);
        let newline = this.input.indexOf('\n');
        while (newline >= 0) {
          const line = this.input.slice(0, newline);
          this.input = this.input.slice(newline + 1);
          if (line) this.handleRequest(JSON.parse(line) as { id: string; type: string });
          newline = this.input.indexOf('\n');
        }
        done();
      },
    });
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    this.killed = true;
    if (signal === 'SIGKILL') {
      this.finish('exit');
      return true;
    }
    const finish = () => this.finish(this.behavior.terminate ?? 'exit');
    if (this.behavior.synchronousTerminationEvent) finish();
    else setTimeout(finish, this.behavior.terminationDelayMs ?? 0);
    return true;
  }

  private handleRequest(request: { id: string; type: string }): void {
    if (request.type === 'health') {
      if (this.behavior.health !== 'ignore') this.send(request.id, { ok: true });
      return;
    }
    if (request.type !== 'runtime.status') return;
    for (const chunk of this.behavior.stderrChunks ?? []) this.stderr.write(chunk);
    for (const chunk of this.behavior.stdoutChunks ?? []) this.stdout.write(chunk);
    if (this.behavior.runtime === 'respond') {
      this.send(request.id, {
        provider: 'openai-codex',
        profileId: 'etienne-openai',
        authState: 'connected',
        checkedAt: '2026-09-02T08:00:00.000Z',
        models: [{ id: `generation-${this.ordinal}`, label: `generation-${this.ordinal}`, reasoningEfforts: ['high'] }],
      });
    }
  }

  private send(id: string, data: unknown): void {
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({ id, type: 'result', data })}\n`));
  }

  private finish(kind: 'exit' | 'error-then-exit'): void {
    if (kind === 'error-then-exit') {
      this.emit('error', new Error(`generation ${this.ordinal} terminated`));
      setTimeout(() => this.finish('exit'), 15);
      return;
    }
    if (this.terminated) return;
    this.terminated = true;
    this.onTerminal();
    this.stderr.end();
    this.stdout.end();
    this.exitCode = 0;
    this.emit('exit', 0, null);
  }
}

function fakeSpawner(behaviors: FakeBehavior[]) {
  const children: FakeWorkerChild[] = [];
  let active = 0;
  let maxActive = 0;
  const spawnWorker = () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const child = new FakeWorkerChild(children.length + 1, behaviors[children.length] ?? {}, () => {
      active -= 1;
    });
    children.push(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { children, spawnWorker, maxActive: () => maxActive };
}

async function loadWorkerModule(): Promise<WorkerModule> {
  vi.resetModules();
  return await import('../server/adapters/hermes-worker.js');
}

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.stop();
  restoreEnvironment();
  vi.restoreAllMocks();
});

describe('Hermes worker frozen launch contract', () => {
  it('keeps the executable, script, argv and child environment captured at module import', async () => {
    const frozenScript = workerFixture('frozen-model');
    process.env.HERMES_PYTHON = process.execPath;
    process.env.HERMES_WORKER_SCRIPT = frozenScript;
    process.env.FROZEN_WORKER_VALUE = 'captured';
    delete process.env.INDY_HERMES_RUNTIME_GUARD;
    const worker = await loadWorkerModule();

    process.env.HERMES_PYTHON = join(tmpdir(), 'mutated-missing-python');
    process.env.HERMES_WORKER_SCRIPT = join(tmpdir(), 'mutated-missing-worker');
    process.env.INDY_HERMES_RUNTIME_GUARD = '1';
    process.env.HERMES_AGENT_DIR = join(tmpdir(), 'mutated-runtime');
    process.env.HERMES_RUNTIME_MANIFEST_FILE = join(tmpdir(), 'mutated-manifest');
    process.env.FROZEN_WORKER_VALUE = 'mutated';

    const adapter = new worker.HermesWorkerAdapter();
    adapters.push(adapter);
    const status = await adapter.getRuntimeDiagnostic(500);

    expect(status.models.map((model) => model.id)).toEqual(['frozen-model:captured']);
  });
});

describe('Hermes worker generations', () => {
  it('escalates a startup timeout and waits for SIGKILL termination before replacement', async () => {
    const worker = await loadWorkerModule();
    const fake = fakeSpawner([
      { health: 'ignore', terminationDelayMs: 100 },
      { runtime: 'respond' },
    ]);
    const adapter = new worker.HermesWorkerAdapter({
      launchContract: worker.captureWorkerLaunchContract(process.env),
      spawnWorker: fake.spawnWorker,
      readyTimeoutMs: 5,
      terminationGraceMs: 5,
    });
    adapters.push(adapter);

    await expect(adapter.start()).rejects.toThrow('within 5ms');
    expect(fake.children[0]?.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect((await adapter.getRuntimeDiagnostic(100)).models).toMatchObject([
      { id: 'generation-2' },
    ]);
    expect(fake.maxActive()).toBe(1);
  });

  it('retires a timed-out generation completely before spawning its replacement', async () => {
    const worker = await loadWorkerModule();
    const fake = fakeSpawner([
      { runtime: 'ignore', terminationDelayMs: 40 },
      { runtime: 'respond' },
    ]);
    const adapter = new worker.HermesWorkerAdapter({
      launchContract: worker.captureWorkerLaunchContract(process.env),
      spawnWorker: fake.spawnWorker,
      terminationGraceMs: 100,
    });
    adapters.push(adapter);

    const timedOut = adapter.getRuntimeDiagnostic(10).catch((error: Error) => error.message);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const replacement = adapter.getRuntimeDiagnostic(250);

    expect(fake.children).toHaveLength(1);
    expect(await timedOut).toBe('Hermes worker did not respond within 10ms');
    expect((await replacement).models.map((model) => model.id)).toEqual(['generation-2']);
    expect(fake.maxActive()).toBe(1);
    expect(fake.children[0]?.killSignals).toContain('SIGTERM');
  });

  it('isolates replacement pending requests from a late duplicate exit of the old generation', async () => {
    const worker = await loadWorkerModule();
    const fake = fakeSpawner([
      { runtime: 'ignore', terminate: 'error-then-exit', synchronousTerminationEvent: true },
      { runtime: 'respond' },
    ]);
    const adapter = new worker.HermesWorkerAdapter({
      launchContract: worker.captureWorkerLaunchContract(process.env),
      spawnWorker: fake.spawnWorker,
      terminationGraceMs: 50,
    });
    adapters.push(adapter);

    await expect(adapter.getRuntimeDiagnostic(5)).rejects.toThrow('within 5ms');
    const replacement = await adapter.getRuntimeDiagnostic(100);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(replacement.models.map((model) => model.id)).toEqual(['generation-2']);
    expect(await adapter.getRuntimeDiagnostic(100)).toMatchObject({
      models: [{ id: 'generation-2' }],
    });
    expect(fake.maxActive()).toBe(1);
  });

  it('rejects every pending request owned by a timed-out generation', async () => {
    const worker = await loadWorkerModule();
    const fake = fakeSpawner([{ runtime: 'ignore' }]);
    const adapter = new worker.HermesWorkerAdapter({
      launchContract: worker.captureWorkerLaunchContract(process.env),
      spawnWorker: fake.spawnWorker,
      terminationGraceMs: 50,
    });
    adapters.push(adapter);

    const first = adapter.getRuntimeDiagnostic(10).catch((error: Error) => error.message);
    const sibling = adapter.getRuntimeDiagnostic(1_000).catch((error: Error) => error.message);

    expect(await first).toBe('Hermes worker did not respond within 10ms');
    expect(await sibling).toContain('Hermes worker did not respond within 10ms');
  });

  it('never forwards opaque worker stdout or stderr while retaining a structural diagnostic', async () => {
    const worker = await loadWorkerModule();
    const fake = fakeSpawner([{
      runtime: 'respond',
      stderrChunks: [
        '[provider] Authorization: Bearer fragmented-',
        'worker-secret\nprovider rejected opaque-oauth-value-123456789',
      ],
      stdoutChunks: ['provider stdout contained opaque-stdout-secret-987654321\n'],
    }]);
    const adapter = new worker.HermesWorkerAdapter({
      launchContract: worker.captureWorkerLaunchContract(process.env),
      spawnWorker: fake.spawnWorker,
    });
    adapters.push(adapter);
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    await adapter.getRuntimeDiagnostic(100);
    expect(stderr.join('')).not.toContain('opaque-oauth-value-123456789');
    expect(stderr.join('')).not.toContain('opaque-stdout-secret-987654321');
    await adapter.stop();

    const captured = stderr.join('');
    expect(captured).toContain('[hermes-worker] worker stderr received');
    expect(captured).toContain('[hermes-worker] discarded non-protocol stdout');
    expect(captured).not.toContain('fragmented-worker-secret');
    expect(captured).not.toContain('opaque-oauth-value-123456789');
    expect(captured).not.toContain('opaque-stdout-secret-987654321');
  });
});
