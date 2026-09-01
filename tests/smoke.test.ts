import { describe, expect, it, vi } from 'vitest';
import { getAppVersion } from '../server/version.js';

describe('Indy baseline', () => {
  it('exposes the PropulSEO fork identity', () => {
    expect(getAppVersion().name).toBe('indy');
  });

  it('keeps the Indy identity when package metadata is unavailable', async () => {
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      readFileSync: () => {
        throw new Error('package metadata unavailable');
      },
    }));

    const { getAppVersion: getFallbackAppVersion } = await import('../server/version.js');

    expect(getFallbackAppVersion().name).toBe('indy');
    vi.doUnmock('node:fs');
  });
});
