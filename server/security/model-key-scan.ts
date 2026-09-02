import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { FORBIDDEN_MODEL_KEY_NAMES } from '../runtime/policy.js';

export interface TrackedTextFile {
  readonly path: string;
  readonly content: string;
}

export interface ForbiddenModelKeyAssignment {
  readonly path: string;
  readonly line: number;
  readonly name: string;
}

function excludedReferencePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return normalized === 'README.md'
    || normalized.startsWith('docs/')
    || normalized.startsWith('tests/')
    || normalized.startsWith('.superpowers/')
    || /(?:^|\/)task-\d+-report\.md$/i.test(normalized);
}

function assignedValue(line: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const value = '(?:"([^"]*)"|\'([^\']*)\'|`([^`]*)`|([^\\s#,}\\];]*))';
  const patterns = [
    new RegExp(
      `(?:^|[\\s{,;-])(?:export\\s+)?(?:${escaped}|["']${escaped}["'])\\s*(?::|=)\\s*${value}`,
      'i',
    ),
    new RegExp(
      `\\bprocess\\s*\\.\\s*env\\s*(?:\\.\\s*${escaped}|\\[\\s*["']${escaped}["']\\s*\\])\\s*=\\s*${value}`,
      'i',
    ),
  ];
  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match) return match.slice(1).find((part) => part !== undefined) ?? '';
  }
  return null;
}

function valueIsNonempty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return typeof value !== 'string' || value.trim() !== '';
}

function structuredDocument(path: string, content: string): unknown {
  const normalized = path.toLowerCase();
  try {
    if (normalized.endsWith('.json')) return JSON.parse(content) as unknown;
    if (normalized.endsWith('.yaml') || normalized.endsWith('.yml')) return parseYaml(content) as unknown;
  } catch {
    // Text scanning still covers assignment syntax in malformed documents.
  }
  return undefined;
}

function structuredAssignedNames(value: unknown): Set<string> {
  const assigned = new Set<string>();
  const visited = new Set<object>();
  const visit = (candidate: unknown) => {
    if (typeof candidate === 'string') {
      for (const name of FORBIDDEN_MODEL_KEY_NAMES) {
        if (candidate.toUpperCase().startsWith(`${name}=`)
          && candidate.slice(name.length + 1).trim() !== '') assigned.add(name);
      }
      return;
    }
    if (!candidate || typeof candidate !== 'object' || visited.has(candidate)) return;
    visited.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    const record = candidate as Record<string, unknown>;
    for (const [key, nested] of Object.entries(record)) {
      const forbiddenName = FORBIDDEN_MODEL_KEY_NAMES.find((name) => key.toUpperCase() === name);
      if (forbiddenName && valueIsNonempty(nested)) assigned.add(forbiddenName);
      visit(nested);
    }
    const configuredName = record.name;
    if (typeof configuredName === 'string') {
      const forbiddenName = FORBIDDEN_MODEL_KEY_NAMES.find(
        (name) => configuredName.toUpperCase() === name,
      );
      if (forbiddenName
        && (valueIsNonempty(record.value) || valueIsNonempty(record.valueFrom))) {
        assigned.add(forbiddenName);
      }
    }
  };
  visit(value);
  return assigned;
}

function firstNameLine(content: string, name: string): number {
  const index = content.toUpperCase().indexOf(name);
  return index === -1 ? 1 : content.slice(0, index).split(/\r?\n/).length;
}

export function findForbiddenModelKeyAssignments(
  files: readonly TrackedTextFile[],
): ForbiddenModelKeyAssignment[] {
  const findings: ForbiddenModelKeyAssignment[] = [];
  const findingKeys = new Set<string>();
  const addFinding = (finding: ForbiddenModelKeyAssignment) => {
    const key = `${finding.path}\0${finding.line}\0${finding.name}`;
    if (!findingKeys.has(key)) {
      findingKeys.add(key);
      findings.push(finding);
    }
  };
  for (const file of files) {
    if (excludedReferencePath(file.path) || file.content.includes('\0')) continue;
    const lines = file.content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trimStart();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
      for (const name of FORBIDDEN_MODEL_KEY_NAMES) {
        const value = assignedValue(line, name);
        if (value !== null && value.trim() !== '') {
          addFinding({ path: file.path, line: index + 1, name });
        }
      }
    }
    for (const name of structuredAssignedNames(structuredDocument(file.path, file.content))) {
      addFinding({ path: file.path, line: firstNameLine(file.content, name), name });
    }
  }
  return findings;
}

function trackedFiles(root: string): TrackedTextFile[] {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  return output.split('\0').filter(Boolean).flatMap((path) => {
    try {
      return [{ path, content: readFileSync(resolve(root, path), 'utf8') }];
    } catch {
      return [];
    }
  });
}

function main(): void {
  const findings = findForbiddenModelKeyAssignments(trackedFiles(process.cwd()));
  if (findings.length === 0) {
    process.stdout.write('Model API key assignment scan passed.\n');
    return;
  }
  for (const finding of findings) {
    process.stderr.write(`${finding.path}:${finding.line}: forbidden ${finding.name} assignment\n`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
