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

const REFERENCE_SUPPRESSION = /(?:#|\/\/|<!--)\s*indy-model-key-scan:\s*allow-reference\b/i;

function explicitlySuppressed(line: string): boolean {
  return REFERENCE_SUPPRESSION.test(line);
}

function mentionsForbiddenName(line: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Z0-9_])${escaped}(?=$|[^A-Z0-9_])`, 'i').test(line);
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
    if (file.content.includes('\0')) continue;
    const lines = file.content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.trim() || explicitlySuppressed(line)) continue;
      for (const name of FORBIDDEN_MODEL_KEY_NAMES) {
        if (mentionsForbiddenName(line, name)) {
          addFinding({ path: file.path, line: index + 1, name });
        }
      }
    }
  }
  return findings;
}

function trackedFiles(root: string): TrackedTextFile[] {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  return output.split('\0').filter(Boolean).map((path) => ({
    path,
    content: readFileSync(resolve(root, path), 'utf8'),
  }));
}

function main(): void {
  const findings = findForbiddenModelKeyAssignments(trackedFiles(process.cwd()));
  if (findings.length === 0) {
    process.stdout.write('Model API key reference scan passed.\n');
    return;
  }
  for (const finding of findings) {
    process.stderr.write(`${finding.path}:${finding.line}: forbidden ${finding.name} reference\n`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
