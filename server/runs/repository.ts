import type { Database, RunResult } from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type {
  AppendRunEventInput,
  ClaimCommandInput,
  CommandClaimResult,
  CompleteCommandInput,
  CronOccurrenceInput,
  CronOccurrenceUpsertResult,
  CreateRunInput,
  FinishRunRecordInput,
  LeasePendingCommandsInput,
  MissionRun,
  OperatorCommand,
  ReconcileCommandInput,
  RunEvent,
  RunRepository,
  RunRepositoryOptions,
  ReleaseCommandLeaseInput,
  ReconciledMissionRunStatus,
  UpdateCommandProgressInput,
} from './types.js';
import { redactSensitiveText, serializeRedacted } from '../security/redaction.js';

export type { RunRepository } from './types.js';

interface MissionRunRow {
  id: string;
  mission_id: string;
  session_id: string;
  session_confirmed_at: number | null;
  attempt: number;
  provider: string;
  model: string;
  reasoning_effort: MissionRun['reasoningEffort'];
  status: MissionRun['status'];
  started_at: number | null;
  last_activity_at: number;
  finished_at: number | null;
  finish_reason: string | null;
  previous_run_id: string | null;
}

interface RunEventRow {
  id: string;
  run_id: string;
  type: RunEvent['type'];
  occurred_at: number;
  payload_json: string;
}

interface OperatorCommandRow {
  idempotency_key: string;
  actor_id: string;
  mission_id: string;
  run_id: string | null;
  command_type: string;
  payload_hash: string;
  payload_json: string | null;
  status: string;
  phase: OperatorCommand['phase'];
  effect_receipt_json: string | null;
  result_json: string | null;
  created_at: number;
  completed_at: number | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  attempt_count: number;
  next_attempt_at: number;
}

function serializeRedactedEventPayload(payload: Readonly<Record<string, unknown>>): string {
  return serializeRedacted(payload);
}

function toRun(row: MissionRunRow): MissionRun {
  return {
    id: row.id,
    missionId: row.mission_id,
    sessionId: row.session_id,
    sessionConfirmedAt: row.session_confirmed_at,
    attempt: row.attempt,
    provider: row.provider,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    status: row.status,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    finishedAt: row.finished_at,
    finishReason: row.finish_reason,
    previousRunId: row.previous_run_id,
  };
}

function toEvent(row: RunEventRow): RunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    type: row.type,
    occurredAt: row.occurred_at,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  };
}

function parseStoredJson(value: string | null): unknown | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function toCommand(row: OperatorCommandRow): OperatorCommand {
  return {
    idempotencyKey: row.idempotency_key,
    actorId: row.actor_id,
    missionId: row.mission_id,
    runId: row.run_id,
    commandType: row.command_type,
    payloadHash: row.payload_hash,
    payload: parseStoredJson(row.payload_json),
    status: row.status,
    phase: row.phase ?? 'claimed',
    effectReceipt: parseStoredJson(row.effect_receipt_json),
    result: parseStoredJson(row.result_json),
    createdAt: row.created_at,
    completedAt: row.completed_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    attemptCount: row.attempt_count ?? 0,
    nextAttemptAt: row.next_attempt_at ?? 0,
  };
}

export function createRunRepository(
  database: Database,
  options: RunRepositoryOptions = {},
): RunRepository {
  const generateId = options.generateId ?? uuid;
  const now = options.now ?? Date.now;

  const insertRun = database.prepare(`
    INSERT INTO mission_runs (
      id, mission_id, session_id, attempt, provider, model, reasoning_effort,
      status, started_at, last_activity_at, finished_at, finish_reason, previous_run_id
    ) VALUES (
      @id, @mission_id, @session_id, @attempt, @provider, @model, @reasoning_effort,
      'queued', @started_at, @last_activity_at, NULL, NULL, @previous_run_id
    )
  `);
  const getRun = database.prepare('SELECT * FROM mission_runs WHERE id = ?');
  const getRunByOccurrence = database.prepare('SELECT * FROM mission_runs WHERE occurrence_key = ?');
  const updateSession = database.prepare(`
    UPDATE mission_runs
    SET session_id = @session_id, session_confirmed_at = @session_confirmed_at
    WHERE id = @run_id
  `);
  const finishRun = database.prepare(`
    UPDATE mission_runs
    SET status = @status,
        finished_at = @finished_at,
        finish_reason = @finish_reason
    WHERE id = @run_id
  `);
  const insertEvent = database.prepare(`
    INSERT OR IGNORE INTO run_events (id, run_id, type, occurred_at, payload_json)
    VALUES (@id, @run_id, @type, @occurred_at, @payload_json)
  `);
  const touchRun = database.prepare(`
    UPDATE mission_runs
    SET last_activity_at = MAX(last_activity_at, ?)
    WHERE id = ?
  `);
  const startRun = database.prepare(`
    UPDATE mission_runs
    SET status = 'running', started_at = COALESCE(started_at, ?)
    WHERE id = ?
  `);
  const setRunStatus = database.prepare(`
    UPDATE mission_runs SET status = ? WHERE id = ?
  `);
  const listEvents = database.prepare(`
    SELECT * FROM run_events
    WHERE run_id = ?
    ORDER BY occurred_at ASC, id ASC
  `);
  const listRunsForMission = database.prepare(`
    SELECT * FROM mission_runs
    WHERE mission_id = ?
    ORDER BY attempt ASC, id ASC
  `);
  const findInactiveBlockEvent = database.prepare(`
    SELECT 1 FROM run_events
    WHERE run_id = ?
      AND type = 'run.blocked'
      AND json_extract(payload_json, '$.reason') = 'inactive'
    LIMIT 1
  `);
  const listActiveRuns = database.prepare(`
    SELECT * FROM mission_runs
    WHERE status NOT IN ('completed', 'failed', 'cancelled')
    ORDER BY last_activity_at DESC, id ASC
  `);
  const listActiveRunsForMission = database.prepare(`
    SELECT * FROM mission_runs
    WHERE mission_id = ?
      AND status NOT IN ('completed', 'failed', 'cancelled')
    ORDER BY last_activity_at DESC, id ASC
  `);
  const insertCommand = database.prepare(`
    INSERT OR IGNORE INTO operator_commands (
      idempotency_key, actor_id, mission_id, run_id, command_type, payload_hash,
      payload_json, status, phase, effect_receipt_json, result_json, created_at, completed_at
    ) VALUES (
      @idempotency_key, @actor_id, @mission_id, @run_id, @command_type, @payload_hash,
      @payload_json, 'claimed', 'claimed', NULL, NULL, @created_at, NULL
    )
  `);
  const getCommand = database.prepare(
    'SELECT * FROM operator_commands WHERE idempotency_key = ?',
  );
  const getActiveInteractiveMissionCommand = database.prepare(`
    SELECT * FROM operator_commands
    WHERE mission_id = @mission_id
      AND status IN ('claimed', 'needs_reconciliation')
      AND command_type IN ('interrupt', 'correct', 'resume', 'retry', 'stop')
    ORDER BY created_at ASC, idempotency_key ASC
    LIMIT 1
  `);
  const getLatestMissionRunId = database.prepare(`
    SELECT id FROM mission_runs
    WHERE mission_id = ?
    ORDER BY attempt DESC, id DESC
    LIMIT 1
  `);
  const completeCommand = database.prepare(`
    UPDATE operator_commands
    SET status = 'completed', phase = 'completed', result_json = @result_json, completed_at = @completed_at,
        lease_owner = NULL, lease_expires_at = NULL
    WHERE idempotency_key = @idempotency_key AND status = 'claimed'
      AND (@owner IS NULL OR lease_owner = @owner)
  `);
  const updateCommandProgress = database.prepare(`
    UPDATE operator_commands
    SET phase = @phase,
        effect_receipt_json = COALESCE(@effect_receipt_json, effect_receipt_json)
    WHERE idempotency_key = @idempotency_key
      AND status = 'claimed'
      AND lease_owner = @owner
  `);
  const markCommandNeedsReconciliation = database.prepare(`
    UPDATE operator_commands
    SET status = 'needs_reconciliation', phase = 'needs_reconciliation',
        result_json = @result_json, completed_at = @completed_at,
        lease_owner = NULL, lease_expires_at = NULL
    WHERE idempotency_key = @idempotency_key
      AND status = 'claimed'
      AND lease_owner = @owner
  `);
  const listPendingCommands = database.prepare(`
    SELECT * FROM operator_commands
    WHERE status = 'claimed' AND (? IS NULL OR command_type = ?)
    ORDER BY created_at ASC, idempotency_key ASC
  `);
  const listLeaseCandidates = database.prepare(`
    SELECT idempotency_key FROM operator_commands
    WHERE status = 'claimed'
      AND next_attempt_at <= @now
      AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= @now)
      AND (@command_type IS NULL OR command_type = @command_type)
      AND (@idempotency_key IS NULL OR idempotency_key = @idempotency_key)
    ORDER BY created_at ASC, idempotency_key ASC
    LIMIT @limit
  `);
  const acquireCommandLease = database.prepare(`
    UPDATE operator_commands
    SET lease_owner = @owner,
        lease_expires_at = @lease_expires_at,
        attempt_count = attempt_count + 1
    WHERE idempotency_key = @idempotency_key
      AND status = 'claimed'
      AND next_attempt_at <= @now
      AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= @now)
  `);
  const releaseCommandLease = database.prepare(`
    UPDATE operator_commands
    SET lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = @next_attempt_at
    WHERE idempotency_key = @idempotency_key
      AND status = 'claimed'
      AND lease_owner = @owner
  `);
  const nudgeCommandRetry = database.prepare(`
    UPDATE operator_commands
    SET next_attempt_at = MIN(next_attempt_at, @at)
    WHERE idempotency_key = @idempotency_key
      AND status = 'claimed'
      AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= @at)
  `);
  const nextMissionAttempt = database.prepare(`
    SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt
    FROM mission_runs
    WHERE mission_id = ?
  `);
  const insertCronOccurrence = database.prepare(`
    INSERT OR IGNORE INTO mission_runs (
      id, mission_id, session_id, session_confirmed_at, attempt, provider, model,
      reasoning_effort, status, started_at, last_activity_at, finished_at,
      finish_reason, previous_run_id, occurrence_key, workdir, provenance_json
    ) VALUES (
      @id, @mission_id, @session_id, @session_confirmed_at, @attempt, @provider, @model,
      @reasoning_effort, @status, @started_at, @last_activity_at, @finished_at,
      @finish_reason, NULL, @occurrence_key, @workdir, @provenance_json
    )
  `);

  const upsertCronOccurrenceTransaction = database.transaction((input: CronOccurrenceInput): CronOccurrenceUpsertResult => {
    const existing = getRunByOccurrence.get(input.occurrenceKey) as MissionRunRow | undefined;
    if (existing) return { created: false, run: toRun(existing) };

    const attempt = (nextMissionAttempt.get(input.missionId) as { attempt: number }).attempt;
    const result = insertCronOccurrence.run({
      id: input.occurrenceKey,
      mission_id: input.missionId,
      session_id: input.sessionId,
      session_confirmed_at: input.startedAt,
      attempt,
      provider: redactSensitiveText(input.provider),
      model: redactSensitiveText(input.model),
      reasoning_effort: input.reasoningEffort,
      status: input.status,
      started_at: input.startedAt,
      last_activity_at: input.finishedAt,
      finished_at: input.finishedAt,
      finish_reason: redactSensitiveText(input.finishReason),
      occurrence_key: input.occurrenceKey,
      workdir: input.workdir ? redactSensitiveText(input.workdir) : null,
      provenance_json: serializeRedactedEventPayload(input.provenance),
    });
    if (result.changes === 0) {
      const replay = getRunByOccurrence.get(input.occurrenceKey) as MissionRunRow | undefined;
      if (!replay) throw new Error(`Cron occurrence conflict: ${input.occurrenceKey}`);
      return { created: false, run: toRun(replay) };
    }

    const startedPayload = serializeRedactedEventPayload({
      source: 'hermes-cron-output',
      provenance: input.provenance,
    });
    insertEvent.run({
      id: `${input.occurrenceKey}:started`,
      run_id: input.occurrenceKey,
      type: 'run.started',
      occurred_at: input.startedAt,
      payload_json: startedPayload,
    });
    insertEvent.run({
      id: `${input.occurrenceKey}:terminal`,
      run_id: input.occurrenceKey,
      type: input.status === 'completed' ? 'run.completed' : 'run.failed',
      occurred_at: input.finishedAt,
      payload_json: serializeRedactedEventPayload({
        source: 'hermes-cron-output',
        reason: input.finishReason,
        error: input.error,
        provenance: input.provenance,
      }),
    });
    return {
      created: true,
      run: toRun(getRunByOccurrence.get(input.occurrenceKey) as MissionRunRow),
    };
  });

  const appendEventTransaction = database.transaction((input: AppendRunEventInput): boolean => {
    const result = insertEvent.run({
      id: input.id,
      run_id: input.runId,
      type: input.type,
      occurred_at: input.occurredAt,
      payload_json: serializeRedactedEventPayload(input.payload),
    });
    if (result.changes === 0) return false;
    touchRun.run(input.occurredAt, input.runId);
    if (input.type === 'run.started') {
      startRun.run(input.occurredAt, input.runId);
    } else if (input.type === 'run.waiting_approval') {
      setRunStatus.run('waiting_approval', input.runId);
    } else if (input.type === 'run.blocked') {
      setRunStatus.run('blocked', input.runId);
    }
    return true;
  });

  const claimCommandTransaction = database.transaction((input: ClaimCommandInput): CommandClaimResult => {
    const createdAt = input.createdAt ?? now();
    const existing = getCommand.get(input.idempotencyKey) as OperatorCommandRow | undefined;
    if (existing) {
      return {
        status: existing.payload_hash === input.payloadHash ? 'duplicate' : 'conflict',
        command: toCommand(existing),
      };
    }
    if (['interrupt', 'correct', 'resume', 'retry', 'stop'].includes(input.commandType)) {
      const active = getActiveInteractiveMissionCommand.get({
        mission_id: input.missionId,
      }) as OperatorCommandRow | undefined;
      if (active) return { status: 'busy', command: toCommand(active) };
    }
    if (input.expectedCurrentRunId !== undefined) {
      const latest = getLatestMissionRunId.get(input.missionId) as { id: string } | undefined;
      if (latest?.id !== input.expectedCurrentRunId) {
        return { status: 'stale', command: null };
      }
    }
    const result: RunResult = insertCommand.run({
      idempotency_key: input.idempotencyKey,
      actor_id: input.actorId,
      mission_id: input.missionId,
      run_id: input.runId ?? null,
      command_type: input.commandType,
      payload_hash: input.payloadHash,
      payload_json: input.payload === undefined ? null : serializeRedacted(input.payload),
      created_at: createdAt,
    });
    const row = getCommand.get(input.idempotencyKey) as OperatorCommandRow;
    return {
      status: result.changes > 0 ? 'claimed' : 'busy',
      command: toCommand(row),
    };
  });

  const leasePendingCommandsTransaction = database.transaction((input: LeasePendingCommandsInput): OperatorCommand[] => {
    const at = input.now ?? now();
    const leaseMs = Math.max(1, input.leaseMs ?? 30_000);
    const limit = Math.max(1, Math.min(input.limit ?? 8, 100));
    const candidates = listLeaseCandidates.all({
      now: at,
      command_type: input.commandType ?? null,
      idempotency_key: input.idempotencyKey ?? null,
      limit,
    }) as Array<{ idempotency_key: string }>;
    const leased: OperatorCommand[] = [];
    for (const candidate of candidates) {
      const result = acquireCommandLease.run({
        idempotency_key: candidate.idempotency_key,
        owner: input.owner,
        now: at,
        lease_expires_at: at + leaseMs,
      });
      if (result.changes === 0) continue;
      leased.push(toCommand(getCommand.get(candidate.idempotency_key) as OperatorCommandRow));
    }
    return leased;
  });

  function getRunRecord(runId: string): MissionRun | undefined {
    const row = getRun.get(runId) as MissionRunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  return {
    createRun(input: CreateRunInput): MissionRun {
      const createdAt = input.createdAt ?? now();
      const id = input.id ?? generateId();
      insertRun.run({
        id,
        mission_id: input.missionId,
        session_id: input.sessionId,
        attempt: input.attempt,
        provider: input.provider,
        model: input.model,
        reasoning_effort: input.reasoningEffort ?? null,
        started_at: input.startedAt ?? null,
        last_activity_at: createdAt,
        previous_run_id: input.previousRunId ?? null,
      });
      return getRunRecord(id)!;
    },

    appendRunEvent(input: AppendRunEventInput): boolean {
      return appendEventTransaction(input);
    },

    finishRunRecord(input: FinishRunRecordInput): MissionRun {
      const result = finishRun.run({
        run_id: input.runId,
        status: input.status,
        finished_at: input.finishedAt ?? now(),
        finish_reason: input.finishReason ? redactSensitiveText(input.finishReason) : null,
      });
      if (result.changes === 0) throw new Error(`Unknown mission run: ${input.runId}`);
      return getRunRecord(input.runId)!;
    },

    updateRunStatus(runId: string, status: ReconciledMissionRunStatus): MissionRun {
      const result = setRunStatus.run(status, runId);
      if (result.changes === 0) throw new Error(`Unknown mission run: ${runId}`);
      return getRunRecord(runId)!;
    },

    updateRunSession(runId: string, sessionId: string, confirmedAt = now()): MissionRun {
      const result = updateSession.run({
        run_id: runId,
        session_id: sessionId,
        session_confirmed_at: confirmedAt,
      });
      if (result.changes === 0) throw new Error(`Unknown mission run: ${runId}`);
      return getRunRecord(runId)!;
    },

    getRunRecord,

    listMissionRuns(missionId: string): MissionRun[] {
      return (listRunsForMission.all(missionId) as MissionRunRow[]).map(toRun);
    },

    listRunEvents(runId: string): RunEvent[] {
      return (listEvents.all(runId) as RunEventRow[]).map(toEvent);
    },

    hasInactiveBlockEvent(runId: string): boolean {
      return findInactiveBlockEvent.get(runId) !== undefined;
    },

    findActiveRuns(missionId?: string): MissionRun[] {
      const rows = missionId === undefined
        ? listActiveRuns.all()
        : listActiveRunsForMission.all(missionId);
      return (rows as MissionRunRow[]).map(toRun);
    },

    getMissionCommandFence(missionId: string): OperatorCommand | undefined {
      const row = getActiveInteractiveMissionCommand.get({
        mission_id: missionId,
      }) as OperatorCommandRow | undefined;
      return row ? toCommand(row) : undefined;
    },

    claimCommand(input: ClaimCommandInput): CommandClaimResult {
      return claimCommandTransaction(input);
    },

    getCommand(idempotencyKey: string): OperatorCommand | undefined {
      const row = getCommand.get(idempotencyKey) as OperatorCommandRow | undefined;
      return row ? toCommand(row) : undefined;
    },

    completeCommand(input: CompleteCommandInput): OperatorCommand {
      const result = completeCommand.run({
        idempotency_key: input.idempotencyKey,
        owner: input.owner ?? null,
        result_json: serializeRedacted(input.result),
        completed_at: input.completedAt ?? now(),
      });
      if (result.changes === 0) {
        throw new Error(`Operator command is not claimable: ${input.idempotencyKey}`);
      }
      return toCommand(getCommand.get(input.idempotencyKey) as OperatorCommandRow);
    },

    updateCommandProgress(input: UpdateCommandProgressInput): boolean {
      return updateCommandProgress.run({
        idempotency_key: input.idempotencyKey,
        owner: input.owner,
        phase: input.phase,
        effect_receipt_json: input.effectReceipt === undefined
          ? null
          : serializeRedacted(input.effectReceipt),
      }).changes > 0;
    },

    markCommandNeedsReconciliation(input: ReconcileCommandInput): OperatorCommand {
      const result = markCommandNeedsReconciliation.run({
        idempotency_key: input.idempotencyKey,
        owner: input.owner,
        result_json: serializeRedacted(input.result),
        completed_at: input.completedAt ?? now(),
      });
      if (result.changes === 0) {
        throw new Error(`Operator command is not claimable: ${input.idempotencyKey}`);
      }
      return toCommand(getCommand.get(input.idempotencyKey) as OperatorCommandRow);
    },

    listPendingCommands(commandType?: string): OperatorCommand[] {
      return (listPendingCommands.all(commandType ?? null, commandType ?? null) as OperatorCommandRow[]).map(toCommand);
    },

    leasePendingCommands(input: LeasePendingCommandsInput): OperatorCommand[] {
      return leasePendingCommandsTransaction(input);
    },

    releaseCommandLease(input: ReleaseCommandLeaseInput): boolean {
      return releaseCommandLease.run({
        idempotency_key: input.idempotencyKey,
        owner: input.owner,
        next_attempt_at: input.nextAttemptAt,
      }).changes > 0;
    },

    nudgeCommandRetry(idempotencyKey: string, at = now()): boolean {
      return nudgeCommandRetry.run({ idempotency_key: idempotencyKey, at }).changes > 0;
    },

    upsertCronOccurrence(input: CronOccurrenceInput): CronOccurrenceUpsertResult {
      return upsertCronOccurrenceTransaction(input);
    },
  };
}
