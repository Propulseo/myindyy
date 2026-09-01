import { describe, expect, it } from 'vitest';
import { timeAgo } from './format';

describe('timeAgo', () => {
  it.each([
    [30_000, 'à l’instant'],
    [2 * 60_000, 'il y a 2 min'],
    [3 * 60 * 60_000, 'il y a 3 h'],
    [4 * 24 * 60 * 60_000, 'il y a 4 j'],
  ] as const)('formate %s ms en français', (age, expected) => {
    const now = 10_000_000;
    expect(timeAgo(now - age, now)).toBe(expected);
  });
});
