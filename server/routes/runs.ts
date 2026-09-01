import { createHash } from 'node:crypto';
import { Router, type Request, type Router as ExpressRouter } from 'express';
import type { Database } from 'better-sqlite3';
import type { AgentAdapter, AgentRunSettings } from '../adapters/types.js';
import { broadcast } from '../events.js';
import { isRecord, toErrorMessage } from '../errors.js';
import { createRunRepository } from '../runs/repository.js';
import { createRunService, type RunService, type StartedMission } from '../runs/service.js';
import {
  RUN_COMMAND_TYPES,
  type MissionRun,
  type RunCommandBody,
  type RunCommandResult,
  type Task,
} from '../../shared/types.js';

type CommandAdapter = Pick<AgentAdapter, 'interruptChat' | 'getSessionMetadata'>;

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
}

interface StoredHttpResult {
  readonly httpStatus: number;
  readonly body: unknown;
}

const ACTIVE_STATUSES = new Set<MissionRun['status']>(['queued', 'running', 'waiting_approval']);
const TERMINAL_STATUSES = new Set<MissionRun['status']>(['completed', 'failed', 'cancelled']);
const COMMAND_FIELDS = new Set(['type', 'runId', 'reason']);

function resolveActor(_request: Request): string {
  return 'etienne';
}

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

function isStoredHttpResult(value: unknown): value is StoredHttpResult {
  return isRecord(value)
    && typeof value.httpStatus === 'number'
    && Object.prototype.hasOwnProperty.call(value, 'body');
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

export function createRunsRouter(dependencies: RunsRouterDependencies): ExpressRouter {
  const router = Router();
  const repository = createRunRepository(dependencies.database);
  const runService = dependencies.runService ?? createRunService(repository);
  const getMission = dependencies.database.prepare('SELECT * FROM tasks WHERE id = ?');
  const setMissionStatus = dependencies.database.prepare(`
    UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?
  `);

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
    const claim = repository.claimCommand({
      idempotencyKey,
      actorId: resolveActor(req),
      missionId,
      runId: command.runId,
      commandType: command.type,
      payloadHash: canonicalHash(missionId, command),
    });

    if (claim.status === 'conflict') {
      return res.status(409).json({ error: 'Idempotency-Key was already used for another command' });
    }
    if (claim.status === 'duplicate') {
      if (claim.command.status === 'completed' && isStoredHttpResult(claim.command.result)) {
        return res.status(claim.command.result.httpStatus).json(claim.command.result.body);
      }
      return res.status(409).json({ error: 'Command is already in progress' });
    }

    const finish = (httpStatus: number, body: unknown) => {
      repository.completeCommand({ idempotencyKey, result: { httpStatus, body } });
      return res.status(httpStatus).json(body);
    };

    const task = getMission.get(missionId) as Task | undefined;
    if (!task) return finish(404, { error: 'Mission not found' });

    const current = runService.getLatestRun(missionId);
    if (!current || current.id !== command.runId || current.missionId !== missionId) {
      return finish(409, { error: 'runId must be the current attempt for this mission' });
    }

    const isActive = ACTIVE_STATUSES.has(current.status);
    if (command.type === 'interrupt' && !isActive) {
      return finish(409, { error: 'The current attempt is not interruptible' });
    }
    if ((command.type === 'resume' || command.type === 'retry') && isActive) {
      return finish(409, { error: `Cannot ${command.type} an active attempt` });
    }
    if (command.type === 'stop' && task.status === 'done') {
      return finish(409, { error: 'Mission is already stopped' });
    }

    try {
      if (command.type === 'interrupt') {
        const interrupted = await dependencies.adapter.interruptChat(current.sessionId, command.reason);
        if (!interrupted) return finish(409, { error: 'Hermes had no active run to interrupt' });
        runService.cancel(current.id, 'operator-interrupt');
        const body: RunCommandResult = {
          type: command.type, missionId, runId: current.id, status: 'accepted',
        };
        return finish(202, body);
      }

      if (command.type === 'stop') {
        if (isActive) await dependencies.adapter.interruptChat(current.sessionId, command.reason);
        if (!TERMINAL_STATUSES.has(current.status)) runService.cancel(current.id, 'operator-stop');
        setMissionStatus.run('done', Date.now(), missionId);
        const updated = getMission.get(missionId) as Task;
        broadcast({ type: 'task_updated', task: updated });
        const body: RunCommandResult = {
          type: command.type, missionId, runId: current.id, status: 'accepted',
        };
        return finish(202, body);
      }

      const confirmed = runService.getLatestConfirmedRun(missionId);
      if ((command.type === 'correct' || command.type === 'resume') && !confirmed) {
        return finish(409, { error: 'No confirmed Hermes session is available' });
      }

      if (command.type === 'resume') {
        const session = await dependencies.adapter.getSessionMetadata(confirmed!.sessionId);
        if (!session) return finish(409, { error: 'Hermes session is no longer available' });
      }

      if (command.type === 'correct' && isActive) {
        const interrupted = await dependencies.adapter.interruptChat(current.sessionId, command.reason);
        if (!interrupted) return finish(409, { error: 'Hermes had no active run to interrupt' });
      }
      if (!TERMINAL_STATUSES.has(current.status)) {
        runService.cancel(
          current.id,
          command.type === 'correct' ? 'operator-interrupt' : `operator-${command.type}`,
        );
      }

      const started = command.type === 'retry'
        ? runService.startLinkedAttempt(current)
        : runService.startLinkedAttempt(current, { sessionRun: confirmed! });
      setMissionStatus.run('in_progress', Date.now(), missionId);
      const updated = getMission.get(missionId) as Task;
      broadcast({ type: 'task_updated', task: updated });
      const startedRecord = runService.getLatestRun(missionId)!;
      dependencies.launchCommandRun(
        updated,
        started,
        commandInstruction(command, updated),
        runtimeSettings(startedRecord),
      );
      const body: RunCommandResult = {
        type: command.type,
        missionId,
        runId: started.runId,
        previousRunId: current.id,
        status: 'accepted',
      };
      return finish(202, body);
    } catch (error) {
      return finish(503, { error: toErrorMessage(error, 'Could not execute operator command') });
    }
  });

  return router;
}
