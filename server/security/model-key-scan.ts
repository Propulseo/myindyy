import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { FORBIDDEN_MODEL_KEY_NAMES } from '../runtime/policy.js';

export interface TrackedTextFile {
  readonly path: string;
  readonly content: string | Uint8Array;
}

export interface ForbiddenModelKeyAssignment {
  readonly path: string;
  readonly line: number;
  readonly name: string;
}

const REFERENCE_SUPPRESSION = 'indy-model-key-scan: allow-reference';
const SLASH_COMMENT_EXTENSIONS = new Set(['.cjs', '.css', '.js', '.jsx', '.mjs', '.scss', '.ts', '.tsx']);
const HASH_COMMENT_EXTENSIONS = new Set([
  '.bash', '.conf', '.env', '.ini', '.ps1', '.py', '.sh', '.toml', '.yaml', '.yml', '.zsh',
]);
const REVIEWED_BINARY_ASSET_EXTENSIONS = new Set(['.ico', '.mp3', '.png']);

function isSuppressionDirective(path: string, line: string): boolean {
  const trimmed = line.trim().toLowerCase();
  const extension = extname(path).toLowerCase();
  if (SLASH_COMMENT_EXTENSIONS.has(extension)) {
    return trimmed === `// ${REFERENCE_SUPPRESSION}`;
  }
  if (HASH_COMMENT_EXTENSIONS.has(extension) || basename(path).toLowerCase().startsWith('dockerfile')) {
    return trimmed === `# ${REFERENCE_SUPPRESSION}`;
  }
  if (extension === '.md' || extension === '.mdx') {
    return trimmed === `<!-- ${REFERENCE_SUPPRESSION} -->` || trimmed === `# ${REFERENCE_SUPPRESSION}`;
  }
  return false;
}

function mentionsForbiddenName(line: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Z0-9_])${escaped}(?=$|[^A-Z0-9_])`, 'i').test(line);
}

function decodeTrackedContent(file: TrackedTextFile): string {
  if (typeof file.content === 'string') {
    if (file.content.includes('\0')) {
      throw new Error(`${file.path}: ambiguous text contains a NUL byte`);
    }
    return file.content;
  }

  const bytes = Buffer.from(file.content);
  let encoding: 'utf-8' | 'utf-16le' | 'utf-16be' = 'utf-8';
  let offset = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    offset = 3;
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le';
    offset = 2;
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be';
    offset = 2;
  } else if (bytes.includes(0)) {
    throw new Error(`${file.path}: ambiguous NUL-bearing text has no supported BOM`);
  }

  let decoded: string;
  try {
    decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset));
  } catch (error) {
    throw new Error(`${file.path}: unsupported or ambiguous text encoding`, { cause: error });
  }
  if (decoded.includes('\0')) {
    throw new Error(`${file.path}: ambiguous decoded text contains a NUL character`);
  }
  return decoded;
}

interface SourceCharacter {
  readonly line: number;
  readonly sourceIndex: number;
}

function sourceBoundary(source: string, index: number, direction: -1 | 1): boolean {
  let cursor = index + direction;
  while (cursor >= 0 && cursor < source.length && /["'`]/.test(source[cursor]!)) cursor += direction;
  return cursor < 0 || cursor >= source.length || !/[A-Z0-9_]/i.test(source[cursor]!);
}

function addFragmentedFindings(
  path: string,
  source: string,
  addFinding: (finding: ForbiddenModelKeyAssignment) => void,
): void {
  let normalized = '';
  const mapping: SourceCharacter[] = [];
  let line = 1;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '\\' && (source[index + 1] === '\n' || (source[index + 1] === '\r' && source[index + 2] === '\n'))) {
      if (source[index + 1] === '\r') index += 1;
      index += 1;
      line += 1;
      continue;
    }
    if (character === '\n') line += 1;
    if (/\s|["'`+]/.test(character)) continue;
    normalized += character;
    mapping.push({ line, sourceIndex: index });
  }

  const lowerNormalized = normalized.toLowerCase();
  for (const name of FORBIDDEN_MODEL_KEY_NAMES) {
    const lowerName = name.toLowerCase();
    let offset = 0;
    while (offset < lowerNormalized.length) {
      const matchIndex = lowerNormalized.indexOf(lowerName, offset);
      if (matchIndex < 0) break;
      offset = matchIndex + 1;
      const first = mapping[matchIndex];
      const last = mapping[matchIndex + name.length - 1];
      if (!first || !last) continue;
      const sourceSpan = source.slice(first.sourceIndex, last.sourceIndex + 1);
      if (!/\+|\\\r?\n/.test(sourceSpan)) continue;
      if (!sourceBoundary(source, first.sourceIndex, -1) || !sourceBoundary(source, last.sourceIndex, 1)) continue;
      addFinding({ path, line: first.line, name });
    }
  }
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
    const content = decodeTrackedContent(file);
    const lines = content.split(/\r?\n/);
    const fragmentSourceLines: string[] = [];
    let suppressNextLine = false;
    for (const [index, line] of lines.entries()) {
      if (isSuppressionDirective(file.path, line)) {
        suppressNextLine = true;
        fragmentSourceLines.push('');
        continue;
      }
      if (suppressNextLine) {
        suppressNextLine = false;
        fragmentSourceLines.push('');
        continue;
      }
      fragmentSourceLines.push(line);
      if (!line.trim()) continue;
      for (const name of FORBIDDEN_MODEL_KEY_NAMES) {
        if (mentionsForbiddenName(line, name)) {
          addFinding({ path: file.path, line: index + 1, name });
        }
      }
    }
    addFragmentedFindings(file.path, fragmentSourceLines.join('\n'), addFinding);
  }
  return findings;
}

function trackedFiles(root: string): TrackedTextFile[] {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  return output.split('\0')
    .filter((path) => path && !REVIEWED_BINARY_ASSET_EXTENSIONS.has(extname(path).toLowerCase()))
    .map((path) => ({
      path,
      content: readFileSync(resolve(root, path)),
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
