import { describe, expect, it } from 'vitest';
import { findForbiddenModelKeyAssignments } from '../server/security/model-key-scan.js';

const CREDENTIAL_NAMES = [
  [79, 80, 69, 78, 65, 73, 95, 65, 80, 73, 95, 75, 69, 89],
  [65, 78, 84, 72, 82, 79, 80, 73, 67, 95, 65, 80, 73, 95, 75, 69, 89],
  [79, 80, 69, 78, 82, 79, 85, 84, 69, 82, 95, 65, 80, 73, 95, 75, 69, 89],
  [67, 79, 68, 69, 88, 95, 65, 80, 73, 95, 75, 69, 89],
].map((points) => String.fromCodePoint(...points));

describe('tracked-file model credential scan', () => {
  it.each(CREDENTIAL_NAMES)('fails on a direct forbidden credential assignment', (name) => {
    expect(findForbiddenModelKeyAssignments([{
      path: '.github/workflows/ci.yml',
      content: `env:\n  ${name}: injected-value\n`,
    }])).toEqual([{ path: '.github/workflows/ci.yml', line: 2, name }]);
  });

  it('does not let a tracked line exempt the credential reference that follows it', () => {
    const name = CREDENTIAL_NAMES[0]!;
    const formerDirective = ['// indy-model-key-scan:', 'allow-reference'].join(' ');

    expect(findForbiddenModelKeyAssignments([{
      path: 'server/self-exemption.ts',
      content: `${formerDirective}\nprocess.env.${name} = "leaked";\n`,
    }])).toEqual([{ path: 'server/self-exemption.ts', line: 2, name }]);
  });

  it('detects deployment, container inheritance, PowerShell, JavaScript, and shell forms', () => {
    const [first, second, third, fourth] = CREDENTIAL_NAMES as [string, string, string, string];
    const files = [
      { path: 'e2e/fixture.ts', content: `process.env.${first} = "e2e-secret";\n` },
      { path: 'config/runtime.json', content: `{ "${second}": "json-secret" }\n` },
      { path: 'deploy/values.yml', content: `${third}: yaml-secret\n` },
      { path: 'server/bootstrap.ts', content: `const env = { ${fourth}: \`ts-secret\` };\n` },
      { path: 'docker-compose.yml', content: `environment:\n  - ${first}\n` },
      { path: 'deploy/compose-inline.yml', content: `environment: [ "${second}" ]\n` },
      { path: 'scripts/deploy.ps1', content: `$env:${third} = 'inherited'\n` },
      { path: 'server/env.ts', content: `process . env [ '${fourth}' ] ||= 'inherited';\n` },
      { path: 'scripts/start.sh', content: `export  "${first}"\n` },
    ];

    expect(findForbiddenModelKeyAssignments(files)).toEqual([
      { path: 'e2e/fixture.ts', line: 1, name: first },
      { path: 'config/runtime.json', line: 1, name: second },
      { path: 'deploy/values.yml', line: 1, name: third },
      { path: 'server/bootstrap.ts', line: 1, name: fourth },
      { path: 'docker-compose.yml', line: 2, name: first },
      { path: 'deploy/compose-inline.yml', line: 1, name: second },
      { path: 'scripts/deploy.ps1', line: 1, name: third },
      { path: 'server/env.ts', line: 1, name: fourth },
      { path: 'scripts/start.sh', line: 1, name: first },
    ]);
  });

  it('normalizes comments, quotes, parentheses, templates, scalars, and continuations between name characters', () => {
    const [first, second, third, fourth] = CREDENTIAL_NAMES as [string, string, string, string];
    const jsComment = `process.env["${first.slice(0, 2)}" /* reviewed? no */ + ("${first.slice(2)}")] = "leaked";\n`;
    const shellComment = `export ${second.slice(0, 5)}\\\n# inserted separator\n${second.slice(5)}=leaked\n`;
    const yamlScalar = `credential: >-\n  ${third.slice(0, 4)}\n  (${third.slice(4)})\n`;
    const template = `process.env[\`${fourth.slice(0, 5)}\${""}${fourth.slice(5)}\`] = "leaked";\n`;
    const heredoc = `cat <<'EOF'\n${first.slice(0, 7)}\n${first.slice(7)}\nEOF\n`;
    const htmlComment = `${second.slice(0, 6)}<!-- inserted separator -->${second.slice(6)}=leaked\n`;

    expect(findForbiddenModelKeyAssignments([
      { path: 'server/comment-fragment.ts', content: jsComment },
      { path: 'scripts/comment-fragment.sh', content: shellComment },
      { path: 'deploy/scalar.yml', content: yamlScalar },
      { path: 'server/template.ts', content: template },
      { path: 'scripts/heredoc.sh', content: heredoc },
      { path: 'docs/fragment.html', content: htmlComment },
    ])).toEqual([
      { path: 'server/comment-fragment.ts', line: 1, name: first },
      { path: 'scripts/comment-fragment.sh', line: 1, name: second },
      { path: 'deploy/scalar.yml', line: 2, name: third },
      { path: 'server/template.ts', line: 1, name: fourth },
      { path: 'scripts/heredoc.sh', line: 2, name: first },
      { path: 'docs/fragment.html', line: 1, name: second },
    ]);
  });

  it('decodes JavaScript and YAML literal escapes before scanning credential names', () => {
    const [first, second] = CREDENTIAL_NAMES as [string, string];
    const unicodeEscaped = [...first]
      .map((character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`)
      .join('');
    const hexEscaped = [...second]
      .map((character) => `\\x${character.codePointAt(0)!.toString(16).padStart(2, '0')}`)
      .join('');
    const braceEscaped = [...first]
      .map((character) => `\\u{${character.codePointAt(0)!.toString(16)}}`)
      .join('');

    expect(findForbiddenModelKeyAssignments([
      { path: 'server/escaped.ts', content: `process.env["${unicodeEscaped}"] = "leaked";\n` },
      { path: 'deploy/escaped.yml', content: `environment:\n  "${hexEscaped}": inherited\n` },
      { path: 'server/escaped-brace.ts', content: `process.env["${braceEscaped}"] = "leaked";\n` },
    ])).toEqual([
      { path: 'server/escaped.ts', line: 1, name: first },
      { path: 'deploy/escaped.yml', line: 2, name: second },
      { path: 'server/escaped-brace.ts', line: 1, name: first },
    ]);
  });

  it('constant-folds String.fromCharCode in process environment access', () => {
    const name = CREDENTIAL_NAMES[2]!;
    const codePoints = [...name].map((character) => character.codePointAt(0)!).join(', ');

    expect(findForbiddenModelKeyAssignments([{
      path: 'server/from-char-code.ts',
      content: `process.env[String.fromCharCode(${codePoints})] = "leaked";\n`,
    }])).toEqual([{ path: 'server/from-char-code.ts', line: 1, name }]);
  });

  it('decodes BOM-marked UTF-16 PowerShell and fails closed on ambiguous NUL text', () => {
    const name = CREDENTIAL_NAMES[0]!;
    const script = `$env:${name} = 'inherited'\r\n`;
    const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(script, 'utf16le')]);
    const utf16bePayload = Buffer.from(script, 'utf16le');
    for (let index = 0; index < utf16bePayload.length; index += 2) {
      [utf16bePayload[index], utf16bePayload[index + 1]] = [utf16bePayload[index + 1]!, utf16bePayload[index]!];
    }
    const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16bePayload]);

    expect(findForbiddenModelKeyAssignments([
      { path: 'scripts/deploy-le.ps1', content: utf16le },
      { path: 'scripts/deploy-be.ps1', content: utf16be },
    ])).toEqual([
      { path: 'scripts/deploy-le.ps1', line: 1, name },
      { path: 'scripts/deploy-be.ps1', line: 1, name },
    ]);
    expect(() => findForbiddenModelKeyAssignments([
      { path: 'scripts/ambiguous.ps1', content: Buffer.from([0x73, 0x00, 0x61]) },
    ])).toThrow(/NUL|ambiguous/i);
    expect(() => findForbiddenModelKeyAssignments([
      { path: 'scripts/invalid.txt', content: Buffer.from([0xc3, 0x28]) },
    ])).toThrow(/encoding|ambiguous/i);
  });

});
