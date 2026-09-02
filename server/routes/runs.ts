import { createHash, randomUUID } from 'node:crypto';
import { Router, type Router as ExpressRouter } from 'express';
import type { Database } from 'better-sqlite3';
import type { AgentAdapter, AgentRunSettings } from '../adapters/types.js';
import { isRecord, toErrorMessage } from '../errors.js';
import {
  requireInteractiveAdmission,
  sendInteractiveAdmissionError,
  type InteractiveRuntimeSource,
} from '../runtime/interactive-admission.js';
import { createRunRepository } from '../runs/repository.js';
import { createRunService, type RunService, type StartedMission } from '../runs/service.js';
import {
  executeClaimedInteractiveCommand,
  InjectedCommandCrashError,
  isStoredHttpResult,
  recoverLeasedInteractiveCommand,
  type CommandCrashSeams,
  type CommandExecutionContext,
  type StoredHttpResult,
} from '../runs/operator-command-outbox.js';
import {
  RUN_COMMAND_TYPES,
  type MissionRun,
  type RunCommandBody,
  type Task,
} from '../../shared/types.js';

type CommandAdapter = Pick<AgentAdapter, 'interruptChat' | 'getSessionMetadata'> & InteractiveRuntimeSource;

export type LaunchCommandRun = (
  task: Task,
  run: StartedMission,
  content: string,
  settings: AgentRunSettings,
) => void;

export interface RunsRouterDependencies {
  readonly database: Database;
  readonly adapter: CommandAdapter;
  readonly launchCommandRun: LaunchCommandRun;
  readonly runService?: RunService;
  readonly crashSeams?: CommandCrashSeams;
  readonly leaseOwner?: () => string;
  readonly leaseMs?: number;
  readonly now?: () => number;
}

const ACTIVE_STATUSES = new Set<MissionRun['status']>([
  'queued', 'running', 'waiting_approval', 'unknown',
]);
const COMMAND_FIELDS = new Set(['type', 'runId', 'reason']);

function canonicalHash(missionId: string, command: RunCommandBody): string {
  const canonical = JSON.stringify({
    missionId,
    reason: command.reason ?? null,
    runId: command.runId,
    type: command.type,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function parseCommand(body: unknown): RunCommandBody {
  if (!isRecord(body)) throw new Error('Command body must be an object');
  if (Object.prototype.hasOwnProperty.call(body, 'actorId')) {
    throw new Error('actorId is resolved by the server');
  }
  const unknownField = Object.keys(body).find((key) => !COMMAND_FIELDS.has(key));
  if (unknownField) throw new Error(`Unknown command field: ${unknownField}`);
  if (typeof body.type !== 'string' || !RUN_COMMAND_TYPES.includes(body.type as RunCommandBody['type'])) {
    throw new Error(`type must be one of: ${RUN_COMMAND_TYPES.join(', ')}`);
  }
  if (typeof body.runId !== 'string' || !body.runId.trim()) {
    throw new Error('runId is required');
  }
  if (body.reason !== undefined && typeof body.reason !== 'string') {
    throw new Error('reason must be a string');
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : undefined;
  if (body.type === 'correct' && !reason) throw new Error('reason is required for correct');
  return {
    type: body.type as RunCommandBody['type'],
    runId: body.runId.trim(),
    ...(reason ? { reason } : {}),
  };
}

function runtimeSettings(run: MissionRun): AgentRunSettings {
  return {
    provider: run.provider,
    model: run.model,
    reasoningEffort: run.reasoningEffort,
  };
}

function loadCommandContext(
  database: Database,
  runService: RunService,
  missionId: string,
  command: RunCommandBody,
): CommandExecutionContext | StoredHttpResult {
  const task = database.prepare(
    "SELECT * FROM tasks WHERE id = ? AND mission_kind = 'interactive'",
  ).get(missionId) as Task | undefined;
  if (!task) return { httpStatus: 404, body: { error: 'Mission not found' } };

  const current = runService.getLatestRun(missionId);
  if (!current || current.id !== command.runId || current.missionId !== missionId) {
    return { httpStatus: 409, body: { error: 'runId must be the current attempt for this mission' } };
  }
  const isActive = ACTIVE_STATUSES.has(current.status);
  if (command.type === 'interrupt' && !isActive) {
    return { httpStatus: 409, body: { error: 'The current attempt is not interruptible' } };
  }
  if ((command.type === 'resume' || command.type === 'retry') && isActive) {
    return { httpStatus: 409, body: { error: `Cannot ${command.type} an active attempt` } };
  }
  if (command.type === 'stop' && task.status === 'done') {
    return { httpStatus: 409, body: { error: 'Mission is already stopped' } };
  }
  const confirmed = runService.getLatestConfirmedRun(missionId);
  if ((command.type === 'correct' || command.type === 'resume') && !confirmed) {
    return { httpStatus: 409, body: { error: 'No confirmed Hermes session is available' } };
  }
  return { task, current, confirmed, isActive };
}

export function createRunsRouter(dependencies: RunsRouterDependencies): ExpressRouter {
  const router = Router();
  const repository = createRunRepository(dependencies.database);
  const runService = dependencies.runService ?? createRunService(repository);
  const now = dependencies.now ?? Date.now;

  router.post('/:missionId/commands', async (req, res) => {
    const idempotencyKey = req.get('Idempotency-Key')?.trim();
    if (!idempotencyKey) return res.status(400).json({ error: 'Idempotency-Key is required' });

    let command: RunCommandBody;
    try {
      command = parseCommand(req.body);
    } catch (error) {
      return res.status(400).json({ error: toErrorMessage(error, 'Invalid command') });
    }

    const missionId = req.params.missionId;
    const payloadHash = canonicalHash(missionId, command);
    const prior = repository.getCommand(idempotencyKey);
    if (prior) {
      if (prior.payloadHash !== payloadHash) {
        return res.status(409).json({ error: 'Idempotency-Key was already used for another command' });
      }
      if ((prior.status === 'completed' || prior.status === 'needs_reconciliation')
        && isStoredHttpResult(prior.result)) {
        return res.status(prior.result.httpStatus).json(prior.result.body);
      }
      repository.nudgeCommandRetry(idempotencyKey, now());
      const recoveryOwner = dependencies.leaseOwner?.() ?? `interactive-replay:${randomUUID()}`;
      const leased = repository.leasePendingCommands({
        owner: recoveryOwner,
        idempotencyKey,
        now: now(),
        leaseMs: dependencies.leaseMs ?? 30_000,
        limit: 1,
      })[0];
      if (leased) {
        const recovered = recoverLeasedInteractiveCommand(
          dependencies.database,
          repository,
          runService,
          leased,
          recoveryOwner,
          now,
        );
        return res.status(recovered.httpStatus).json(recovered.body);
      }
      return res.status(202).json({
        type: command.type, missionId, runId: command.runId, status: 'pending',
      });
    }

    const preflight = loadCommandContext(dependencies.database, runService, missionId, command);
    if (isStoredHttpResult(preflight)) {
      return res.status(preflight.httpStatus).json(preflight.body);
    }

    if (command.type === 'correct' || command.type === 'resume' || command.type === 'retry') {
      try {
        await requireInteractiveAdmission(dependencies.adapter, runtimeSettings(preflight.current));
      } catch (error) {
        return sendInteractiveAdmissionError(res, error);
      }
    }

    if (command.type === 'resume') {
      try {
        const session = await dependencies.adapter.getSessionMetadata(preflight.confirmed!.sessionId);
        if (!session) return res.status(409).json({ error: 'Hermes session is no longer available' });
      } catch {
        return res.status(503).json({
          error: 'Hermes session metadata is unavailable',
          code: 'SESSION_METADATA_UNAVAILABLE',
        });
      }
    }

    const claim = repository.claimCommand({
      idempotencyKey,
      actorId: req.actor.id,
      missionId,
      runId: command.runId,
      commandType: command.type,
      payloadHash,
      payload: command,
    });
    if (claim.status === 'conflict') {
      return res.status(409).json({ error: 'Idempotency-Key was already used for another command' });
    }
    if (claim.status === 'busy') {
      return res.status(409).json({
        error: 'Another operator command is already in progress for this mission',
        code: 'MISSION_COMMAND_BUSY',
      });
    }
    if (claim.status === 'duplicate') {
      if ((claim.command.status === 'completed' || claim.command.status === 'needs_reconciliation')
        && isStoredHttpResult(claim.command.result)) {
        return res.status(claim.command.result.httpStatus).json(claim.command.result.body);
      }
      return res.status(202).json({
        type: command.type, missionId, runId: command.runId, status: 'pending',
      });
    }

    const owner = dependencies.leaseOwner?.() ?? `interactive-http:${randomUUID()}`;
    const leased = repository.leasePendingCommands({
      owner,
      idempotencyKey,
      now: now(),
      leaseMs: dependencies.leaseMs ?? 30_000,
      limit: 1,
    })[0];
    if (!leased) {
      return res.status(202).json({
        type: command.type, missionId, runId: command.runId, status: 'pending',
      });
    }

    try {
      const result = await executeClaimedInteractiveCommand(
        dependencies,
        repository,
        runService,
        leased,
        owner,
        command,
        preflight,
      );
      return res.status(result.httpStatus).json(result.body);
    } catch (error) {
      if (error instanceof InjectedCommandCrashError) {
        return res.status(503).json({
          error: 'Operator command processing was interrupted',
          code: 'COMMAND_PROCESS_INTERRUPTED',
        });
      }
      const result: StoredHttpResult = {
        httpStatus: 503,
        body: {
          error: 'Could not execute operator command',
          code: 'COMMAND_EXECUTION_FAILED',
        },
      };
      let durable: ReturnType<typeof repository.getCommand>;
      try {
        durable = repository.getCommand(idempotencyKey);
      } catch {
        return res.status(result.httpStatus).json(result.body);
      }
      if (durable?.status === 'claimed'
        && durable.leaseOwner === owner
        && durable.phase !== 'claimed') {
        try {
          const recovered = recoverLeasedInteractiveCommand(
            dependencies.database,
            repository,
            runService,
            durable,
            owner,
            now,
          );
          return res.status(recovered.httpStatus).json(recovered.body);
        } catch {
          // Leave the durable phase claimed for the next lease owner to recover.
          return res.status(result.httpStatus).json(result.body);
        }
      }
      try {
        repository.completeCommand({ idempotencyKey, owner, result });
      } catch {
        // A lost lease is recovered from its durable phase; never overwrite the new owner.
      }
      return res.status(result.httpStatus).json(result.body);
    }
  });

  return router;
}
