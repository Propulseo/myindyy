import { Router, type Response } from 'express';
import { createHash } from 'node:crypto';
import { errorCode, isRecord, toErrorMessage } from '../errors.js';
import type {
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTasksPolicyContext,
} from '../../shared/types.js';
import type { HermesWorkerAdapter } from '../adapters/hermes-worker.js';
import { listScheduledTaskRuns, getScheduledTaskRunContent } from '../scheduled-tasks/runs.js';
import type { RuntimeStatus } from '../runtime/hermes-runtime.js';
import {
  resolveScheduledWorkdirRegistry,
  validateScheduledTask,
  type ResolvedScheduledTaskRuntime,
  type ScheduledWorkdirRegistry,
} from '../scheduled-tasks/policy.js';
import type { RunRepository } from '../runs/repository.js';
import { redactSensitiveText } from '../security/redaction.js';

const SCHEDULED_TASKS_LIMIT = 100;
const SCHEDULED_TASK_RUNS_LIMIT = 50;

const SCHEDULED_TASK_INPUT_FIELDS = [
  'name',
  'prompt',
  'schedule',
  'deliver',
  'skills',
  'model',
  'provider',
  'reasoningEffort',
  'baseUrl',
  'workdir',
  'repeat',
  'contextFrom',
] as const;

type ScheduledTasksAdapter = Pick<
  HermesWorkerAdapter,
  | 'listScheduledTasks'
  | 'getScheduledTask'
  | 'createScheduledTask'
  | 'updateScheduledTask'
  | 'pauseScheduledTask'
  | 'resumeScheduledTask'
  | 'runScheduledTask'
  | 'removeScheduledTask'
> & {
  getRuntimeStatus(): Promise<RuntimeStatus>;
};

export interface ScheduledTasksRouterOptions {
  readonly workdirRegistry?: ScheduledWorkdirRegistry;
  readonly runRepository?: RunRepository;
}

interface StoredCommandResult {
  readonly statusCode: number;
  readonly body: unknown;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function commandHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function cronDispatchToken(actorId: string, idempotencyKey: string, scheduledTaskId: string): string {
  return commandHash({ actorId, idempotencyKey, scheduledTaskId }).slice(0, 40);
}

function pendingCronAcknowledgement(actorId: string, idempotencyKey: string, scheduledTaskId: string) {
  return {
    accepted: false as const,
    pending: true as const,
    durableRun: null,
    dispatchToken: cronDispatchToken(actorId, idempotencyKey, scheduledTaskId),
    idempotencyKey,
    scheduledTaskId,
  };
}

function storedCommandResult(value: unknown): StoredCommandResult | null {
  if (!isRecord(value) || typeof value.statusCode !== 'number' || !('body' in value)) return null;
  return { statusCode: value.statusCode, body: value.body };
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function scheduledTaskInputFromBody(body: unknown): Partial<ScheduledTaskInput> {
  if (!isRecord(body)) return {};

  const input: Partial<ScheduledTaskInput> = {};
  for (const field of SCHEDULED_TASK_INPUT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      Object.assign(input, { [field]: body[field] });
    }
  }
  return input;
}

function workerStatus(error: unknown): number {
  const code = errorCode(error);
  if (code === 'bad_request') return 400;
  if (code === 'not_found') return 404;
  return 503;
}

function sendWorkerError(res: Response, error: unknown): void {
  if (workerStatus(error) === 400) {
    res.status(400).json({
      error: 'Hermes a refusé les paramètres de la tâche planifiée.',
      code: 'HERMES_SCHEDULED_TASK_INVALID',
    });
    return;
  }
  res.status(503).json({
    error: 'Hermes scheduled tasks worker unavailable',
    code: 'HERMES_SCHEDULED_TASKS_UNAVAILABLE',
  });
}

function redactErrorText(value: string | null): string | null {
  return value ? redactSensitiveText(value) : value;
}

export async function recoverPendingCronDispatches(
  adapter: ScheduledTasksAdapter,
  runRepository: RunRepository,
  workdirRegistry: ScheduledWorkdirRegistry = resolveScheduledWorkdirRegistry(),
): Promise<{ recovered: number; deferred: number }> {
  let recovered = 0;
  let deferred = 0;
  for (const command of runRepository.listPendingCommands('cron.run')) {
    const prefix = 'cron:';
    if (!command.missionId.startsWith(prefix)) continue;
    const scheduledTaskId = command.missionId.slice(prefix.length);
    const acknowledgement = pendingCronAcknowledgement(command.actorId, command.idempotencyKey, scheduledTaskId);
    try {
      const scheduledTask = await adapter.getScheduledTask(scheduledTaskId);
      if (!scheduledTask) {
        runRepository.completeCommand({
          idempotencyKey: command.idempotencyKey,
          result: { statusCode: 404, body: { error: 'Scheduled task not found' } },
        });
        recovered += 1;
        continue;
      }
      const validation = validateScheduledTask(scheduledTask, await adapter.getRuntimeStatus(), workdirRegistry);
      if (!validation.ok) {
        runRepository.completeCommand({
          idempotencyKey: command.idempotencyKey,
          result: {
            statusCode: validation.error.status,
            body: { error: validation.error.message, code: validation.error.code, field: validation.error.field },
          },
        });
        recovered += 1;
        continue;
      }
      const result = await adapter.runScheduledTask(scheduledTaskId, acknowledgement.dispatchToken);
      if (result.dispatchReceipt?.state !== 'accepted') {
        deferred += 1;
        continue;
      }
      runRepository.completeCommand({
        idempotencyKey: command.idempotencyKey,
        result: { statusCode: 202, body: { ...acknowledgement, dispatchAccepted: true } },
      });
      recovered += 1;
    } catch {
      deferred += 1;
    }
  }
  return { recovered, deferred };
}

export function createScheduledTasksRouter(
  adapter: ScheduledTasksAdapter,
  options: ScheduledTasksRouterOptions = {},
): Router {
  const router = Router();
  const workdirRegistry = options.workdirRegistry ?? resolveScheduledWorkdirRegistry();
  const runRepository = options.runRepository;

  async function resolveRuntimePolicy(
    input: Pick<ScheduledTaskInput, 'provider' | 'model' | 'reasoningEffort' | 'workdir'>,
    res: Response,
  ): Promise<ResolvedScheduledTaskRuntime | null> {
    let runtime: RuntimeStatus;
    try {
      runtime = await adapter.getRuntimeStatus();
    } catch {
      res.status(503).json({
        error: 'Le catalogue Codex OAuth frais est indisponible.',
        code: 'SCHEDULED_RUNTIME_UNAVAILABLE',
        field: 'runtime',
      });
      return null;
    }
    const result = validateScheduledTask(input, runtime, workdirRegistry);
    if (!result.ok) {
      res.status(result.error.status).json({
        error: result.error.message,
        code: result.error.code,
        field: result.error.field,
      });
      return null;
    }
    return result.value;
  }

  async function projectScheduledTasks(tasks: ScheduledTask[]): Promise<{
    scheduledTasks: ScheduledTask[];
    policy: ScheduledTasksPolicyContext;
  }> {
    let runtime: RuntimeStatus;
    try {
      runtime = await adapter.getRuntimeStatus();
    } catch {
      runtime = {
        provider: 'openai-codex',
        profileId: null,
        authState: 'error',
        checkedAt: new Date().toISOString(),
        models: [],
      };
    }
    const scheduledTasks = tasks.map((task) => {
      const result = validateScheduledTask(task, runtime, workdirRegistry);
      return {
        ...task,
        lastError: redactErrorText(task.lastError),
        lastDeliveryError: redactErrorText(task.lastDeliveryError),
        readiness: result.ok
          ? { ready: true, code: null, reason: null }
          : { ready: false, code: result.error.code, reason: result.error.message },
      };
    });
    return {
      scheduledTasks,
      policy: {
        ...runtime,
        allowedWorkdirs: [...workdirRegistry.roots],
      },
    };
  }

  router.get('/', async (req, res) => {
    try {
      const includeDisabled = req.query.includeDisabled === 'true';
      const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
      const parsedLimit = rawLimit ? Number.parseInt(String(rawLimit), 10) : SCHEDULED_TASKS_LIMIT;
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(parsedLimit, SCHEDULED_TASKS_LIMIT))
        : SCHEDULED_TASKS_LIMIT;
      const scheduledTasks = await adapter.listScheduledTasks(includeDisabled, limit);
      res.json(await projectScheduledTasks(scheduledTasks));
    } catch {
      res.status(503).json({ error: 'Hermes scheduled tasks worker unavailable' });
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const scheduledTask = await adapter.getScheduledTask(req.params.id);
      if (!scheduledTask) return res.status(404).json({ error: 'Scheduled task not found' });
      const projection = await projectScheduledTasks([scheduledTask]);
      res.json({ scheduledTask: projection.scheduledTasks[0], policy: projection.policy });
    } catch {
      res.status(503).json({ error: 'Hermes scheduled tasks worker unavailable' });
    }
  });

  router.post('/', async (req, res) => {
    const input = scheduledTaskInputFromBody(req.body);
    if (!hasText(input.prompt)) return res.status(400).json({ error: 'prompt is required' });
    if (!hasText(input.schedule)) return res.status(400).json({ error: 'schedule is required' });

    const runtime = await resolveRuntimePolicy(input, res);
    if (!runtime) return;

    try {
      const scheduledTask = await adapter.createScheduledTask({
        ...input as ScheduledTaskInput,
        ...runtime,
      });
      const projection = await projectScheduledTasks([scheduledTask]);
      res.json({ scheduledTask: projection.scheduledTasks[0], policy: projection.policy });
    } catch (error) {
      sendWorkerError(res, error);
    }
  });

  router.patch('/:id', async (req, res) => {
    const updates = scheduledTaskInputFromBody(req.body);
    if ('prompt' in updates && !hasText(updates.prompt)) {
      return res.status(400).json({ error: 'prompt cannot be empty' });
    }
    if ('schedule' in updates && !hasText(updates.schedule)) {
      return res.status(400).json({ error: 'schedule cannot be empty' });
    }

    try {
      const current = await adapter.getScheduledTask(req.params.id);
      if (!current) return res.status(404).json({ error: 'Scheduled task not found' });
      const runtime = await resolveRuntimePolicy({
        provider: updates.provider === undefined ? current.provider : updates.provider,
        model: updates.model === undefined ? current.model : updates.model,
        reasoningEffort: updates.reasoningEffort === undefined ? current.reasoningEffort : updates.reasoningEffort,
        workdir: updates.workdir === undefined ? current.workdir : updates.workdir,
      }, res);
      if (!runtime) return;
      const scheduledTask = await adapter.updateScheduledTask(req.params.id, {
        ...updates,
        ...runtime,
      });
      if (!scheduledTask) return res.status(404).json({ error: 'Scheduled task not found' });
      const projection = await projectScheduledTasks([scheduledTask]);
      res.json({ scheduledTask: projection.scheduledTasks[0], policy: projection.policy });
    } catch (error) {
      sendWorkerError(res, error);
    }
  });

  router.get('/:id/runs', async (req, res) => {
    try {
      const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
      const limit = rawLimit ? Number.parseInt(String(rawLimit), 10) : SCHEDULED_TASK_RUNS_LIMIT;
      const runs = await listScheduledTaskRuns(req.params.id, Number.isFinite(limit) ? limit : SCHEDULED_TASK_RUNS_LIMIT);
      res.json({ runs });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error, 'Failed to list scheduled task runs') });
    }
  });

  router.get('/:id/runs/:runId/content', async (req, res) => {
    try {
      const content = await getScheduledTaskRunContent(req.params.id, req.params.runId);
      if (!content) return res.status(404).json({ error: 'Scheduled task run output not found' });
      res.json({ content });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error, 'Failed to read scheduled task run') });
    }
  });

  async function scheduledTaskActionHandler(
    res: Response,
    id: string,
    action: (id: string) => Promise<ScheduledTask | null>,
  ) {
    try {
      const scheduledTask = await action(id);
      if (!scheduledTask) return res.status(404).json({ error: 'Scheduled task not found' });
      const projection = await projectScheduledTasks([scheduledTask]);
      res.json({ scheduledTask: projection.scheduledTasks[0], policy: projection.policy });
    } catch (error) {
      sendWorkerError(res, error);
    }
  }

  router.post('/:id/pause', (req, res) => {
    const rawReason = req.body?.reason;
    const reason = typeof rawReason === 'string' && rawReason.trim() ? rawReason.trim() : undefined;
    scheduledTaskActionHandler(res, req.params.id, (id) => adapter.pauseScheduledTask(id, reason));
  });

  router.post('/:id/resume', async (req, res) => {
    try {
      const scheduledTask = await adapter.getScheduledTask(req.params.id);
      if (!scheduledTask) return res.status(404).json({ error: 'Scheduled task not found' });
      const runtime = await resolveRuntimePolicy(scheduledTask, res);
      if (!runtime) return;
      await scheduledTaskActionHandler(res, req.params.id, (id) => adapter.resumeScheduledTask(id));
    } catch (error) {
      sendWorkerError(res, error);
    }
  });

  router.post('/:id/run', async (req, res) => {
    const idempotencyKey = req.get('Idempotency-Key')?.trim();
    if (!idempotencyKey) {
      return res.status(400).json({
        error: 'Idempotency-Key est requis pour une exécution manuelle.',
        code: 'IDEMPOTENCY_KEY_REQUIRED',
      });
    }
    if (!runRepository) {
      return res.status(503).json({
        error: 'Le journal d’idempotence des crons est indisponible.',
        code: 'IDEMPOTENCY_STORE_UNAVAILABLE',
      });
    }
    if (!req.actor) return res.status(401).json({ error: 'Authentication required' });

    try {
      const pendingAcknowledgement = pendingCronAcknowledgement(req.actor.id, idempotencyKey, req.params.id);
      const dispatchToken = pendingAcknowledgement.dispatchToken;
      const claim = runRepository.claimCommand({
        idempotencyKey,
        actorId: req.actor.id,
        missionId: `cron:${req.params.id}`,
        runId: null,
        commandType: 'cron.run',
        payloadHash: commandHash({
          scheduledTaskId: req.params.id,
          body: req.body ?? null,
        }),
      });
      if (claim.status === 'conflict') {
        return res.status(409).json({
          error: 'Cette clé d’idempotence a déjà été utilisée avec une autre commande.',
          code: 'IDEMPOTENCY_KEY_CONFLICT',
        });
      }
      if (claim.status === 'duplicate') {
        const stored = storedCommandResult(claim.command.result);
        return stored
          ? res.status(stored.statusCode).json(stored.body)
          : res.status(202).json(pendingAcknowledgement);
      }

      const finish = (commandResult: StoredCommandResult) => {
        runRepository.completeCommand({ idempotencyKey, result: commandResult });
        return res.status(commandResult.statusCode).json(commandResult.body);
      };

      const scheduledTask = await adapter.getScheduledTask(req.params.id);
      if (!scheduledTask) return finish({ statusCode: 404, body: { error: 'Scheduled task not found' } });
      let freshRuntime: RuntimeStatus;
      try {
        freshRuntime = await adapter.getRuntimeStatus();
      } catch {
        return finish({
          statusCode: 503,
          body: { error: 'Le catalogue Codex OAuth frais est indisponible.', code: 'SCHEDULED_RUNTIME_UNAVAILABLE', field: 'runtime' },
        });
      }
      const validation = validateScheduledTask(scheduledTask, freshRuntime, workdirRegistry);
      if (!validation.ok) {
        return finish({
          statusCode: validation.error.status,
          body: { error: validation.error.message, code: validation.error.code, field: validation.error.field },
        });
      }

      try {
        const dispatch = await adapter.runScheduledTask(req.params.id, dispatchToken);
        if (!dispatch.scheduledTask || dispatch.dispatchReceipt?.state === 'missing') {
          return finish({ statusCode: 404, body: { error: 'Scheduled task not found' } });
        }
        if (dispatch.dispatchReceipt?.state !== 'accepted') {
          return res.status(202).json(pendingAcknowledgement);
        }
        return finish({
          statusCode: 202,
          body: { ...pendingAcknowledgement, dispatchAccepted: true },
        });
      } catch {
        // The durable operator command remains claimed. A retry/restart can
        // safely resume it with the same Hermes dispatch token/receipt.
        return res.status(202).json(pendingAcknowledgement);
      }
    } catch {
      res.status(503).json({
        error: 'Le déclenchement manuel Hermes est indisponible.',
        code: 'HERMES_CRON_TRIGGER_UNAVAILABLE',
      });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const removed = await adapter.removeScheduledTask(req.params.id);
      if (!removed) return res.status(404).json({ error: 'Scheduled task not found' });
      res.json({ ok: true });
    } catch (error) {
      sendWorkerError(res, error);
    }
  });

  return router;
}
