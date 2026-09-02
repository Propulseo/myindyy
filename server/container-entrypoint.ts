import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  hardenHermesRuntimeCopy,
  validateHermesRuntimeExecution,
  validateHermesRuntimeManifest,
} from './hermes-runtime-manifest.js';

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

export interface PreparedHermesRuntime {
  readonly environment: NodeJS.ProcessEnv;
  readonly runtimeRoot: string;
  readonly scratchRoot: string;
}

export interface HermesMaterializationHooks {
  readonly afterSourceValidation?: (sourceRoot: string) => void;
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

function inspectImportedScheduler(
  python: string,
  environment: NodeJS.ProcessEnv,
  runtimeRoot: string,
): { actualHash: string; sourcePath: string } {
  const probe = [
    'import hashlib, inspect, json',
    'import cron.scheduler as scheduler',
    'path = inspect.getsourcefile(scheduler)',
    'assert path',
    'print(json.dumps({"path": path, "hash": hashlib.sha256(open(path, "rb").read()).hexdigest()}))',
  ].join('; ');
  const probeEnvironment = { ...environment };
  delete probeEnvironment.PYTHONHOME;
  delete probeEnvironment.PYTHONPATH;
  Object.assign(probeEnvironment, { PYTHONNOUSERSITE: '1', PYTHONSAFEPATH: '1' });
  const output = execFileSync(python, ['-I', '-c', probe], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    env: probeEnvironment,
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 15_000,
  }).trim();
  const parsed = JSON.parse(output) as PythonArtifactProbe;
  if (typeof parsed.path !== 'string' || typeof parsed.hash !== 'string') {
    throw new Error('Hermes scheduler probe returned an invalid response');
  }
  return { actualHash: parsed.hash, sourcePath: parsed.path };
}

function pathIsWithin(root: string, candidate: string): boolean {
  const within = relative(root, candidate);
  return within === '' || (within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within));
}

function removePrivateScratch(scratchRoot: string): void {
  if (!existsSync(scratchRoot)) return;
  const makeDirectoriesWritable = (directory: string) => {
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) makeDirectoriesWritable(join(directory, entry.name));
    }
  };
  makeDirectoriesWritable(scratchRoot);
  rmSync(scratchRoot, { force: true, recursive: true });
}

export function materializeHermesRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  hooks: HermesMaterializationHooks = {},
): PreparedHermesRuntime {
  const sourceRoot = environment.HERMES_SOURCE_DIR?.trim()
    || environment.HERMES_AGENT_DIR?.trim()
    || '';
  const sourcePython = environment.HERMES_SOURCE_PYTHON?.trim()
    || environment.HERMES_PYTHON?.trim()
    || '';
  const manifestFile = environment.HERMES_RUNTIME_MANIFEST_FILE?.trim() ?? '';
  const privateParent = environment.HERMES_PRIVATE_RUNTIME_PARENT?.trim()
    || join(tmpdir(), 'indy-private-hermes');
  if (![sourceRoot, sourcePython, manifestFile, privateParent].every(isAbsolute)) {
    throw new Error('Hermes source, Python, manifest, and private runtime parent must be absolute paths');
  }

  const resolvedSource = realpathSync(sourceRoot);
  const resolvedSourcePython = realpathSync(sourcePython);
  if (!pathIsWithin(resolvedSource, resolvedSourcePython)) {
    throw new Error('Hermes source Python resolves outside the reviewed runtime');
  }
  const pythonRelativePath = relative(resolvedSource, resolvedSourcePython);
  if (!pythonRelativePath || !pathIsWithin(resolvedSource, resolve(resolvedSource, pythonRelativePath))) {
    throw new Error('Hermes source Python path is not a runtime entry');
  }

  mkdirSync(privateParent, { recursive: true, mode: 0o700 });
  const resolvedPrivateParent = realpathSync(privateParent);
  if (pathIsWithin(resolvedSource, resolvedPrivateParent) || pathIsWithin(resolvedPrivateParent, resolvedSource)) {
    throw new Error('Hermes private runtime parent must be isolated from the bind source');
  }

  const scratchRoot = mkdtempSync(join(resolvedPrivateParent, 'hermes-'));
  const runtimeRoot = join(scratchRoot, 'runtime');
  const manifestSnapshot = join(scratchRoot, 'reviewed-manifest.json');
  try {
    copyFileSync(realpathSync(manifestFile), manifestSnapshot);
    validateHermesRuntimeManifest(resolvedSource, manifestSnapshot);
    hooks.afterSourceValidation?.(resolvedSource);
    cpSync(resolvedSource, runtimeRoot, {
      dereference: false,
      preserveTimestamps: true,
      recursive: true,
      verbatimSymlinks: true,
    });
    validateHermesRuntimeManifest(runtimeRoot, manifestSnapshot);
    const privatePython = join(runtimeRoot, pythonRelativePath);
    const resolvedPrivatePython = realpathSync(privatePython);
    if (!pathIsWithin(realpathSync(runtimeRoot), resolvedPrivatePython)) {
      throw new Error('Private Hermes Python resolves outside the reviewed runtime copy');
    }
    hardenHermesRuntimeCopy(runtimeRoot, privatePython);
    chmodSync(manifestSnapshot, 0o440);
    validateHermesRuntimeExecution(runtimeRoot, manifestSnapshot, privatePython);
    const preparedEnvironment: NodeJS.ProcessEnv = {
      ...environment,
      HERMES_AGENT_DIR: runtimeRoot,
      HERMES_PYTHON: privatePython,
      HERMES_RUNTIME_MANIFEST_FILE: manifestSnapshot,
      INDY_HERMES_RUNTIME_GUARD: '1',
      PYTHONNOUSERSITE: '1',
      PYTHONSAFEPATH: '1',
    };
    delete preparedEnvironment.HERMES_SOURCE_DIR;
    delete preparedEnvironment.HERMES_SOURCE_PYTHON;
    delete preparedEnvironment.PYTHONHOME;
    delete preparedEnvironment.PYTHONPATH;
    delete preparedEnvironment.PYTHONUSERBASE;
    return {
      environment: preparedEnvironment,
      runtimeRoot,
      scratchRoot,
    };
  } catch (error) {
    removePrivateScratch(scratchRoot);
    throw error;
  }
}

export function validateMountedHermesRuntime(
  environment: NodeJS.ProcessEnv = process.env,
): PreparedHermesRuntime {
  const prepared = materializeHermesRuntime(environment);
  try {
    const python = prepared.environment.HERMES_PYTHON!;
    const runtimeRoot = prepared.runtimeRoot;
    assertSchedulerArtifact({
      ...inspectImportedScheduler(python, prepared.environment, runtimeRoot),
      runtimeRoot,
      supportedHash: supportedHash(),
    });
    return prepared;
  } catch (error) {
    removePrivateScratch(prepared.scratchRoot);
    throw error;
  }
}

async function runServer(): Promise<number> {
  const prepared = validateMountedHermesRuntime();
  const serverEntry = fileURLToPath(new URL('./index.js', import.meta.url));
  const child = spawn(process.execPath, [serverEntry], {
    cwd: resolve(fileURLToPath(new URL('../..', import.meta.url))),
    env: prepared.environment,
    shell: false,
    stdio: 'inherit',
  });

  const forward = (signal: NodeJS.Signals) => {
    if (child.exitCode === null && !child.killed) child.kill(signal);
  };
  process.on('SIGTERM', forward);
  process.on('SIGINT', forward);

  return await new Promise<number>((resolveExit, reject) => {
    child.once('error', (error) => {
      removePrivateScratch(prepared.scratchRoot);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      process.off('SIGTERM', forward);
      process.off('SIGINT', forward);
      removePrivateScratch(prepared.scratchRoot);
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
