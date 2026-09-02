import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_ENTRIES = 200_000;

export type HermesRuntimeManifestEntry =
  | { readonly path: string; readonly type: 'file'; readonly sha256: string }
  | { readonly path: string; readonly type: 'symlink'; readonly target: string };

export interface HermesRuntimeManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  readonly entries: readonly HermesRuntimeManifestEntry[];
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function manifestPath(parts: readonly string[]): string {
  return parts.join('/');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function inventory(root: string): HermesRuntimeManifestEntry[] {
  const rootPath = realpathSync(root);
  if (!lstatSync(rootPath).isDirectory()) throw new Error('Hermes runtime root is not a directory');
  const entries: HermesRuntimeManifestEntry[] = [];

  const visit = (absoluteDirectory: string, relativeParts: string[]) => {
    for (const directoryEntry of readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name))) {
      const parts = [...relativeParts, directoryEntry.name];
      const path = join(absoluteDirectory, directoryEntry.name);
      if (directoryEntry.isDirectory()) {
        visit(path, parts);
      } else if (directoryEntry.isFile()) {
        entries.push({ path: manifestPath(parts), type: 'file', sha256: hashFile(path) });
      } else if (directoryEntry.isSymbolicLink()) {
        entries.push({ path: manifestPath(parts), type: 'symlink', target: readlinkSync(path) });
      } else {
        throw new Error(`Unsupported Hermes runtime entry: ${manifestPath(parts)}`);
      }
      if (entries.length > MAX_MANIFEST_ENTRIES) {
        throw new Error(`Hermes runtime exceeds ${MAX_MANIFEST_ENTRIES} manifest entries`);
      }
    }
  };

  visit(rootPath, []);
  return entries.sort((left, right) => compareText(left.path, right.path));
}

function assertNoPythonPathConfiguration(entries: readonly HermesRuntimeManifestEntry[]): void {
  const pathConfiguration = entries.find((entry) => entry.path.toLowerCase().endsWith('.pth'));
  if (pathConfiguration) {
    throw new Error(`Hermes runtime contains forbidden Python path configuration: ${pathConfiguration.path}`);
  }
}

function visitRuntimeEntries(
  root: string,
  visit: (path: string, kind: 'directory' | 'file' | 'symlink') => void,
): void {
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        visit(path, 'directory');
      } else if (entry.isFile()) {
        visit(path, 'file');
      } else if (entry.isSymbolicLink()) {
        visit(path, 'symlink');
      } else {
        throw new Error(`Unsupported Hermes runtime entry while enforcing modes: ${path}`);
      }
    }
  };
  walk(root);
  visit(root, 'directory');
}

export function hardenHermesRuntimeCopy(runtimeRoot: string, pythonExecutable: string): void {
  const root = realpathSync(runtimeRoot);
  const executable = realpathSync(pythonExecutable);
  if (!pathIsWithin(root, executable) || !lstatSync(executable).isFile()) {
    throw new Error('Private Hermes Python must be a regular file inside the runtime copy');
  }
  visitRuntimeEntries(root, (path, kind) => {
    if (kind === 'symlink') return;
    chmodSync(path, kind === 'directory' ? 0o550 : 0o440);
  });
  chmodSync(executable, 0o550);
}

export function validateHermesRuntimeExecution(
  runtimeRoot: string,
  manifestFile: string,
  pythonExecutable: string,
): void {
  validateHermesRuntimeManifest(runtimeRoot, manifestFile);
  const root = realpathSync(runtimeRoot);
  const executable = realpathSync(pythonExecutable);
  assertNoPythonPathConfiguration(inventory(root));
  if (process.platform === 'win32') return;
  visitRuntimeEntries(root, (path, kind) => {
    if (kind === 'symlink') return;
    const mode = lstatSync(path).mode & 0o777;
    const expected = kind === 'directory' || realpathSync(path) === executable ? 0o550 : 0o440;
    if (mode !== expected) {
      throw new Error(`Hermes runtime mode mismatch: ${relative(root, path) || '.'}`);
    }
  });
}

export function createHermesRuntimeManifest(runtimeRoot: string): HermesRuntimeManifest {
  if (!isAbsolute(runtimeRoot)) throw new Error('Hermes runtime root must be absolute');
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, entries: inventory(runtimeRoot) };
}

function parseEntry(value: unknown, seen: Set<string>): HermesRuntimeManifestEntry {
  if (!value || typeof value !== 'object') throw new Error('Hermes runtime manifest entry is invalid');
  const candidate = value as Record<string, unknown>;
  const path = candidate.path;
  if (typeof path !== 'string'
    || !path
    || path.includes('\\')
    || path.includes('\0')
    || posix.isAbsolute(path)
    || posix.normalize(path) !== path
    || path.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('Hermes runtime manifest path is invalid');
  }
  if (seen.has(path)) throw new Error(`Duplicate Hermes runtime manifest path: ${path}`);
  seen.add(path);

  if (candidate.type === 'file'
    && typeof candidate.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(candidate.sha256)) {
    return { path, type: 'file', sha256: candidate.sha256 };
  }
  if (candidate.type === 'symlink'
    && typeof candidate.target === 'string'
    && candidate.target.length > 0
    && !candidate.target.includes('\0')) {
    return { path, type: 'symlink', target: candidate.target };
  }
  throw new Error(`Hermes runtime manifest entry is invalid: ${path}`);
}

function readManifest(manifestFile: string): HermesRuntimeManifest {
  if (!isAbsolute(manifestFile)) throw new Error('Hermes runtime manifest path must be absolute');
  const stat = lstatSync(manifestFile);
  if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) {
    throw new Error('Hermes runtime manifest must be a bounded regular file');
  }
  const parsed = JSON.parse(readFileSync(manifestFile, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error('Hermes runtime manifest is invalid');
  const candidate = parsed as Record<string, unknown>;
  if (candidate.schemaVersion !== MANIFEST_SCHEMA_VERSION || !Array.isArray(candidate.entries)) {
    throw new Error('Hermes runtime manifest schema is unsupported');
  }
  if (candidate.entries.length === 0 || candidate.entries.length > MAX_MANIFEST_ENTRIES) {
    throw new Error('Hermes runtime manifest entry count is invalid');
  }
  const seen = new Set<string>();
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    entries: candidate.entries.map((entry) => parseEntry(entry, seen)),
  };
}

function pathIsWithin(root: string, candidate: string): boolean {
  const pathWithinRoot = relative(root, candidate);
  return pathWithinRoot === ''
    || (!pathWithinRoot.startsWith(`..${sep}`) && pathWithinRoot !== '..' && !isAbsolute(pathWithinRoot));
}

function validateSymlinkTargets(
  runtimeRoot: string,
  entries: readonly HermesRuntimeManifestEntry[],
): void {
  for (const entry of entries) {
    if (entry.type !== 'symlink') continue;
    const symlinkPath = join(runtimeRoot, ...entry.path.split('/'));
    let resolvedTarget: string;
    try {
      resolvedTarget = realpathSync(symlinkPath);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as NodeJS.ErrnoException).code ?? '')
        : '';
      const problem = code === 'ELOOP' ? 'cyclic' : 'broken or cyclic';
      throw new Error(`Hermes runtime symlink is ${problem}: ${entry.path}`);
    }
    if (!pathIsWithin(runtimeRoot, resolvedTarget)) {
      throw new Error(`Hermes runtime symlink resolves outside the runtime: ${entry.path}`);
    }
    if (!statSync(resolvedTarget).isFile()) {
      throw new Error(`Hermes runtime symlink must resolve to a regular file: ${entry.path}`);
    }
  }
}

export function validateHermesRuntimeManifest(runtimeRoot: string, manifestFile: string): void {
  if (!isAbsolute(runtimeRoot)) throw new Error('Hermes runtime root must be absolute');
  const resolvedRoot = realpathSync(runtimeRoot);
  const resolvedManifest = realpathSync(manifestFile);
  if (pathIsWithin(resolvedRoot, resolvedManifest)) {
    throw new Error('Hermes runtime manifest must be anchored outside the runtime mount');
  }

  const expected = readManifest(resolvedManifest);
  const actualEntries = inventory(resolvedRoot);
  validateSymlinkTargets(resolvedRoot, actualEntries);
  const actualByPath = new Map(actualEntries.map((entry) => [entry.path, entry]));
  for (const entry of expected.entries) {
    const actual = actualByPath.get(entry.path);
    if (!actual) throw new Error(`Missing reviewed runtime entry: ${entry.path}`);
    if (entry.type !== actual.type) throw new Error(`Runtime entry type mismatch: ${entry.path}`);
    if (entry.type === 'file' && actual.type === 'file' && entry.sha256 !== actual.sha256) {
      throw new Error(`Hermes runtime hash mismatch: ${entry.path}`);
    }
    if (entry.type === 'symlink' && actual.type === 'symlink' && entry.target !== actual.target) {
      throw new Error(`Hermes runtime symlink mismatch: ${entry.path}`);
    }
    actualByPath.delete(entry.path);
  }
  const unreviewed = [...actualByPath.keys()].sort(compareText)[0];
  if (unreviewed) throw new Error(`Unreviewed runtime entry: ${unreviewed}`);
}

function main(): void {
  const runtimeRoot = process.argv[2];
  if (!runtimeRoot) throw new Error('Usage: hermes-runtime-manifest <absolute-runtime-root>');
  process.stdout.write(`${JSON.stringify(createHermesRuntimeManifest(runtimeRoot), null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Hermes runtime manifest failed'}\n`);
    process.exitCode = 1;
  }
}
