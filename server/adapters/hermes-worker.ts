import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type {
  AgentDefaults,
  AgentModelsResponse,
  CompactResult,
  GoalDecision,
  GoalStateSnapshot,
  ScheduledTask,
  ScheduledTaskInput,
  SessionMetadata,
  TaskMessage,
} from '../../shared/types.js';
import type {
  AgentAdapter,
  AgentRunOptions,
  AgentRunSettings,
  ScheduledTaskDispatchReceipt,
  StreamEvent,
} from './types.js';
import type {
  WorkerEvent,
  WorkerRequest,
  WorkerResult,
  WorkerErrorPayload,
  WorkerRuntimeStatus,
} from './worker-protocol.js';
import { expandHomePrefix } from '../paths.js';
import { sanitizeWorkerEnv } from '../runtime/policy.js';
import { validateHermesRuntimeExecution } from '../hermes-runtime-manifest.js';
import { PublicError, publicError } from '../errors.js';

const WORKER_READY_TIMEOUT_MS = 10_000;
const WORKER_INTERRUPT_TIMEOUT_MS = 10_000;
const WORKER_TERMINATION_GRACE_MS = 500;
const PROCESS_ENVIRONMENT: Readonly<NodeJS.ProcessEnv> = Object.freeze({ ...process.env });

export interface WorkerRuntimeContract {
  readonly runtimeRoot: string;
  readonly manifestAnchor: string;
  readonly python: string;
}

export function captureWorkerRuntimeContract(
  environment: NodeJS.ProcessEnv,
): WorkerRuntimeContract | undefined {
  if (environment.INDY_HERMES_RUNTIME_GUARD !== '1') return undefined;
  const runtimeRoot = environment.HERMES_AGENT_DIR?.trim();
  const manifestAnchor = environment.HERMES_RUNTIME_MANIFEST_FILE?.trim();
  const python = environment.HERMES_PYTHON?.trim();
  if (!runtimeRoot || !manifestAnchor || !python) {
    throw new Error('Guarded Hermes worker runtime paths are incomplete');
  }
  return Object.freeze({ runtimeRoot, manifestAnchor, python });
}

const PROCESS_WORKER_RUNTIME_CONTRACT = captureWorkerRuntimeContract(PROCESS_ENVIRONMENT);

function selectWorkerRuntimeContract(
  environment: NodeJS.ProcessEnv,
  contract?: WorkerRuntimeContract,
): WorkerRuntimeContract | undefined {
  if (contract) return contract;
  if (environment === PROCESS_ENVIRONMENT) {
    return PROCESS_WORKER_RUNTIME_CONTRACT;
  }
  return captureWorkerRuntimeContract(environment);
}

export function createWorkerEnvironment(
  source: NodeJS.ProcessEnv = PROCESS_ENVIRONMENT,
  contract?: WorkerRuntimeContract,
): NodeJS.ProcessEnv {
  const selectedContract = selectWorkerRuntimeContract(source, contract);
  assertWorkerRuntimeIntegrity(source, selectedContract);
  const environment: NodeJS.ProcessEnv = {
    ...sanitizeWorkerEnv(source),
    HERMES_QUIET: '1',
    HERMES_YOLO_MODE: '1',
  };
  if (selectedContract) {
    Object.assign(environment, {
      HERMES_AGENT_DIR: selectedContract.runtimeRoot,
      HERMES_PYTHON: selectedContract.python,
      HERMES_RUNTIME_MANIFEST_FILE: selectedContract.manifestAnchor,
      INDY_HERMES_RUNTIME_GUARD: '1',
    });
  }
  delete environment.HERMES_SOURCE_DIR;
  delete environment.HERMES_SOURCE_PYTHON;
  delete environment.PYTHONHOME;
  delete environment.PYTHONPATH;
  delete environment.PYTHONUSERBASE;
  return environment;
}

export function assertWorkerRuntimeIntegrity(
  environment: NodeJS.ProcessEnv = PROCESS_ENVIRONMENT,
  contract?: WorkerRuntimeContract,
): void {
  const selectedContract = selectWorkerRuntimeContract(environment, contract);
  if (!selectedContract) return;
  validateHermesRuntimeExecution(
    selectedContract.runtimeRoot,
    selectedContract.manifestAnchor,
    selectedContract.python,
  );
}

export function createWorkerArguments(
  script: string,
  environment: NodeJS.ProcessEnv = PROCESS_ENVIRONMENT,
): string[] {
  if (environment.INDY_HERMES_RUNTIME_GUARD !== '1') return [script];
  const bootstrap = [
    'import runpy,sys',
    'sys.path.insert(0,sys.argv[1])',
    'runpy.run_path(sys.argv[2],run_name="__main__")',
  ].join(';');
  return ['-I', '-c', bootstrap, dirname(script), script];
}

type WorkerRequestInput = WorkerRequest extends infer Request
  ? Request extends WorkerRequest
    ? Omit<Request, 'id'>
    : never
  : never;

type PendingRequest = {
  kind: 'request';
  resolve: (value: WorkerResult) => void;
  reject: (error: Error) => void;
};

type PendingStream = {
  kind: 'stream';
  push: (event: WorkerEvent) => void;
  end: () => void;
  fail: (error: Error) => void;
};

type Pending = PendingRequest | PendingStream;

function resolveAgentDirFromHermesCli(environment: NodeJS.ProcessEnv): string | undefined {
  try {
    const hermesBin = execFileSync('which', ['hermes'], {
      encoding: 'utf8',
      env: environment,
    }).trim();
    const real = realpathSync(hermesBin);
    // Typical layout: <agent-dir>/venv/bin/hermes → agent dir is 3 levels up
    const candidate = resolve(dirname(real), '..', '..');
    if (existsSync(join(candidate, 'run_agent.py'))) return candidate;
  } catch {
    // `which` failed or path doesn't resolve — not installed via standard installer
  }
  return undefined;
}

function resolvePython(environment: NodeJS.ProcessEnv = PROCESS_ENVIRONMENT): string {
  if (environment.HERMES_PYTHON) return expandHomePrefix(environment.HERMES_PYTHON);

  const candidates: string[] = [];
  if (environment.HERMES_AGENT_DIR) {
    candidates.push(join(expandHomePrefix(environment.HERMES_AGENT_DIR), 'venv/bin/python'));
  }
  const hermesHome = resolve(expandHomePrefix(environment.HERMES_HOME?.trim() || join(homedir(), '.hermes')));
  candidates.push(join(hermesHome, 'hermes-agent/venv/bin/python'));

  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;

  const cliAgentDir = resolveAgentDirFromHermesCli(environment);
  if (cliAgentDir) {
    const venvPython = join(cliAgentDir, 'venv/bin/python');
    if (existsSync(venvPython)) return venvPython;
  }

  return 'python3';
}

export function resolveWorkerScript(environment: NodeJS.ProcessEnv = PROCESS_ENVIRONMENT): string {
  const explicit = environment.HERMES_WORKER_SCRIPT?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error('HERMES_WORKER_SCRIPT must be absolute');
    if (!existsSync(explicit)) throw new Error('HERMES_WORKER_SCRIPT does not exist');
    return explicit;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../workers/hermes_worker.py'),
    resolve(here, '../../server/workers/hermes_worker.py'),
    resolve(process.cwd(), 'server/workers/hermes_worker.py'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`Hermes worker script not found. Tried: ${candidates.join(', ')}`);
  return found;
}

function resolveWorkerWorkspace(environment: NodeJS.ProcessEnv): string {
  const minionsHome = resolve(expandHomePrefix(environment.MINIONS_HOME?.trim() || join(homedir(), '.minions')));
  return join(minionsHome, 'workspace');
}

export interface WorkerLaunchContract {
  readonly python: string;
  readonly script: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly workspace: string;
  readonly runtimeContract?: WorkerRuntimeContract;
}

export function captureWorkerLaunchContract(
  source: NodeJS.ProcessEnv,
): WorkerLaunchContract {
  const snapshot = Object.freeze({ ...source });
  const runtimeContract = captureWorkerRuntimeContract(snapshot);
  const script = resolveWorkerScript(snapshot);
  const python = resolvePython(snapshot);
  const environment = Object.freeze({ ...createWorkerEnvironment(snapshot, runtimeContract) });
  const arguments_ = Object.freeze([...createWorkerArguments(script, snapshot)]);
  return Object.freeze({
    python,
    script,
    arguments: arguments_,
    environment,
    workspace: resolveWorkerWorkspace(snapshot),
    runtimeContract,
  });
}

const PROCESS_WORKER_LAUNCH_CONTRACT = captureWorkerLaunchContract({ ...PROCESS_ENVIRONMENT });

function workerErrorCode(error: string | WorkerErrorPayload | undefined): string | undefined {
  return typeof error === 'object' ? error.code : undefined;
}

class HermesWorkerError extends PublicError {
  constructor(error: string | WorkerErrorPayload | undefined) {
    const safe = publicError(workerErrorCode(error));
    super(safe.code);
    this.name = 'HermesWorkerError';
  }
}

function createAsyncQueue<T>() {
  const values: T[] = [];
  const waiters: {
    resolve: (value: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }[] = [];
  let ended = false;
  let failure: Error | null = null;

  return {
    push(value: T) {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ value, done: false });
      else values.push(value);
    },
    end() {
      ended = true;
      while (waiters.length > 0) {
        waiters.shift()?.resolve({ value: undefined as T, done: true });
      }
    },
    fail(error: Error) {
      failure = error;
      while (waiters.length > 0) {
        waiters.shift()?.reject(error);
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          if (values.length > 0) {
            return Promise.resolve({ value: values.shift() as T, done: false });
          }
          if (failure) return Promise.reject(failure);
          if (ended) return Promise.resolve({ value: undefined as T, done: true });
          return new Promise((resolveNext, reject) => {
            waiters.push({ resolve: resolveNext, reject });
          });
        },
        return(): Promise<IteratorResult<T>> {
          ended = true;
          values.length = 0;
          return Promise.resolve({ value: undefined as T, done: true });
        },
      };
    },
  };
}

type WorkerSpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
};

export type WorkerSpawner = (
  executable: string,
  arguments_: string[],
  options: WorkerSpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface HermesWorkerAdapterOptions {
  launchContract?: WorkerLaunchContract;
  spawnWorker?: WorkerSpawner;
  readyTimeoutMs?: number;
  terminationGraceMs?: number;
}

type WorkerGeneration = {
  readonly id: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: Interface;
  readonly pending: Map<string, Pending>;
  readonly terminated: Promise<void>;
  resolveTerminated: () => void;
  stderrPendingFragment: boolean;
  stderrNoticeWritten: boolean;
  stderrFlushed: boolean;
  terminal: boolean;
  ready: boolean;
  readyPromise: Promise<void> | null;
  retiringPromise: Promise<void> | null;
};

const spawnWorkerProcess: WorkerSpawner = (executable, arguments_, options) => (
  spawn(executable, arguments_, options)
);

class HermesWorkerClient {
  private readonly launchContract: WorkerLaunchContract;
  private readonly spawnWorker: WorkerSpawner;
  private readonly readyTimeoutMs: number;
  private readonly terminationGraceMs: number;
  private generation: WorkerGeneration | null = null;
  private retirementBarrier: Promise<void> | null = null;

  constructor(options: HermesWorkerAdapterOptions = {}) {
    this.launchContract = options.launchContract ?? PROCESS_WORKER_LAUNCH_CONTRACT;
    this.spawnWorker = options.spawnWorker ?? spawnWorkerProcess;
    this.readyTimeoutMs = options.readyTimeoutMs ?? WORKER_READY_TIMEOUT_MS;
    this.terminationGraceMs = options.terminationGraceMs ?? WORKER_TERMINATION_GRACE_MS;
  }

  async start(): Promise<void> {
    const generation = await this.ensureGeneration();
    if (generation.ready) return;

    if (!generation.readyPromise) {
      const request = { id: randomUUID(), type: 'health' } as WorkerRequest;
      generation.readyPromise = this.sendRequestOnGeneration<{ ok: boolean }>(
        generation,
        request,
        this.readyTimeoutMs,
      ).then((result) => {
        if (!result.ok) throw new Error('Hermes worker healthcheck failed');
        if (this.generation !== generation || generation.terminal) {
          throw new Error('Hermes worker stopped during startup');
        }
        generation.ready = true;
      }).catch(async (error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        await this.retireGeneration(generation, failure);
        throw failure;
      });
    }

    await generation.readyPromise;
  }

  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const generation = this.generation;
    if (generation) {
      await this.retireGeneration(generation, new Error('Hermes worker stopped'), signal);
      return;
    }
    if (this.retirementBarrier) await this.retirementBarrier;
  }

  async request<T extends WorkerResult>(
    input: WorkerRequest['type'] | WorkerRequestInput,
    timeoutMs?: number,
  ): Promise<T> {
    await this.start();
    const generation = this.generation;
    if (!generation || generation.terminal || !generation.ready) {
      throw new Error('Hermes worker is not running');
    }
    const id = randomUUID();
    const request = typeof input === 'string'
      ? { id, type: input } as WorkerRequest
      : { ...input, id } as WorkerRequest;
    return await this.sendRequestOnGeneration<T>(generation, request, timeoutMs);
  }

  async *stream(request: Omit<Extract<WorkerRequest, { type: 'chat' }>, 'id'>): AsyncIterable<WorkerEvent> {
    await this.start();
    const generation = this.generation;
    if (!generation || generation.terminal || !generation.ready) {
      throw new Error('Hermes worker is not running');
    }
    const id = randomUUID();
    const queue = createAsyncQueue<WorkerEvent>();

    try {
      generation.pending.set(id, {
        kind: 'stream',
        push: queue.push,
        end: queue.end,
        fail: queue.fail,
      });
      this.write(generation, { ...request, id });

      for await (const event of queue) yield event;
    } finally {
      generation.pending.delete(id);
    }
  }

  validateRuntimeIntegrity(): void {
    if (!this.launchContract.runtimeContract) return;
    assertWorkerRuntimeIntegrity(
      this.launchContract.environment as NodeJS.ProcessEnv,
      this.launchContract.runtimeContract,
    );
  }

  private async sendRequestOnGeneration<T extends WorkerResult>(
    generation: WorkerGeneration,
    request: WorkerRequest,
    timeoutMs?: number,
  ): Promise<T> {
    return await new Promise<T>((resolveRequest, rejectRequest) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const clearRequestTimeout = () => {
        if (!timeout) return;
        clearTimeout(timeout);
        timeout = null;
      };
      const pending: PendingRequest = {
        kind: 'request',
        resolve: (value) => {
          clearRequestTimeout();
          resolveRequest(value as T);
        },
        reject: (error) => {
          clearRequestTimeout();
          rejectRequest(error);
        },
      };
      generation.pending.set(request.id, pending);

      if (timeoutMs) {
        timeout = setTimeout(() => {
          timeout = null;
          const error = new Error(`Hermes worker did not respond within ${timeoutMs}ms`);
          void this.retireGeneration(generation, error).catch(() => undefined);
        }, timeoutMs);
        timeout.unref();
      }

      try {
        this.write(generation, request);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        generation.pending.delete(request.id);
        pending.reject(failure);
        void this.retireGeneration(generation, failure).catch(() => undefined);
      }
    });
  }

  private async ensureGeneration(): Promise<WorkerGeneration> {
    if (this.retirementBarrier) await this.retirementBarrier;
    const current = this.generation;
    if (current && !current.terminal && current.child.exitCode === null && !current.child.killed) {
      return current;
    }

    this.validateRuntimeIntegrity();
    mkdirSync(this.launchContract.workspace, { recursive: true });
    const child = this.spawnWorker(
      this.launchContract.python,
      [...this.launchContract.arguments],
      {
        cwd: this.launchContract.workspace,
        env: { ...this.launchContract.environment },
        shell: false,
      },
    );
    let resolveTerminated: () => void = () => {};
    const terminated = new Promise<void>((resolveTermination) => {
      resolveTerminated = resolveTermination;
    });
    const generation: WorkerGeneration = {
      id: randomUUID(),
      child,
      stdout: createInterface({ input: child.stdout }),
      pending: new Map(),
      terminated,
      resolveTerminated,
      stderrPendingFragment: false,
      stderrNoticeWritten: false,
      stderrFlushed: false,
      terminal: false,
      ready: false,
      readyPromise: null,
      retiringPromise: null,
    };
    this.generation = generation;
    generation.stdout.on('line', (line) => this.handleLine(generation, line));
    child.stderr.on('data', (chunk) => this.handleStderrChunk(generation, String(chunk)));
    child.stderr.on('end', () => this.flushStderr(generation));
    child.on('error', () => this.handleProcessError(generation));
    child.on('exit', () => this.handleExit(generation));
    return generation;
  }

  private handleProcessError(generation: WorkerGeneration): void {
    if (generation.terminal) return;
    if (generation.child.pid === undefined) {
      this.handleExit(generation);
      return;
    }
    const error = new Error('Hermes worker crashed');
    this.failPending(generation, error);
    void this.retireGeneration(generation, error).catch(() => undefined);
  }

  private handleLine(generation: WorkerGeneration, line: string): void {
    let event: WorkerEvent;
    try {
      event = JSON.parse(line) as WorkerEvent;
    } catch {
      process.stderr.write('[hermes-worker] discarded non-protocol stdout\n');
      return;
    }

    const pending = generation.pending.get(event.id);
    if (!pending) return;

    if (pending.kind === 'request') {
      if (event.type === 'result') {
        generation.pending.delete(event.id);
        pending.resolve(event.data);
      } else if (event.type === 'error') {
        generation.pending.delete(event.id);
        pending.reject(new HermesWorkerError(event.error));
      }
      return;
    }

    pending.push(event);
    if (event.type === 'done') {
      generation.pending.delete(event.id);
      pending.end();
    }
  }

  private handleStderrChunk(generation: WorkerGeneration, chunk: string): void {
    if (generation.stderrFlushed) return;
    if (!chunk) return;
    generation.stderrPendingFragment = !chunk.endsWith('\n');
    if (chunk.includes('\n')) this.writeStderrNotice(generation);
  }

  private flushStderr(generation: WorkerGeneration): void {
    if (generation.stderrFlushed) return;
    generation.stderrFlushed = true;
    if (generation.stderrPendingFragment) this.writeStderrNotice(generation);
    generation.stderrPendingFragment = false;
  }

  private writeStderrNotice(generation: WorkerGeneration): void {
    if (generation.stderrNoticeWritten) return;
    generation.stderrNoticeWritten = true;
    process.stderr.write('[hermes-worker] worker stderr received\n');
  }

  private handleExit(generation: WorkerGeneration): void {
    if (generation.terminal) return;
    generation.terminal = true;
    generation.ready = false;
    generation.stdout.close();
    this.flushStderr(generation);
    if (this.generation === generation) this.generation = null;
    this.failPending(generation, new Error('Hermes worker crashed'));
    generation.resolveTerminated();
  }

  private async retireGeneration(
    generation: WorkerGeneration,
    error: Error,
    signal: NodeJS.Signals = 'SIGTERM',
  ): Promise<void> {
    if (generation.retiringPromise) return await generation.retiringPromise;
    let resolveRetirement: () => void = () => {};
    let rejectRetirement: (error: unknown) => void = () => {};
    const retirement = new Promise<void>((resolve, reject) => {
      resolveRetirement = resolve;
      rejectRetirement = reject;
    });
    generation.retiringPromise = retirement;
    this.retirementBarrier = retirement;
    void this.performRetirement(generation, error, signal).then(
      resolveRetirement,
      rejectRetirement,
    );
    try {
      await retirement;
    } finally {
      if (this.retirementBarrier === retirement) this.retirementBarrier = null;
    }
  }

  private async performRetirement(
    generation: WorkerGeneration,
    error: Error,
    signal: NodeJS.Signals,
  ): Promise<void> {
    if (this.generation === generation) this.generation = null;
    generation.ready = false;
    this.failPending(generation, error);
    if (generation.terminal || generation.child.exitCode !== null) {
      this.handleExit(generation);
      await generation.terminated;
      return;
    }

    try {
      if (!generation.child.stdin.destroyed) generation.child.stdin.end();
    } catch {
      // The worker may already be exiting because the terminal delivered SIGINT.
    }
    generation.child.kill(signal);

    const graceElapsed = new Promise<void>((resolveGrace) => {
      const timer = setTimeout(resolveGrace, this.terminationGraceMs);
      timer.unref();
    });
    await Promise.race([generation.terminated, graceElapsed]);
    if (!generation.terminal) generation.child.kill('SIGKILL');
    await generation.terminated;
  }

  private write(generation: WorkerGeneration, request: WorkerRequest): void {
    if (generation.terminal || !generation.child.stdin.writable) {
      throw new Error('Hermes worker is not running');
    }
    generation.child.stdin.write(`${JSON.stringify(request)}\n`);
  }

  private failPending(generation: WorkerGeneration, error: Error): void {
    for (const [id, pending] of generation.pending) {
      if (pending.kind === 'request') pending.reject(error);
      else pending.fail(error);
      generation.pending.delete(id);
    }
  }
}

export class HermesWorkerAdapter implements AgentAdapter {
  private readonly client: HermesWorkerClient;

  constructor(options: HermesWorkerAdapterOptions = {}) {
    this.client = new HermesWorkerClient(options);
  }

  async start(): Promise<void> {
    await this.client.start();
  }

  async stop(): Promise<void> {
    await this.client.stop();
  }

  async chat(
    sessionId: string,
    message: string,
    options?: AgentRunOptions,
  ): Promise<{ text: string; sessionId: string }> {
    let text = '';
    let resolvedSessionId = sessionId;
    let error: string | null = null;
    let errorCode: string | undefined;

    for await (const event of this.chatStream(sessionId, message, options)) {
      if (event.type === 'text_delta') text += event.content ?? '';
      if (event.type === 'done' && event.sessionId) resolvedSessionId = event.sessionId;
      if (event.type === 'error') {
        error = event.error ?? 'Hermes worker error';
        errorCode = event.code;
      }
    }

    if (error) {
      const err = new Error(error);
      if (errorCode) Object.assign(err, { code: errorCode });
      throw err;
    }
    return { text, sessionId: resolvedSessionId };
  }

  async *chatStream(
    sessionId: string,
    message: string,
    options?: AgentRunOptions,
  ): AsyncIterable<StreamEvent> {
    for await (const event of this.client.stream({
      type: 'chat',
      sessionId,
      message,
      systemMessage: options?.systemMessage,
      settings: options?.settings ?? {},
      taskId: options?.task?.id,
      taskTitle: options?.task?.title ?? null,
    })) {
      switch (event.type) {
        case 'text_delta':
          yield { type: 'text_delta', content: event.content ?? '' };
          break;
        case 'thinking_delta':
          yield { type: 'thinking_delta', content: event.content ?? '' };
          break;
        case 'tool_progress':
          yield {
            type: 'tool_progress',
            tool: event.tool ?? 'tool',
            status: event.status ?? 'running',
            duration: event.duration,
            label: event.label ?? undefined,
          };
          break;
        case 'error':
          const safeError = new HermesWorkerError(event.error);
          yield { type: 'error', error: safeError.message, code: safeError.code };
          break;
        case 'done':
          yield { type: 'done', sessionId: event.sessionId ?? sessionId, context: event.context, interrupted: event.interrupted };
          break;
        case 'result':
          break;
      }
    }
  }

  async interruptChat(sessionId: string, reason?: string): Promise<boolean> {
    const result = await this.client.request<{ interrupted: boolean }>({
      type: 'chat.interrupt',
      sessionId,
      taskId: sessionId,
      reason,
    }, WORKER_INTERRUPT_TIMEOUT_MS);
    return result.interrupted;
  }

  async healthCheck(): Promise<boolean> {
    try {
      this.client.validateRuntimeIntegrity();
      await this.client.start();
      return true;
    } catch {
      return false;
    }
  }

  async getMessages(sessionId: string, taskId: string): Promise<TaskMessage[]> {
    const result = await this.client.request<{ messages: TaskMessage[] }>({
      type: 'session.messages.get',
      sessionId,
      taskId,
    });
    return result.messages;
  }

  async getSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
    const result = await this.client.request<{ session: SessionMetadata | null }>({
      type: 'session.get',
      sessionId,
    });
    return result.session;
  }

  async getDefaults(): Promise<AgentDefaults> {
    return await this.client.request<AgentDefaults>('settings.get');
  }

  async setDefaults(updates: { provider?: string | null; model?: string | null; reasoningEffort?: string | null }): Promise<AgentDefaults> {
    return await this.client.request<AgentDefaults>({
      type: 'settings.set',
      ...updates,
    });
  }

  async getModels(): Promise<AgentModelsResponse> {
    return await this.client.request<AgentModelsResponse>('models.list');
  }

  async getRuntimeDiagnostic(timeoutMs?: number): Promise<WorkerRuntimeStatus> {
    return await this.client.request<WorkerRuntimeStatus>('runtime.status', timeoutMs);
  }

  async listScheduledTasks(includeDisabled = false, limit = 100): Promise<ScheduledTask[]> {
    const result = await this.client.request<{ scheduledTasks: ScheduledTask[] }>({
      type: 'scheduledTasks.list',
      includeDisabled,
      limit,
    });
    return result.scheduledTasks;
  }

  async getScheduledTask(scheduledTaskId: string): Promise<ScheduledTask | null> {
    const result = await this.client.request<{ scheduledTask: ScheduledTask | null }>({
      type: 'scheduledTasks.get',
      scheduledTaskId,
    });
    return result.scheduledTask;
  }

  async createScheduledTask(input: ScheduledTaskInput): Promise<ScheduledTask> {
    const result = await this.client.request<{ scheduledTask: ScheduledTask }>({
      type: 'scheduledTasks.create',
      ...input,
    });
    return result.scheduledTask;
  }

  async updateScheduledTask(scheduledTaskId: string, updates: Partial<ScheduledTaskInput>): Promise<ScheduledTask | null> {
    const result = await this.client.request<{ scheduledTask: ScheduledTask | null }>({
      type: 'scheduledTasks.update',
      scheduledTaskId,
      ...updates,
    });
    return result.scheduledTask;
  }

  async pauseScheduledTask(scheduledTaskId: string, reason?: string): Promise<ScheduledTask | null> {
    const result = await this.client.request<{ scheduledTask: ScheduledTask | null }>({
      type: 'scheduledTasks.pause',
      scheduledTaskId,
      reason,
    });
    return result.scheduledTask;
  }

  async resumeScheduledTask(scheduledTaskId: string): Promise<ScheduledTask | null> {
    const result = await this.client.request<{ scheduledTask: ScheduledTask | null }>({
      type: 'scheduledTasks.resume',
      scheduledTaskId,
    });
    return result.scheduledTask;
  }

  async runScheduledTask(scheduledTaskId: string, dispatchToken?: string): Promise<{
    scheduledTask: ScheduledTask | null;
    dispatchReceipt: ScheduledTaskDispatchReceipt | null;
  }> {
    const result = await this.client.request<{
      scheduledTask: ScheduledTask | null;
      dispatchReceipt?: ScheduledTaskDispatchReceipt;
    }>({
      type: 'scheduledTasks.run',
      scheduledTaskId,
      dispatchToken,
    });
    return { scheduledTask: result.scheduledTask, dispatchReceipt: result.dispatchReceipt ?? null };
  }

  async getScheduledTaskDispatchReceipt(
    scheduledTaskId: string,
    dispatchToken: string,
  ): Promise<ScheduledTaskDispatchReceipt | null> {
    const result = await this.client.request<{ dispatchReceipt: ScheduledTaskDispatchReceipt | null }>({
      type: 'scheduledTasks.dispatchReceipt.get',
      scheduledTaskId,
      dispatchToken,
    });
    return result.dispatchReceipt;
  }

  async removeScheduledTask(scheduledTaskId: string): Promise<boolean> {
    const result = await this.client.request<{ ok: boolean }>({
      type: 'scheduledTasks.remove',
      scheduledTaskId,
    });
    return result.ok;
  }

  async tickScheduledTasks(): Promise<number> {
    const result = await this.client.request<{ executed: number }>({ type: 'scheduledTasks.tick' });
    return result.executed;
  }

  async generateTitle(description: string): Promise<{ title: string }> {
    return await this.client.request<{ title: string }>({
      type: 'title.generate',
      description,
    });
  }

  async compressSession(
    sessionId: string,
    options?: {
      focusTopic?: string | null;
      currentTokens?: number | null;
      systemMessage?: string;
      settings?: AgentRunSettings;
    },
  ): Promise<CompactResult> {
    return await this.client.request<CompactResult>({
      type: 'session.compress',
      sessionId,
      focusTopic: options?.focusTopic,
      currentTokens: options?.currentTokens,
      systemMessage: options?.systemMessage,
      settings: options?.settings,
    });
  }

  async getGoalStatus(sessionId: string): Promise<GoalStateSnapshot | null> {
    const result = await this.client.request<{ goal: GoalStateSnapshot | null }>({
      type: 'goal.status',
      sessionId,
    });
    return result.goal;
  }

  async setGoal(
    sessionId: string,
    goal: string,
    options?: { maxTurns?: number | null },
  ): Promise<GoalStateSnapshot> {
    const result = await this.client.request<{ goal: GoalStateSnapshot | null }>({
      type: 'goal.set',
      sessionId,
      goal,
      maxTurns: options?.maxTurns,
    });
    if (!result.goal) throw new Error('Hermes did not return goal state');
    return result.goal;
  }

  async pauseGoal(sessionId: string, reason?: string): Promise<GoalStateSnapshot | null> {
    const result = await this.client.request<{ goal: GoalStateSnapshot | null }>({
      type: 'goal.pause',
      sessionId,
      reason,
    });
    return result.goal;
  }

  async resumeGoal(sessionId: string): Promise<GoalStateSnapshot | null> {
    const result = await this.client.request<{ goal: GoalStateSnapshot | null }>({
      type: 'goal.resume',
      sessionId,
    });
    return result.goal;
  }

  async clearGoal(sessionId: string): Promise<boolean> {
    const result = await this.client.request<{ cleared: boolean }>({
      type: 'goal.clear',
      sessionId,
    });
    return result.cleared;
  }

  async evaluateGoal(sessionId: string, responseText: string): Promise<GoalDecision> {
    return await this.client.request<GoalDecision>({
      type: 'goal.evaluate',
      sessionId,
      responseText,
    });
  }
}
