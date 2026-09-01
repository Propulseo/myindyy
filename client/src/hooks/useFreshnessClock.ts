import { useEffect, useState } from 'react';

export type ActivityFreshness = 'fresh' | 'warm' | 'stale';

const FIFTEEN_MINUTES_MS = 15 * 60_000;
const FORTY_FIVE_MINUTES_MS = 45 * 60_000;

export function activityFreshness(lastActivityAt: number | null, now = Date.now()): ActivityFreshness {
  if (lastActivityAt === null) return 'stale';
  const age = Math.max(0, now - lastActivityAt);
  if (age < FIFTEEN_MINUTES_MS) return 'fresh';
  if (age < FORTY_FIVE_MINUTES_MS) return 'warm';
  return 'stale';
}

export function nextFreshnessBoundaryDelay(lastActivityAt: Array<number | null>, now = Date.now()): number | null {
  let nearest: number | null = null;
  for (const timestamp of lastActivityAt) {
    if (timestamp === null) continue;
    const age = Math.max(0, now - timestamp);
    const delay = age < FIFTEEN_MINUTES_MS
      ? FIFTEEN_MINUTES_MS - age
      : age < FORTY_FIVE_MINUTES_MS
        ? FORTY_FIVE_MINUTES_MS - age
        : null;
    if (delay !== null && (nearest === null || delay < nearest)) nearest = delay;
  }
  return nearest;
}

export function useFreshnessClock(lastActivityAt: Array<number | null>): number {
  const [now, setNow] = useState(Date.now);
  const activityKey = lastActivityAt.join(':');

  useEffect(() => {
    const delay = nextFreshnessBoundaryDelay(lastActivityAt, Date.now());
    if (delay === null) return;
    const timeout = setTimeout(() => setNow(Date.now()), Math.max(1, delay));
    return () => clearTimeout(timeout);
  }, [activityKey, now]);

  return now;
}
