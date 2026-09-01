import { v4 as uuid } from 'uuid';
import type { StreamEvent } from '../adapters/types.js';
import type { MissionRun, ReasoningEffort, RunEvent } from '../../shared/types.js';
import { normalizeHermesEvent, type NormalizedRunEvent } from './event-normalizer.js';
import type { RunRepository, TerminalMissionRunStatus } from './types.js';

export interface StartMissionInput {
  readonly missionId: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: ReasoningEffort | null;
}

export interface StartedMission {
  readonly runId: string;
  readonly sessionId: string;
}

export interface MissionRunHistory {
  readonly runs: MissionRun[];
  readonly events: RunEvent[];
}

export interface RunService {
  startMission(input: StartMissionInput): StartedMission;
  consumeEvent(runId: string, event: StreamEvent, options?: ConsumeEventOptions): RunEvent;
  complete(runId: string, event?: StreamEvent & { type: 'done' }): RunEvent;
  fail(runId: string, error: unknown): RunEvent;
  getMissionHistory(missionId: string): MissionRunHistory;
  getLatestRun(missionId: string): MissionRun | undefined;
  getLatestConfirmedSessionId(missionId: string): string | undefined;
}

export interface ConsumeEventOptions {
  readonly terminal?: boolean;
}

export interface RunServiceOptions {
  readonly generateId?: () => string;
  readonly now?: () => number;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Hermes run failed';
}

export function createRunService(
  repository: RunRepository,
  options: RunServiceOptions = {},
): RunService {
  const generateId = options.generateId ?? uuid;
  const now = options.now ?? Date.now;
  let lastOccurredAt = Number.MIN_SAFE_INTEGER;

  function nextOccurredAt(): number {
    lastOccurredAt = Math.max(now(), lastOccurredAt + 1);
    return lastOccurredAt;
  }

  function requireRun(runId: string): MissionRun {
    const run = repository.getRunRecord(runId);
    if (!run) throw new Error(`Unknown mission run: ${runId}`);
    return run;
  }

  function persistNormalized(run: MissionRun, normalized: NormalizedRunEvent): RunEvent {
    const record: RunEvent = {
      id: generateId(),
      runId: run.id,
      type: normalized.type,
      occurredAt: nextOccurredAt(),
      payload: normalized.payload,
    };
    repository.appendRunEvent(record);
    return record;
  }

  function persist(run: MissionRun, event: StreamEvent): RunEvent {
    return persistNormalized(run, normalizeHermesEvent(run, event));
  }

  function finish(runId: string, status: TerminalMissionRunStatus, reason: string): void {
    const run = requireRun(runId);
    repository.finishRunRecord({
      runId,
      status,
      finishedAt: Math.max(now(), run.lastActivityAt),
      finishReason: reason,
    });
  }

  function consumeEvent(
    runId: string,
    event: StreamEvent,
    consumeOptions: ConsumeEventOptions = {},
  ): RunEvent {
    const run = requireRun(runId);
    const persisted = event.type === 'done' && consumeOptions.terminal === false
      ? persistNormalized(run, {
          type: 'run.heartbeat',
          payload: Object.fromEntries(Object.entries({
            transportDone: true,
            sessionId: event.sessionId,
            context: event.context,
            interrupted: event.interrupted,
          }).filter(([, value]) => value !== undefined)),
        })
      : persist(run, event);
    if (event.type === 'done' && event.sessionId) {
      repository.updateRunSession(
        runId,
        event.sessionId,
        persisted.occurredAt,
      );
    }
    return persisted;
  }

  function latestEvent(runId: string): RunEvent | undefined {
    return repository.listRunEvents(runId).at(-1);
  }

  return {
    startMission(input): StartedMission {
      const previousRuns = repository.listMissionRuns(input.missionId);
      const previous = previousRuns.at(-1);
      const runId = generateId();
      const sessionId = `indy:${input.missionId}:${runId}`;
      repository.createRun({
        id: runId,
        missionId: input.missionId,
        sessionId,
        attempt: (previous?.attempt ?? 0) + 1,
        provider: input.provider,
        model: input.model,
        reasoningEffort: input.reasoningEffort ?? null,
        previousRunId: previous?.id ?? null,
        createdAt: now(),
      });
      const run = requireRun(runId);
      persistNormalized(run, { type: 'run.queued', payload: {} });
      persistNormalized(requireRun(runId), { type: 'run.started', payload: {} });
      return { runId, sessionId };
    },

    consumeEvent,

    complete(runId, event): RunEvent {
      let terminalEvent = event ? consumeEvent(runId, event) : latestEvent(runId);
      if (terminalEvent?.type !== 'run.completed' && terminalEvent?.type !== 'run.cancelled') {
        terminalEvent = consumeEvent(runId, { type: 'done' });
      }
      const cancelled = terminalEvent.type === 'run.cancelled';
      finish(runId, cancelled ? 'cancelled' : 'completed', cancelled ? 'interrupted' : 'completed');
      return terminalEvent;
    },

    fail(runId, error): RunEvent {
      const message = errorMessage(error);
      const previous = latestEvent(runId);
      const terminalEvent = previous?.type === 'run.failed'
        ? previous
        : consumeEvent(runId, { type: 'error', error: message });
      finish(runId, 'failed', message);
      return terminalEvent;
    },

    getMissionHistory(missionId): MissionRunHistory {
      const runs = repository.listMissionRuns(missionId);
      return { runs, events: runs.flatMap((run) => repository.listRunEvents(run.id)) };
    },

    getLatestRun(missionId): MissionRun | undefined {
      return repository.listMissionRuns(missionId).at(-1);
    },

    getLatestConfirmedSessionId(missionId): string | undefined {
      const confirmedRuns = repository.listMissionRuns(missionId)
        .filter((run) => run.sessionConfirmedAt !== null);
      return confirmedRuns.at(-1)?.sessionId;
    },
  };
}
