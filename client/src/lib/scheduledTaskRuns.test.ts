import { describe, expect, it } from 'vitest';
import type { ScheduledTaskRun } from '@shared/types';
import { findCorrelatedScheduledTaskRun } from './scheduledTaskRuns';

const run = (id: string, dispatchToken: string | null, correlation: ScheduledTaskRun['correlation']): ScheduledTaskRun => ({
  id, scheduledTaskId: 'cron-1', ranAt: '2026-09-02T08:00:00Z', path: id,
  status: 'ok', preview: '', dispatchToken, correlation,
});

describe('manual Hermes occurrence correlation', () => {
  it('never mistakes the first unrelated or legacy run for the requested occurrence', () => {
    const runs = [run('automatic-newer', null, 'manifest'), run('legacy', 'wanted', 'untracked'), run('manual', 'wanted', 'manifest')];
    expect(findCorrelatedScheduledTaskRun(runs, 'wanted')?.id).toBe('manual');
    expect(findCorrelatedScheduledTaskRun(runs, 'missing')).toBeNull();
  });
});
