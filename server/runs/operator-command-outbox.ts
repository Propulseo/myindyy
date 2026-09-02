import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { AgentAdapter, AgentRunSettings } from '../adapters/types.js';
import { broadcast } from '../events.js';
import type { RunService, StartedMission } from './service.js';
import { createRunService } from './service.js';
import { createRunRepository } from './repository.js';
import type { OperatorCommand, RunRepository } from './types.js';
import {
  RUN_COMMAND_TYPES,
  type MissionRun,
  type RunCommandBody,
  type RunCommandResult,
  type Task,
} from '../../shared/types.js';

const TERMINAL_STATUSES = new Set<MissionRun['status']>(['completed', 'failed', 'cancelled']);

export interface StoredHttpResult {
  readonly httpStatus: number;
  readonly body: unknown;
}

export interface CommandExecutionContext {
  readonly task: Task;
  readonly current: MissionRun;
  readonly confirmed: MissionRun | undefined;
  readonly isActive: boolean;
}

export interface CommandCrashSeams {
  readonly afterInterruptBeforeReceipt?: () => void | Promise<void>;
  readonly afterInterrupt?: () => void | Promise<void>;
  readonly afterAttemptCreated?: () => void | Promise<void>;
  readonly afterLaunchBeforeReceipt?: () => void | Promise<void>;
  readonly afterLaunch?: () => void | Promise<void>;
  readonly afterStopMutation?: () => void | Promise<void>;
  readonly beforeCompleteCommand?: (type: RunCommandBody['type']) => void | Promise<void>;
}

export interface CommandOutboxDependencies {
  readonly database: Database;
  readonly adapter: Pick<AgentAdapter, 'interruptChat'>;
  readonly launchCommandRun: (
    task: Task,
    run: StartedMission,
    content: string,
    settings: AgentRunSettings,
  ) => void;
  readonly crashSeams?: CommandCrashSeams;
  readonly now?: () => number;
}

export interface InteractiveCommandRecoveryDependencies {
  readonly database: Database;
  readonly runService?: RunService;
  readonly leaseOwner?: () => string;
  readonly leaseMs?: number;
  readonly now?: () => number;
}

interface EffectReceipt {
  readonly effectRunId?: string;
  readonly interrupted?: boolean;
  readonly result?: StoredHttpResult;
}

export class InjectedCommandCrashError extends Error {
  constructor(readonly boundary: keyof CommandCrashSeams) {
    super(`Injected command crash at ${boundary}`);
    this.name = 'InjectedCommandCrashError';
  }
}

export function isStoredHttpResult(value: unknown): value is StoredHttpResult {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as { httpStatus?: unknown }).httpStatus === 'number'
    && Object.prototype.hasOwnProperty.call(value, 'body');
}

function effectReceipt(command: OperatorCommand): EffectReceipt | null {
  const raw = command.effectReceipt;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const receipt = raw as Record<string, unknown>;
  return {
    ...(typeof receipt.effectRunId === 'string' ? { effectRunId: receipt.effectRunId } : {}),
    ...(typeof receipt.interrupted === 'boolean' ? { interrupted: receipt.interrupted } : {}),
    ...(isStoredHttpResult(receipt.result) ? { result: receipt.result } : {}),
  };
}

function successorId(idempotencyKey: string): string {
  return `operator-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
}

function runtimeSettings(run: MissionRun): AgentRunSettings {
  return {
    provider: run.provider,
    model: run.model,
    reasoningEffort: run.reasoningEffort,
  };
}

function commandInstruction(command: RunCommandBody, task: Task): string {
  if (command.reason) return command.reason;
  if (command.type === 'resume') return 'Continue from the latest confirmed session.';
  if (command.type === 'retry') return task.description?.trim() || 'Retry the mission.';
  return command.type;
}

function acceptedResult(
  command: Pick<RunCommandBody, 'type'>,
  missionId: string,
  runId: string,
  previousRunId?: string,
): StoredHttpResult {
  const body: RunCommandResult = {
    type: command.type,
    missionId,
    runId,
    ...(previousRunId ? { previousRunId } : {}),
    status: 'accepted',
  };
  return { httpStatus: 202, body };
}

function unknownResult(command: OperatorCommand, receipt = effectReceipt(command)): StoredHttpResult {
  return {
    httpStatus: 409,
    body: {
      error: 'Command outcome requires operator reconciliation',
      code: 'COMMAND_OUTCOME_UNKNOWN',
      type: command.commandType,
      missionId: command.missionId,
      runId: receipt?.effectRunId ?? command.runId,
      status: 'unknown',
    },
  };
}

async function invokeSeam(
  seams: CommandCrashSeams | undefined,
  boundary: keyof CommandCrashSeams,
  commandType?: RunCommandBody['type'],
): Promise<void> {
  const seam = seams?.[boundary];
  if (!seam) return;
  if (boundary === 'beforeCompleteCommand') {
    await (seam as (type: RunCommandBody['type']) => void | Promise<void>)(commandType!);
  } else {
    await (seam as () => void | Promise<void>)();
  }
}

function persistProgress(
  repository: RunRepository,
  command: OperatorCommand,
  owner: string,
  phase: Parameters<RunRepository['updateCommandProgress']>[0]['phase'],
  receipt?: EffectReceipt,
): void {
  if (!repository.updateCommandProgress({
    idempotencyKey: command.idempotencyKey,
    owner,
    phase,
    ...(receipt ? { effectReceipt: receipt } : {}),
  })) {
    throw new Error('Operator command lease was lost');
  }
}

async function completeWithSeam(
  repository: RunRepository,
  command: OperatorCommand,
  owner: string,
  result: StoredHttpResult,
  seams?: CommandCrashSeams,
): Promise<StoredHttpResult> {
  await invokeSeam(seams, 'beforeCompleteCommand', command.commandType as RunCommandBody['type']);
  repository.completeCommand({ idempotencyKey: command.idempotencyKey, owner, result });
  return result;
}

export async function executeClaimedInteractiveCommand(
  dependencies: CommandOutboxDependencies,
  repository: RunRepository,
  runService: RunService,
  claimed: OperatorCommand,
  owner: string,
  command: RunCommandBody,
  context: CommandExecutionContext,
): Promise<StoredHttpResult> {
  const { database, adapter, crashSeams } = dependencies;
  const now = dependencies.now ?? Date.now;
  const setMissionStatus = database.prepare(`
    UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND mission_kind = 'interactive'
  `);
  const getMission = database.prepare("SELECT * FROM tasks WHERE id = ? AND mission_kind = 'interactive'");
  const { task, current, confirmed, isActive } = context;

  if (isActive && (command.type === 'interrupt' || command.type === 'stop' || command.type === 'correct')) {
    persistProgress(repository, claimed, owner, 'interrupting');
    const interrupted = await adapter.interruptChat(current.sessionId, command.reason);
    await invokeSeam(crashSeams, 'afterInterruptBeforeReceipt');
    if (command.type !== 'stop' && !interrupted) {
      return await completeWithSeam(repository, claimed, owner, {
        httpStatus: 409,
        body: { error: 'Hermes had no active run to interrupt' },
      }, crashSeams);
    }
    const interruptResult = command.type === 'interrupt'
      ? acceptedResult(command, claimed.missionId, current.id)
      : undefined;
    persistProgress(repository, claimed, owner, 'interrupted', {
      interrupted,
      ...(interruptResult ? { result: interruptResult } : {}),
    });
    await invokeSeam(crashSeams, 'afterInterrupt');
  }

  if (command.type === 'interrupt') {
    runService.cancel(current.id, 'operator-interrupt');
    return await completeWithSeam(
      repository,
      claimed,
      owner,
      acceptedResult(command, claimed.missionId, current.id),
      crashSeams,
    );
  }

  if (command.type === 'stop') {
    if (!TERMINAL_STATUSES.has(current.status)) runService.cancel(current.id, 'operator-stop');
    setMissionStatus.run('done', now(), claimed.missionId);
    const updated = getMission.get(claimed.missionId) as Task;
    broadcast({ type: 'task_updated', task: updated });
    const result = acceptedResult(command, claimed.missionId, current.id);
    persistProgress(repository, claimed, owner, 'stopped', { result });
    await invokeSeam(crashSeams, 'afterStopMutation');
    return await completeWithSeam(repository, claimed, owner, result, crashSeams);
  }

  if (!TERMINAL_STATUSES.has(current.status)) {
    runService.cancel(
      current.id,
      command.type === 'correct' ? 'operator-interrupt' : `operator-${command.type}`,
    );
  }

  const effectRunId = successorId(claimed.idempotencyKey);
  persistProgress(repository, claimed, owner, 'attempt_prepared', { effectRunId });
  const started = runService.startLinkedAttempt(current, {
    ...(command.type === 'retry' ? {} : { sessionRun: confirmed! }),
    runId: effectRunId,
  });
  persistProgress(repository, claimed, owner, 'attempt_created', { effectRunId });
  await invokeSeam(crashSeams, 'afterAttemptCreated');

  setMissionStatus.run('in_progress', now(), claimed.missionId);
  const updated = getMission.get(claimed.missionId) as Task;
  broadcast({ type: 'task_updated', task: updated });
  const startedRecord = repository.getRunRecord(started.runId)!;
  persistProgress(repository, claimed, owner, 'launching', { effectRunId });
  dependencies.launchCommandRun(
    updated,
    started,
    commandInstruction(command, task),
    runtimeSettings(startedRecord),
  );
  await invokeSeam(crashSeams, 'afterLaunchBeforeReceipt');
  const result = acceptedResult(command, claimed.missionId, started.runId, current.id);
  persistProgress(repository, claimed, owner, 'launched', { effectRunId, result });
  await invokeSeam(crashSeams, 'afterLaunch');
  return await completeWithSeam(repository, claimed, owner, result, crashSeams);
}

function markEffectRunUnknown(repository: RunRepository, command: OperatorCommand): void {
  const runId = effectReceipt(command)?.effectRunId;
  if (!runId) return;
  const run = repository.getRunRecord(runId);
  if (run && !TERMINAL_STATUSES.has(run.status)) repository.updateRunStatus(runId, 'unknown');
}

function markTargetRunUnknown(repository: RunRepository, command: OperatorCommand): void {
  if (!command.runId) return;
  const run = repository.getRunRecord(command.runId);
  if (run && !TERMINAL_STATUSES.has(run.status)) repository.updateRunStatus(run.id, 'unknown');
}

export function recoverLeasedInteractiveCommand(
  database: Database,
  repository: RunRepository,
  runService: RunService,
  command: OperatorCommand,
  owner: string,
  now: () => number,
): StoredHttpResult {
  const receipt = effectReceipt(command);
  if ((command.phase === 'launched' || command.phase === 'stopped') && receipt?.result) {
    repository.completeCommand({ idempotencyKey: command.idempotencyKey, owner, result: receipt.result });
    return receipt.result;
  }

  if (command.phase === 'interrupted' && command.commandType === 'interrupt' && receipt?.result) {
    const run = command.runId ? repository.getRunRecord(command.runId) : undefined;
    if (run && !TERMINAL_STATUSES.has(run.status)) runService.cancel(run.id, 'operator-interrupt');
    repository.completeCommand({ idempotencyKey: command.idempotencyKey, owner, result: receipt.result });
    return receipt.result;
  }

  if (command.phase === 'interrupted' && command.commandType === 'stop') {
    const run = command.runId ? repository.getRunRecord(command.runId) : undefined;
    if (run && !TERMINAL_STATUSES.has(run.status)) runService.cancel(run.id, 'operator-stop');
    database.prepare(`
      UPDATE tasks SET status = 'done', updated_at = ?
      WHERE id = ? AND mission_kind = 'interactive'
    `).run(now(), command.missionId);
    const result = acceptedResult(
      { type: 'stop' },
      command.missionId,
      command.runId ?? 'unknown',
    );
    repository.completeCommand({ idempotencyKey: command.idempotencyKey, owner, result });
    return result;
  }

  if (command.phase === 'interrupted' && command.commandType === 'correct' && receipt?.interrupted) {
    const run = command.runId ? repository.getRunRecord(command.runId) : undefined;
    if (run && !TERMINAL_STATUSES.has(run.status)) runService.cancel(run.id, 'operator-interrupt');
  } else if (command.phase === 'interrupting') {
    markTargetRunUnknown(repository, command);
  }

  markEffectRunUnknown(repository, command);
  const result = unknownResult(command, receipt);
  repository.markCommandNeedsReconciliation({
    idempotencyKey: command.idempotencyKey,
    owner,
    result,
  });
  return result;
}

export function recoverPendingInteractiveCommands(
  dependencies: InteractiveCommandRecoveryDependencies,
): number {
  const repository = createRunRepository(dependencies.database);
  const runService = dependencies.runService ?? createRunService(repository);
  const now = dependencies.now ?? Date.now;
  let recovered = 0;
  for (const commandType of RUN_COMMAND_TYPES) {
    const owner = dependencies.leaseOwner?.() ?? `interactive-recovery:${randomUUID()}`;
    const commands = repository.leasePendingCommands({
      owner,
      commandType,
      now: now(),
      leaseMs: dependencies.leaseMs ?? 30_000,
      limit: 100,
    });
    for (const command of commands) {
      recoverLeasedInteractiveCommand(
        dependencies.database,
        repository,
        runService,
        command,
        owner,
        now,
      );
      recovered += 1;
    }
  }
  return recovered;
}
