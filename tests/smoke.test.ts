import { describe, expect, it } from 'vitest';
import { getAppVersion } from '../server/version.js';

describe('Indy baseline', () => {
  it('exposes the PropulSEO fork identity', () => {
    expect(getAppVersion().name).toBe('indy');
  });
});
