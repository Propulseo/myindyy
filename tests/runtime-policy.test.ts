import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorkerArguments, createWorkerEnvironment } from '../server/adapters/hermes-worker.js';
import { assertAllowedRuntime, sanitizeWorkerEnv } from '../server/runtime/policy.js';

const CREDENTIAL_NAMES = [
  [79, 80, 69, 78, 65, 73, 95, 65, 80, 73, 95, 75, 69, 89],
  [65, 78, 84, 72, 82, 79, 80, 73, 67, 95, 65, 80, 73, 95, 75, 69, 89],
  [79, 80, 69, 78, 82, 79, 85, 84, 69, 82, 95, 65, 80, 73, 95, 75, 69, 89],
  [67, 79, 68, 69, 88, 95, 65, 80, 73, 95, 75, 69, 89],
].map((points) => String.fromCodePoint(...points));

function credentialEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(CREDENTIAL_NAMES.flatMap((name, index) => [
    [name, `secret-${index}`],
    [name.toLowerCase(), `lower-secret-${index}`],
  ]));
}

describe('Codex OAuth runtime policy', () => {
  it('accepts the Hermes Codex OAuth provider with a model', () => {
    expect(assertAllowedRuntime({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    })).toMatchObject({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    });
  });

  it('rejects a non-OAuth provider before it can run', () => {
    expect(() => assertAllowedRuntime({ provider: 'openai', model: 'gpt-5.6-sol' }))
      .toThrow('OAuth-only');
  });

  it('rejects a missing model before it can run', () => {
    expect(() => assertAllowedRuntime({ provider: 'openai-codex', model: null }))
      .toThrow('model');
  });

  it('removes API-key provider credentials regardless of Windows environment-variable casing', () => {
    expect(sanitizeWorkerEnv({
      ...credentialEnvironment(),
      PATH: 'safe',
      SAFE_SETTING: 'retained',
    } as NodeJS.ProcessEnv)).toEqual({ PATH: 'safe', SAFE_SETTING: 'retained' });
  });

  it('passes only the sanitized environment and Hermes worker flags to spawn', () => {
    expect(createWorkerEnvironment({
      ...credentialEnvironment(),
      PATH: 'safe',
      SAFE_SETTING: 'retained',
      PYTHONHOME: '/untrusted/home',
      PYTHONPATH: '/untrusted/path',
      PYTHONUSERBASE: '/untrusted/user-base',
    } as NodeJS.ProcessEnv)).toEqual({
      PATH: 'safe',
      SAFE_SETTING: 'retained',
      HERMES_QUIET: '1',
      HERMES_YOLO_MODE: '1',
    });
  });

  it('runs the worker in isolated Python so an external site customization cannot execute', () => {
    const directory = mkdtempSync(join(tmpdir(), 'indy-python-isolation-'));
    const external = join(directory, 'external');
    const worker = join(directory, 'worker.py');
    const marker = join(directory, 'sitecustomize-ran');
    mkdirSync(external);
    writeFileSync(join(external, 'sitecustomize.py'), `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('ran')\n`);
    writeFileSync(worker, 'print("worker-ran")\n');
    const python = process.platform === 'win32' ? 'python' : 'python3';

    const output = execFileSync(python, createWorkerArguments(worker, {
      INDY_HERMES_RUNTIME_GUARD: '1',
    }), {
      encoding: 'utf8',
      env: createWorkerEnvironment({
        PATH: process.env.PATH,
        PYTHONPATH: external,
        PYTHONUSERBASE: external,
      }),
    });

    expect(output.trim()).toBe('worker-ran');
    expect(existsSync(marker)).toBe(false);
  });

  it('makes only the reviewed Hermes root importable before the guarded worker loads', () => {
    const directory = mkdtempSync(join(tmpdir(), 'indy-python-runtime-root-'));
    const runtimeRoot = join(directory, 'runtime');
    const workerDirectory = join(directory, 'worker');
    const schedulerDirectory = join(runtimeRoot, 'cron');
    const worker = join(workerDirectory, 'worker.py');
    mkdirSync(schedulerDirectory, { recursive: true });
    mkdirSync(workerDirectory, { recursive: true });
    writeFileSync(join(schedulerDirectory, '__init__.py'), '');
    writeFileSync(join(schedulerDirectory, 'scheduler.py'), 'VALUE = "reviewed-runtime"\n');
    writeFileSync(worker, 'from cron.scheduler import VALUE\nprint(VALUE)\n');
    const python = process.platform === 'win32' ? 'python' : 'python3';

    const output = execFileSync(python, createWorkerArguments(worker, {
      HERMES_AGENT_DIR: runtimeRoot,
      INDY_HERMES_RUNTIME_GUARD: '1',
    }), {
      encoding: 'utf8',
      env: createWorkerEnvironment({ PATH: process.env.PATH }),
    });

    expect(output.trim()).toBe('reviewed-runtime');
  });

  it('does not expose bootstrap paths as worker command-line arguments', () => {
    const directory = mkdtempSync(join(tmpdir(), 'indy-python-worker-argv-'));
    const runtimeRoot = join(directory, 'runtime');
    const worker = join(directory, 'worker.py');
    mkdirSync(runtimeRoot);
    writeFileSync(worker, [
      'import argparse',
      'parser = argparse.ArgumentParser()',
      'parser.parse_args()',
      'print("clean-worker-argv")',
      '',
    ].join('\n'));
    const python = process.platform === 'win32' ? 'python' : 'python3';

    const output = execFileSync(python, createWorkerArguments(worker, {
      HERMES_AGENT_DIR: runtimeRoot,
      INDY_HERMES_RUNTIME_GUARD: '1',
    }), {
      encoding: 'utf8',
      env: createWorkerEnvironment({ PATH: process.env.PATH }),
    });

    expect(output.trim()).toBe('clean-worker-argv');
  });
});
