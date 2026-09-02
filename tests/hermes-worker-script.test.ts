import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkerScript } from '../server/adapters/hermes-worker.js';

describe('Hermes worker script selection', () => {
  it('accepts an explicit absolute worker fixture path for deterministic harnesses', () => {
    const directory = mkdtempSync(join(tmpdir(), 'indy-worker-script-'));
    const fixture = join(directory, 'fake_worker.py');
    writeFileSync(fixture, '# deterministic worker fixture\n');

    expect(resolveWorkerScript({ HERMES_WORKER_SCRIPT: fixture })).toBe(fixture);
  });

  it('rejects relative and missing explicit worker paths', () => {
    expect(() => resolveWorkerScript({ HERMES_WORKER_SCRIPT: 'fake_worker.py' }))
      .toThrow('absolute');
    expect(() => resolveWorkerScript({ HERMES_WORKER_SCRIPT: join(tmpdir(), 'missing-worker.py') }))
      .toThrow('does not exist');
  });
});
