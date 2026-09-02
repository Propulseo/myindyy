import { describe, expect, it } from 'vitest';
import { FORBIDDEN_MODEL_KEY_NAMES } from '../server/runtime/policy.js';
import { findForbiddenModelKeyAssignments } from '../server/security/model-key-scan.js';

describe('tracked-file model key scan', () => {
  it.each(FORBIDDEN_MODEL_KEY_NAMES)('fails on a nonempty %s assignment', (name) => {
    expect(findForbiddenModelKeyAssignments([{
      path: '.github/workflows/ci.yml',
      content: `env:\n  ${name}: injected-value\n`,
    }])).toEqual([{ path: '.github/workflows/ci.yml', line: 2, name }]);
  });

  it('allows empty examples and policy/test/document references without false positives', () => {
    expect(findForbiddenModelKeyAssignments([
      { path: '.env.example', content: 'OPENAI_API_KEY=\n' },
      { path: 'docs/runbook-vps.md', content: 'Never set OPENAI_API_KEY=value.\n' },
      { path: 'tests/policy.test.ts', content: "OPENAI_API_KEY: 'test-only'\n" },
      { path: 'server/runtime/policy.ts', content: "'OPENAI_API_KEY',\n" },
    ])).toEqual([]);
  });

  it('detects assignments in tracked E2E, JSON, YAML, TypeScript, and env syntax', () => {
    expect(findForbiddenModelKeyAssignments([
      { path: 'e2e/fixture.ts', content: 'process.env.OPENAI_API_KEY = "e2e-secret";\n' },
      { path: 'config/runtime.json', content: '{ "ANTHROPIC_API_KEY": "json-secret" }\n' },
      { path: 'deploy/values.yml', content: 'OPENROUTER_API_KEY: yaml-secret\n' },
      { path: 'server/bootstrap.ts', content: 'const env = { CODEX_API_KEY: `ts-secret` };\n' },
      { path: '.env.production', content: 'export OPENAI_API_KEY=env-secret\n' },
      { path: 'server/bracket.ts', content: 'process.env["ANTHROPIC_API_KEY"] = "bracket-secret";\n' },
    ])).toEqual([
      { path: 'e2e/fixture.ts', line: 1, name: 'OPENAI_API_KEY' },
      { path: 'config/runtime.json', line: 1, name: 'ANTHROPIC_API_KEY' },
      { path: 'deploy/values.yml', line: 1, name: 'OPENROUTER_API_KEY' },
      { path: 'server/bootstrap.ts', line: 1, name: 'CODEX_API_KEY' },
      { path: '.env.production', line: 1, name: 'OPENAI_API_KEY' },
      { path: 'server/bracket.ts', line: 1, name: 'ANTHROPIC_API_KEY' },
    ]);
  });

  it('detects structured name/value and serialized container environment forms', () => {
    expect(findForbiddenModelKeyAssignments([
      {
        path: 'deploy/pod.yml',
        content: 'env:\n  - name: OPENAI_API_KEY\n    value: oauth-bypass\n',
      },
      {
        path: 'e2e/container.json',
        content: '{\n  "Env": ["ANTHROPIC_API_KEY=json-array-secret"]\n}\n',
      },
    ])).toEqual([
      { path: 'deploy/pod.yml', line: 2, name: 'OPENAI_API_KEY' },
      { path: 'e2e/container.json', line: 2, name: 'ANTHROPIC_API_KEY' },
    ]);
  });
});
