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

  it('allows only explicitly suppressed reference lines and still scans the next line', () => {
    expect(findForbiddenModelKeyAssignments([
      {
        path: 'docs/runbook-vps.md',
        content: [
          'Never set OPENAI_API_KEY=value. <!-- indy-model-key-scan: allow-reference -->', // indy-model-key-scan: allow-reference
          'OPENAI_API_KEY=leaked', // indy-model-key-scan: allow-reference
        ].join('\n'),
      },
    ])).toEqual([{ path: 'docs/runbook-vps.md', line: 2, name: 'OPENAI_API_KEY' }]); // indy-model-key-scan: allow-reference
  });

  it('detects assignments in tracked E2E, JSON, YAML, TypeScript, and env syntax', () => {
    expect(findForbiddenModelKeyAssignments([
      { path: 'e2e/fixture.ts', content: 'process.env.OPENAI_API_KEY = "e2e-secret";\n' }, // indy-model-key-scan: allow-reference
      { path: 'config/runtime.json', content: '{ "ANTHROPIC_API_KEY": "json-secret" }\n' }, // indy-model-key-scan: allow-reference
      { path: 'deploy/values.yml', content: 'OPENROUTER_API_KEY: yaml-secret\n' }, // indy-model-key-scan: allow-reference
      { path: 'server/bootstrap.ts', content: 'const env = { CODEX_API_KEY: `ts-secret` };\n' }, // indy-model-key-scan: allow-reference
      { path: '.env.production', content: 'export OPENAI_API_KEY=env-secret\n' }, // indy-model-key-scan: allow-reference
      { path: 'server/bracket.ts', content: 'process.env["ANTHROPIC_API_KEY"] = "bracket-secret";\n' }, // indy-model-key-scan: allow-reference
    ])).toEqual([
      { path: 'e2e/fixture.ts', line: 1, name: 'OPENAI_API_KEY' }, // indy-model-key-scan: allow-reference
      { path: 'config/runtime.json', line: 1, name: 'ANTHROPIC_API_KEY' }, // indy-model-key-scan: allow-reference
      { path: 'deploy/values.yml', line: 1, name: 'OPENROUTER_API_KEY' }, // indy-model-key-scan: allow-reference
      { path: 'server/bootstrap.ts', line: 1, name: 'CODEX_API_KEY' }, // indy-model-key-scan: allow-reference
      { path: '.env.production', line: 1, name: 'OPENAI_API_KEY' }, // indy-model-key-scan: allow-reference
      { path: 'server/bracket.ts', line: 1, name: 'ANTHROPIC_API_KEY' }, // indy-model-key-scan: allow-reference
    ]);
  });

  it('detects structured name/value and serialized container environment forms', () => {
    expect(findForbiddenModelKeyAssignments([
      {
        path: 'deploy/pod.yml',
        content: 'env:\n  - name: OPENAI_API_KEY\n    value: oauth-bypass\n', // indy-model-key-scan: allow-reference
      },
      {
        path: 'e2e/container.json',
        content: '{\n  "Env": ["ANTHROPIC_API_KEY=json-array-secret"]\n}\n', // indy-model-key-scan: allow-reference
      },
    ])).toEqual([
      { path: 'deploy/pod.yml', line: 2, name: 'OPENAI_API_KEY' }, // indy-model-key-scan: allow-reference
      { path: 'e2e/container.json', line: 2, name: 'ANTHROPIC_API_KEY' }, // indy-model-key-scan: allow-reference
    ]);
  });

  it('rejects host inheritance and augmented environment injection forms', () => {
    expect(findForbiddenModelKeyAssignments([
      { path: 'docker-compose.yml', content: 'environment:\n  - OPENAI_API_KEY\n' }, // indy-model-key-scan: allow-reference
      { path: 'deploy/compose-inline.yml', content: 'environment: [OPENAI_API_KEY]\n' }, // indy-model-key-scan: allow-reference
      { path: 'deploy/compose.yml', content: 'environment: [ "ANTHROPIC_API_KEY" ]\n' }, // indy-model-key-scan: allow-reference
      { path: 'scripts/deploy.ps1', content: "$env:OPENROUTER_API_KEY = 'inherited'\n" }, // indy-model-key-scan: allow-reference
      { path: 'server/env.ts', content: "process.env.CODEX_API_KEY ||= 'inherited';\n" }, // indy-model-key-scan: allow-reference
      { path: 'server/env-spacing.ts', content: "process . env [ 'CODEX_API_KEY' ] ||= 'inherited';\n" }, // indy-model-key-scan: allow-reference
      { path: 'scripts/start-unquoted.sh', content: 'export OPENAI_API_KEY\n' }, // indy-model-key-scan: allow-reference
      { path: 'scripts/start.sh', content: 'export  "OPENAI_API_KEY"\n' }, // indy-model-key-scan: allow-reference
    ])).toEqual([
      { path: 'docker-compose.yml', line: 2, name: 'OPENAI_API_KEY' }, // indy-model-key-scan: allow-reference
      { path: 'deploy/compose-inline.yml', line: 1, name: 'OPENAI_API_KEY' }, // indy-model-key-scan: allow-reference
      { path: 'deploy/compose.yml', line: 1, name: 'ANTHROPIC_API_KEY' }, // indy-model-key-scan: allow-reference
      { path: 'scripts/deploy.ps1', line: 1, name: 'OPENROUTER_API_KEY' }, // indy-model-key-scan: allow-reference
      { path: 'server/env.ts', line: 1, name: 'CODEX_API_KEY' }, // indy-model-key-scan: allow-reference
      { path: 'server/env-spacing.ts', line: 1, name: 'CODEX_API_KEY' }, // indy-model-key-scan: allow-reference
      { path: 'scripts/start-unquoted.sh', line: 1, name: 'OPENAI_API_KEY' }, // indy-model-key-scan: allow-reference
      { path: 'scripts/start.sh', line: 1, name: 'OPENAI_API_KEY' }, // indy-model-key-scan: allow-reference
    ]);
  });
});
