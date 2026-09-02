import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function runtimeFixture() {
  const parent = mkdtempSync(join(tmpdir(), 'indy-reviewed-runtime-'));
  const runtimeRoot = join(parent, 'runtime');
  const schedulerPath = join(runtimeRoot, 'venv', 'lib', 'python3.11', 'site-packages', 'cron', 'scheduler.py');
  const runnerPath = join(runtimeRoot, 'run_agent.py');
  mkdirSync(dirname(schedulerPath), { recursive: true });
  writeFileSync(schedulerPath, '# reviewed scheduler\n', 'utf8');
  writeFileSync(runnerPath, '# reviewed runner\n', 'utf8');
  return { parent, runtimeRoot, schedulerPath, runnerPath };
}

describe('reviewed Hermes runtime manifest', () => {
  it('generates a deterministic complete inventory and validates the exact mounted tree', async () => {
    const { createHermesRuntimeManifest, validateHermesRuntimeManifest } = await import(
      '../server/hermes-runtime-manifest.js'
    );
    const fixture = runtimeFixture();
    const manifest = createHermesRuntimeManifest(fixture.runtimeRoot);
    const manifestFile = join(fixture.parent, 'reviewed-manifest.json');
    writeFileSync(manifestFile, `${JSON.stringify(manifest)}\n`, 'utf8');

    expect(manifest).toEqual({
      schemaVersion: 1,
      entries: [
        { path: 'run_agent.py', type: 'file', sha256: sha256('# reviewed runner\n') },
        {
          path: 'venv/lib/python3.11/site-packages/cron/scheduler.py',
          type: 'file',
          sha256: sha256('# reviewed scheduler\n'),
        },
      ],
    });
    expect(() => validateHermesRuntimeManifest(fixture.runtimeRoot, manifestFile)).not.toThrow();
  });

  it('rejects drift in an executed artifact outside cron.scheduler', async () => {
    const { createHermesRuntimeManifest, validateHermesRuntimeManifest } = await import(
      '../server/hermes-runtime-manifest.js'
    );
    const fixture = runtimeFixture();
    const manifestFile = join(fixture.parent, 'reviewed-manifest.json');
    writeFileSync(manifestFile, JSON.stringify(createHermesRuntimeManifest(fixture.runtimeRoot)), 'utf8');
    writeFileSync(fixture.runnerPath, '# changed runner\n', 'utf8');

    expect(() => validateHermesRuntimeManifest(fixture.runtimeRoot, manifestFile))
      .toThrow('hash mismatch: run_agent.py');
  });

  it('rejects an unreviewed file added anywhere under the runtime mount', async () => {
    const { createHermesRuntimeManifest, validateHermesRuntimeManifest } = await import(
      '../server/hermes-runtime-manifest.js'
    );
    const fixture = runtimeFixture();
    const manifestFile = join(fixture.parent, 'reviewed-manifest.json');
    writeFileSync(manifestFile, JSON.stringify(createHermesRuntimeManifest(fixture.runtimeRoot)), 'utf8');
    const injected = join(fixture.runtimeRoot, 'hermes_cli', 'injected.py');
    mkdirSync(dirname(injected), { recursive: true });
    writeFileSync(injected, 'raise SystemExit("unreviewed")\n', 'utf8');

    expect(() => validateHermesRuntimeManifest(fixture.runtimeRoot, manifestFile))
      .toThrow(/unreviewed runtime entry: hermes_cli\/injected\.py/i);
  });
});
