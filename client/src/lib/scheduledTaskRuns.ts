import type { ScheduledTaskRun } from '@shared/types';

export function findCorrelatedScheduledTaskRun(
  runs: readonly ScheduledTaskRun[],
  dispatchToken: string,
): ScheduledTaskRun | null {
  return runs.find((run) => run.correlation === 'manifest' && run.dispatchToken === dispatchToken) ?? null;
}
