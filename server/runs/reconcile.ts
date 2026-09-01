import { v4 as uuid } from 'uuid';
import type { MissionRun } from '../../shared/types.js';
import type { RunRepository } from './types.js';

export type RuntimeSessionState = 'active' | 'completed' | 'missing' | 'unknown';

export interface RuntimeSessionInspection {
  readonly state: RuntimeSessionState;
  readonly processActive?: boolean | null;
}

export interface RuntimeSessionInspector {
  inspectSession(sessionId: string): Promise<RuntimeSessionInspection>;
}

export type RunEventIdGenerator = () => string;

function appendReconciliationEvent(
  repository: RunRepository,
  run: MissionRun,
  type: 'run.heartbeat' | 'run.completed' | 'run.failed',
  occurredAt: number,
  payload: Readonly<Record<string, unknown>>,
  generateId: RunEventIdGenerator,
): void {
  repository.appendRunEvent({
    id: generateId(),
    runId: run.id,
    type,
    occurredAt,
    payload,
  });
}

export function markInspectionUnknown(repository: RunRepository, run: MissionRun): void {
  repository.updateRunStatus(run.id, 'unknown');
}

export function applySessionInspection(
  repository: RunRepository,
  run: MissionRun,
  inspection: RuntimeSessionInspection,
  now: number,
  generateId: RunEventIdGenerator = uuid,
): void {
  if (inspection.state === 'active') {
    appendReconciliationEvent(
      repository,
      run,
      'run.heartbeat',
      now,
      { reason: 'reconciled-active' },
      generateId,
    );
    repository.updateRunStatus(run.id, 'running');
    return;
  }

  if (inspection.state === 'completed') {
    appendReconciliationEvent(
      repository,
      run,
      'run.completed',
      now,
      { reason: 'reconciled-completed' },
      generateId,
    );
    repository.finishRunRecord({
      runId: run.id,
      status: 'completed',
      finishedAt: now,
      finishReason: 'completed',
    });
    return;
  }

  if (inspection.state === 'missing' && inspection.processActive === false) {
    appendReconciliationEvent(
      repository,
      run,
      'run.failed',
      now,
      { reason: 'process-lost' },
      generateId,
    );
    repository.finishRunRecord({
      runId: run.id,
      status: 'failed',
      finishedAt: now,
      finishReason: 'process-lost',
    });
    return;
  }

  markInspectionUnknown(repository, run);
}

export async function inspectRun(
  inspector: RuntimeSessionInspector,
  run: MissionRun,
): Promise<RuntimeSessionInspection> {
  try {
    return await inspector.inspectSession(run.sessionId);
  } catch {
    return { state: 'unknown', processActive: null };
  }
}

export async function reconcileActiveRuns(
  repository: RunRepository,
  inspector: RuntimeSessionInspector,
  now = Date.now(),
  generateId: RunEventIdGenerator = uuid,
): Promise<void> {
  for (const run of repository.findActiveRuns()) {
    const inspection = await inspectRun(inspector, run);
    applySessionInspection(repository, run, inspection, now, generateId);
  }
}
