import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    || normalized.startsWith('e2e/')
    || normalized.startsWith('.superpowers/')
    || /(?:^|\/)task-\d+-report\.md$/i.test(normalized);
}

function assignedValue(line: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = line.match(new RegExp(
    `(?:^|[\\s{,;-])${escaped}\\s*(?::|=)\\s*(?:"([^"]*)"|'([^']*)'|([^\\s#,}\\]]*))`,
    'i',
  ));
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? '';
}

export function findForbiddenModelKeyAssignments(
  files: readonly TrackedTextFile[],
): ForbiddenModelKeyAssignment[] {
  const findings: ForbiddenModelKeyAssignment[] = [];
  for (const file of files) {
    if (excludedReferencePath(file.path) || file.content.includes('\0')) continue;
    const lines = file.content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trimStart();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
      for (const name of FORBIDDEN_MODEL_KEY_NAMES) {
        const value = assignedValue(line, name);
        if (value !== null && value.trim() !== '') {
          findings.push({ path: file.path, line: index + 1, name });
        }
      }
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
