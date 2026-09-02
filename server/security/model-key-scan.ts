import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
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

function isRecognizedBinaryAsset(path: string, content: Buffer): boolean {
  const extension = extname(path).toLowerCase();
  if (extension === '.png') {
    return content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (extension === '.ico') {
    return content.length >= 4 && content[0] === 0 && content[1] === 0 && content[2] === 1 && content[3] === 0;
  }
  if (extension === '.mp3') {
    return content.subarray(0, 3).toString('ascii') === 'ID3'
      || (content.length >= 2 && content[0] === 0xff && (content[1]! & 0xe0) === 0xe0);
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
  readonly character: string;
  readonly line: number;
  readonly sourceIndex: number;
}

function sourceBoundary(source: string, index: number, direction: -1 | 1): boolean {
  let cursor = index + direction;
  while (cursor >= 0 && cursor < source.length && /["'`]/.test(source[cursor]!)) cursor += direction;
  return cursor < 0 || cursor >= source.length || !/[A-Z0-9_]/i.test(source[cursor]!);
}

function sourceCharacters(source: string): SourceCharacter[] {
  const characters: SourceCharacter[] = [];
  let line = 1;
  for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex += 1) {
    const character = source[sourceIndex]!;
    characters.push({ character, line, sourceIndex });
    if (character === '\n') line += 1;
  }
  return characters;
}

function withoutComments(characters: readonly SourceCharacter[]): SourceCharacter[] {
  const result: SourceCharacter[] = [];
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  for (let index = 0; index < characters.length; index += 1) {
    const current = characters[index]!;
    const next = characters[index + 1];
    if (quote) {
      result.push(current);
      if (escaped) escaped = false;
      else if (current.character === '\\') escaped = true;
      else if (current.character === quote) quote = null;
      continue;
    }
    if (current.character === '"' || current.character === "'" || current.character === '`') {
      quote = current.character;
      result.push(current);
      continue;
    }
    if (current.character === '<'
      && next?.character === '!'
      && characters[index + 2]?.character === '-'
      && characters[index + 3]?.character === '-') {
      index += 4;
      while (index < characters.length
        && !(characters[index]?.character === '-'
          && characters[index + 1]?.character === '-'
          && characters[index + 2]?.character === '>')) {
        index += 1;
      }
      if (index < characters.length) index += 2;
      continue;
    }
    if (current.character === '/' && next?.character === '*') {
      index += 2;
      while (index < characters.length
        && !(characters[index]?.character === '*' && characters[index + 1]?.character === '/')) {
        index += 1;
      }
      if (index < characters.length) index += 1;
      continue;
    }
    if ((current.character === '/' && next?.character === '/') || current.character === '#') {
      while (index + 1 < characters.length && characters[index + 1]?.character !== '\n') index += 1;
      continue;
    }
    result.push(current);
  }
  return result;
}

function normalizedIdentifierView(characters: readonly SourceCharacter[]): {
  readonly normalized: string;
  readonly mapping: readonly SourceCharacter[];
} {
  const mapping = characters.filter(({ character }) => /[A-Z0-9_]/i.test(character));
  return {
    normalized: mapping.map(({ character }) => character).join(''),
    mapping,
  };
}

function addNormalizedFindings(
  path: string,
  source: string,
  characters: readonly SourceCharacter[],
  addFinding: (finding: ForbiddenModelKeyAssignment) => void,
): void {
  const { normalized, mapping } = normalizedIdentifierView(characters);
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
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      for (const name of FORBIDDEN_MODEL_KEY_NAMES) {
        if (mentionsForbiddenName(line, name)) {
          addFinding({ path: file.path, line: index + 1, name });
        }
      }
    }
    const characters = sourceCharacters(content);
    addNormalizedFindings(file.path, content, characters, addFinding);
    addNormalizedFindings(file.path, content, withoutComments(characters), addFinding);
  }
  return findings;
}

export function forbiddenModelCredentialEnvironmentEntries(
  environment: NodeJS.ProcessEnv,
): string[] {
  const forbidden = new Set(FORBIDDEN_MODEL_KEY_NAMES);
  return Object.keys(environment).filter((name) => forbidden.has(name.toUpperCase()));
}

function trackedFiles(root: string): TrackedTextFile[] {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  return output.split('\0')
    .filter(Boolean)
    .flatMap((path) => {
      const content = readFileSync(resolve(root, path));
      return isRecognizedBinaryAsset(path, content) ? [] : [{ path, content }];
    });
}

function main(): void {
  if (process.argv.includes('--environment')) {
    if (forbiddenModelCredentialEnvironmentEntries(process.env).length > 0) {
      process.stderr.write('Forbidden model credential exists in the environment.\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write('Model credential environment check passed.\n');
    return;
  }
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
