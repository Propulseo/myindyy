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
});
