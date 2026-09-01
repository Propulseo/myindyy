import { v4 as uuid } from 'uuid';
import type { RunRepository } from './types.js';
import {
  applySessionInspection,
  inspectRun,
  type RunEventIdGenerator,
  type RuntimeSessionInspector,
} from './reconcile.js';

export const INACTIVE_AFTER_MS = 2_700_000;
export const WATCHDOG_INTERVAL_MS = 60_000;

export function classifyInactiveRuns(lastActivityAt: number, now: number): boolean {
  return now - lastActivityAt >= INACTIVE_AFTER_MS;
}

function isAlreadyBlockedInactive(repository: RunRepository, runId: string): boolean {
  const run = repository.getRunRecord(runId);
  if (run?.status !== 'blocked') return false;
  return repository.listRunEvents(runId).some((event) =>
    event.type === 'run.blocked' && event.payload.reason === 'inactive');
}

export async function runWatchdogOnce(
  repository: RunRepository,
  inspector: RuntimeSessionInspector,
  now = Date.now(),
  generateId: RunEventIdGenerator = uuid,
): Promise<void> {
  for (const run of repository.findActiveRuns()) {
    if (!classifyInactiveRuns(run.lastActivityAt, now)) continue;
    if (isAlreadyBlockedInactive(repository, run.id)) continue;

    const inspection = await inspectRun(inspector, run);
    if (inspection.state === 'active' || inspection.state === 'completed') {
      applySessionInspection(repository, run, inspection, now, generateId);
      continue;
    }
    if (inspection.state === 'missing' && inspection.processActive === false) {
      applySessionInspection(repository, run, inspection, now, generateId);
      continue;
    }

    const current = repository.getRunRecord(run.id);
    if (!current || !classifyInactiveRuns(current.lastActivityAt, now)) continue;
    if (isAlreadyBlockedInactive(repository, current.id)) continue;

    repository.appendRunEvent({
      id: generateId(),
      runId: run.id,
      type: 'run.blocked',
      occurredAt: now,
      payload: { reason: 'inactive' },
    });
  }
}

export interface StartRunWatchdogOptions {
  readonly now?: () => number;
  readonly generateId?: RunEventIdGenerator;
  readonly schedule?: typeof setInterval;
  readonly onError?: (error: unknown) => void;
}

export function startRunWatchdog(
  repository: RunRepository,
  inspector: RuntimeSessionInspector,
  options: StartRunWatchdogOptions = {},
): ReturnType<typeof setInterval> {
  const now = options.now ?? Date.now;
  const generateId = options.generateId ?? uuid;
  const onError = options.onError ?? ((error: unknown) => console.error('Run watchdog failed:', error));
  const schedule = options.schedule ?? setInterval;
  let running = false;
  const timer = schedule(() => {
    if (running) return;
    running = true;
    void runWatchdogOnce(repository, inspector, now(), generateId)
      .catch(onError)
      .finally(() => {
        running = false;
      });
  }, WATCHDOG_INTERVAL_MS);
  timer.unref();
  return timer;
}
