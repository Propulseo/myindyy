import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HASH_ASSIGNMENT = /_SUPPORTED_SCHEDULER_SHA256\s*=\s*["']([a-f0-9]{64})["']/;

interface SchedulerArtifact {
  readonly actualHash: string;
  readonly sourcePath: string;
  readonly runtimeRoot: string;
  readonly supportedHash: string;
}

interface PythonArtifactProbe {
  readonly hash?: unknown;
  readonly path?: unknown;
}

export function extractSupportedSchedulerHash(workerContract: string): string {
  const hash = workerContract.match(HASH_ASSIGNMENT)?.[1];
  if (!hash) throw new Error('Indy worker does not declare a supported scheduler hash');
  return hash;
}

export function assertSchedulerArtifact(artifact: SchedulerArtifact): void {
  if (artifact.actualHash !== artifact.supportedHash) {
    throw new Error('Imported Hermes scheduler hash is not supported');
  }
  const runtimeRoot = realpathSync(artifact.runtimeRoot);
  const sourcePath = realpathSync(artifact.sourcePath);
  const pathWithinRuntime = relative(runtimeRoot, sourcePath);
  if (!pathWithinRuntime || pathWithinRuntime === '..' || pathWithinRuntime.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(pathWithinRuntime)) {
    throw new Error('Imported Hermes scheduler is outside the mounted runtime');
  }
}

function supportedHash(): string {
  const contractPath = fileURLToPath(new URL('./workers/hermes_scheduled_tasks.py', import.meta.url));
  return extractSupportedSchedulerHash(readFileSync(contractPath, 'utf8'));
}

function inspectImportedScheduler(python: string): { actualHash: string; sourcePath: string } {
  const probe = [
    'import hashlib, inspect, json',
    'import cron.scheduler as scheduler',
    'path = inspect.getsourcefile(scheduler)',
    'assert path',
    'print(json.dumps({"path": path, "hash": hashlib.sha256(open(path, "rb").read()).hexdigest()}))',
  ].join('; ');
  const output = execFileSync(python, ['-c', probe], {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 15_000,
  }).trim();
  const parsed = JSON.parse(output) as PythonArtifactProbe;
  if (typeof parsed.path !== 'string' || typeof parsed.hash !== 'string') {
    throw new Error('Hermes scheduler probe returned an invalid response');
  }
  return { actualHash: parsed.hash, sourcePath: parsed.path };
}

export function validateMountedHermesRuntime(environment: NodeJS.ProcessEnv = process.env): void {
  const python = environment.HERMES_PYTHON?.trim() ?? '';
  const runtimeRoot = environment.HERMES_AGENT_DIR?.trim() ?? '';
  if (!isAbsolute(python) || !isAbsolute(runtimeRoot)) {
    throw new Error('HERMES_PYTHON and HERMES_AGENT_DIR must be absolute mounted paths');
  }
  assertSchedulerArtifact({
    ...inspectImportedScheduler(python),
    runtimeRoot,
    supportedHash: supportedHash(),
  });
}

async function runServer(): Promise<number> {
  validateMountedHermesRuntime();
  const serverEntry = fileURLToPath(new URL('./index.js', import.meta.url));
  const child = spawn(process.execPath, [serverEntry], {
    cwd: resolve(fileURLToPath(new URL('../..', import.meta.url))),
    env: process.env,
    shell: false,
    stdio: 'inherit',
  });

  const forward = (signal: NodeJS.Signals) => {
    if (child.exitCode === null && !child.killed) child.kill(signal);
  };
  process.on('SIGTERM', forward);
  process.on('SIGINT', forward);

  return await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      process.off('SIGTERM', forward);
      process.off('SIGINT', forward);
      resolveExit(code ?? (signal ? 1 : 0));
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runServer()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'Container startup failed');
      process.exitCode = 1;
    });
}
