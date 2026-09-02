import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertSchedulerArtifact,
  extractSupportedSchedulerHash,
  validateMountedHermesRuntime,
} from '../server/container-entrypoint.js';
import { createHermesRuntimeManifest } from '../server/hermes-runtime-manifest.js';

const SUPPORTED_HASH = '5b4326fffe1b783fd2016a0c5c0bde21c3c8af613cc665897b9f48565d74e3c5';

describe('container Hermes artifact gate', () => {
  it('derives the supported hash from the worker contract instead of accepting a version label', () => {
    expect(extractSupportedSchedulerHash(`
      _SUPPORTED_SCHEDULER_SHA256 = "${SUPPORTED_HASH}"
    `)).toBe(SUPPORTED_HASH);
    expect(() => extractSupportedSchedulerHash('_SUPPORTED_SCHEDULER_SHA256 = "latest"'))
      .toThrow('supported scheduler hash');
  });

  it('accepts only the exact imported source inside the read-only mounted runtime root', () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'indy-hermes-runtime-'));
    const scheduler = join(runtimeRoot, 'venv', 'lib', 'python', 'site-packages', 'cron', 'scheduler.py');
    mkdirSync(join(scheduler, '..'), { recursive: true });
    writeFileSync(scheduler, '# pinned scheduler fixture\n');
    const outsideScheduler = join(runtimeRoot, '..', `unmounted-${Date.now()}`, 'scheduler.py');
    mkdirSync(join(outsideScheduler, '..'), { recursive: true });
    writeFileSync(outsideScheduler, '# unsupported scheduler fixture\n');

    expect(() => assertSchedulerArtifact({
      actualHash: SUPPORTED_HASH,
      sourcePath: scheduler,
      runtimeRoot,
      supportedHash: SUPPORTED_HASH,
    })).not.toThrow();
    expect(() => assertSchedulerArtifact({
      actualHash: '0'.repeat(64),
      sourcePath: scheduler,
      runtimeRoot,
      supportedHash: SUPPORTED_HASH,
    })).toThrow('hash');
    expect(() => assertSchedulerArtifact({
      actualHash: SUPPORTED_HASH,
      sourcePath: outsideScheduler,
      runtimeRoot,
      supportedHash: SUPPORTED_HASH,
    })).toThrow('mounted runtime');
  });

  it('checks the externally anchored full runtime manifest before executing mounted Python', () => {
    const parent = mkdtempSync(join(tmpdir(), 'indy-hermes-entrypoint-'));
    const runtimeRoot = join(parent, 'runtime');
    const runner = join(runtimeRoot, 'run_agent.py');
    const python = join(runtimeRoot, 'venv', 'bin', 'python');
    mkdirSync(join(python, '..'), { recursive: true });
    writeFileSync(runner, '# reviewed runner\n');
    writeFileSync(python, '# reviewed python fixture\n');
    const manifestFile = join(parent, 'reviewed-manifest.json');
    writeFileSync(manifestFile, JSON.stringify(createHermesRuntimeManifest(runtimeRoot)));
    writeFileSync(runner, '# drifted runner\n');

    expect(() => validateMountedHermesRuntime({
      HERMES_AGENT_DIR: runtimeRoot,
      HERMES_PYTHON: python,
      HERMES_RUNTIME_MANIFEST_FILE: manifestFile,
    })).toThrow('hash mismatch: run_agent.py');
  });

  it('materializes and revalidates a private runtime before exposing execution paths', async () => {
    const entrypoint = await import('../server/container-entrypoint.js') as typeof import('../server/container-entrypoint.js') & {
      materializeHermesRuntime?: (environment: NodeJS.ProcessEnv) => {
        environment: NodeJS.ProcessEnv;
        runtimeRoot: string;
      };
    };
    expect(entrypoint.materializeHermesRuntime).toBeTypeOf('function');

    const parent = mkdtempSync(join(tmpdir(), 'indy-hermes-private-'));
    const sourceRoot = join(parent, 'bind-source');
    const privateParent = join(parent, 'private');
    const sourcePython = join(sourceRoot, 'venv', 'bin', 'python');
    const sourceRunner = join(sourceRoot, 'run_agent.py');
    const sourceScheduler = join(sourceRoot, 'cron', 'scheduler.py');
    mkdirSync(join(sourcePython, '..'), { recursive: true });
    mkdirSync(join(sourceScheduler, '..'), { recursive: true });
    writeFileSync(sourcePython, '# reviewed python fixture\n');
    writeFileSync(sourceRunner, '# reviewed runner\n');
    writeFileSync(sourceScheduler, '# reviewed scheduler fixture\n');
    const manifestFile = join(parent, 'reviewed-manifest.json');
    writeFileSync(manifestFile, JSON.stringify(createHermesRuntimeManifest(sourceRoot)));

    const prepared = entrypoint.materializeHermesRuntime!({
      HERMES_SOURCE_DIR: sourceRoot,
      HERMES_SOURCE_PYTHON: sourcePython,
      HERMES_PRIVATE_RUNTIME_PARENT: privateParent,
      HERMES_RUNTIME_MANIFEST_FILE: manifestFile,
      HERMES_HOME: join(parent, 'oauth-home'),
      PYTHONHOME: sourceRoot,
      PYTHONPATH: sourceRoot,
      PYTHONUSERBASE: sourceRoot,
    });
    const privateRunner = join(prepared.runtimeRoot, 'run_agent.py');
    writeFileSync(sourceRunner, '# bind mutated after private copy\n');

    expect(prepared.runtimeRoot).not.toBe(sourceRoot);
    expect(prepared.environment.HERMES_AGENT_DIR).toBe(prepared.runtimeRoot);
    expect(prepared.environment.HERMES_PYTHON).toBe(join(prepared.runtimeRoot, 'venv', 'bin', 'python'));
    expect(prepared.environment.HERMES_HOME).toBe(join(parent, 'oauth-home'));
    expect(prepared.environment.PYTHONHOME).toBeUndefined();
    expect(prepared.environment.PYTHONPATH).toBeUndefined();
    expect(prepared.environment.PYTHONUSERBASE).toBeUndefined();
    expect(prepared.environment.PYTHONNOUSERSITE).toBe('1');
    expect(prepared.environment.PYTHONSAFEPATH).toBe('1');
    expect(readFileSync(privateRunner, 'utf8')).toBe('# reviewed runner\n');
    expect(() => assertSchedulerArtifact({
      actualHash: SUPPORTED_HASH,
      sourcePath: sourceScheduler,
      runtimeRoot: prepared.runtimeRoot,
      supportedHash: SUPPORTED_HASH,
    })).toThrow('mounted runtime');
    expect(() => assertSchedulerArtifact({
      actualHash: SUPPORTED_HASH,
      sourcePath: join(prepared.runtimeRoot, 'cron', 'scheduler.py'),
      runtimeRoot: prepared.runtimeRoot,
      supportedHash: SUPPORTED_HASH,
    })).not.toThrow();
  });

  it('fails revalidation and removes the private scratch if the source changes after review', async () => {
    const entrypoint = await import('../server/container-entrypoint.js');
    const parent = mkdtempSync(join(tmpdir(), 'indy-hermes-copy-race-'));
    const sourceRoot = join(parent, 'bind-source');
    const privateParent = join(parent, 'private');
    const sourcePython = join(sourceRoot, 'venv', 'bin', 'python');
    const sourceRunner = join(sourceRoot, 'run_agent.py');
    mkdirSync(join(sourcePython, '..'), { recursive: true });
    writeFileSync(sourcePython, '# reviewed python fixture\n');
    writeFileSync(sourceRunner, '# reviewed runner\n');
    const manifestFile = join(parent, 'reviewed-manifest.json');
    writeFileSync(manifestFile, JSON.stringify(createHermesRuntimeManifest(sourceRoot)));

    expect(() => entrypoint.materializeHermesRuntime({
      HERMES_SOURCE_DIR: sourceRoot,
      HERMES_SOURCE_PYTHON: sourcePython,
      HERMES_PRIVATE_RUNTIME_PARENT: privateParent,
      HERMES_RUNTIME_MANIFEST_FILE: manifestFile,
    }, {
      afterSourceValidation: () => {
        writeFileSync(sourceRunner, '# mutated while materializing\n');
        writeFileSync(manifestFile, JSON.stringify(createHermesRuntimeManifest(sourceRoot)));
      },
    })).toThrow('hash mismatch: run_agent.py');
    expect(readdirSync(privateParent)).toEqual([]);
  });
});
