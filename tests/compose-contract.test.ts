import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('production Compose contract', () => {
  it('mounts the private Hermes runtime scratch as an executable tmpfs', () => {
    const compose = readFileSync(join(process.cwd(), 'docker-compose.example.yml'), 'utf8');
    const runtimeMount = compose
      .split(/\r?\n/u)
      .find((line) => line.includes('/run/indy-runtime:'));

    expect(runtimeMount).toBeDefined();
    expect(runtimeMount?.split(':', 2)[1]?.split(',')).toContain('exec');
  });
});
