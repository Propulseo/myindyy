import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertSchedulerArtifact,
  extractSupportedSchedulerHash,
} from '../server/container-entrypoint.js';

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
});
