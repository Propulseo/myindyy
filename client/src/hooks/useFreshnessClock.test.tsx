// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activityFreshness, useFreshnessClock } from './useFreshnessClock';

const HOUR_MS = 60 * 60_000;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useFreshnessClock', () => {
  it.each([
    [20 * 60_000, 'warm', 1],
    [45 * 60_000, 'stale', 0],
  ] as const)('reclasse immédiatement une nouvelle activité âgée de %s ms', (age, expected, timers) => {
    vi.useFakeTimers();
    const mountedAt = 10_000_000;
    vi.setSystemTime(mountedAt);
    const { result, rerender } = renderHook(
      ({ timestamps }) => useFreshnessClock(timestamps),
      { initialProps: { timestamps: [] as Array<number | null> } },
    );

    act(() => vi.setSystemTime(mountedAt + HOUR_MS));
    const lastActivityAt = Date.now() - age;
    rerender({ timestamps: [lastActivityAt] });

    expect(activityFreshness(lastActivityAt, result.current)).toBe(expected);
    expect(vi.getTimerCount()).toBe(timers);
  });
});
