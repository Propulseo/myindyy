import { Router, type Request, type Response, type Router as ExpressRouter } from 'express';
import type { Database } from 'better-sqlite3';
import type { RuntimeStatus } from '../runtime/hermes-runtime.js';

const CATALOG_MAX_AGE_MS = 2 * 60_000;
const CATALOG_MAX_FUTURE_SKEW_MS = 30_000;
const RUNTIME_STATUS_TIMEOUT_MS = 2_000;

const REQUIRED_COLUMNS = Object.freeze({
  tasks: ['id', 'mission_kind', 'updated_at'],
  mission_runs: [
    'id', 'mission_id', 'session_id', 'session_confirmed_at', 'occurrence_key',
    'workdir', 'provenance_json', 'status', 'last_activity_at',
  ],
  run_events: ['id', 'run_id', 'type', 'occurred_at', 'payload_json'],
  operator_commands: [
    'idempotency_key', 'status', 'lease_owner', 'lease_expires_at',
    'attempt_count', 'next_attempt_at', 'payload_json', 'phase', 'effect_receipt_json',
  ],
} as const);

export interface ReadinessRuntime {
  healthCheck(): Promise<boolean>;
  getRuntimeStatus(timeoutMs?: number): Promise<RuntimeStatus>;
}

export interface HealthRouterDependencies {
  readonly database: Database;
  readonly runtime: ReadinessRuntime;
  readonly controlLoopsReady: () => boolean;
  readonly now?: () => number;
  readonly onFailure?: (reason: ReadinessFailure) => void;
  readonly runtimeStatusTimeoutMs?: number;
}

export type ReadinessFailure =
  | 'catalog-stale'
  | 'control-loops'
  | 'database-migration'
  | 'database-write'
  | 'runtime-catalog'
  | 'worker';

export class OperationalReadiness {
  private loopsReady = false;

  markControlLoopsReady(): void {
    this.loopsReady = true;
  }

  markStopping(): void {
    this.loopsReady = false;
  }

  controlLoopsReady = (): boolean => this.loopsReady;
}

export const operationalReadiness = new OperationalReadiness();

function tableColumns(database: Database, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  return new Set(rows.flatMap((row) => typeof row.name === 'string' ? [row.name] : []));
}

function migrationsAreCurrent(database: Database): boolean {
  return Object.entries(REQUIRED_COLUMNS).every(([table, required]) => {
    const columns = tableColumns(database, table);
    return required.every((column) => columns.has(column));
  });
}

function databaseAcceptsWrites(database: Database): boolean {
  const probeId = '__indy_readiness_probe__';
  database.exec('SAVEPOINT indy_readiness_probe');
  try {
    database.prepare(`
      INSERT INTO tasks (
        id, title, description, status, mission_kind,
        created_at, updated_at
      ) VALUES (?, 'readiness', NULL, 'in_progress', 'interactive', 0, 0)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
    `).run(probeId);
    database.exec('ROLLBACK TO indy_readiness_probe');
    database.exec('RELEASE indy_readiness_probe');
    return true;
  } catch {
    try {
      database.exec('ROLLBACK TO indy_readiness_probe');
      database.exec('RELEASE indy_readiness_probe');
    } catch {
      // The original write failure is the readiness signal; cleanup is best effort.
    }
    return false;
  }
}

function catalogIsReady(status: RuntimeStatus, now: number): 'ready' | 'stale' | 'unavailable' {
  if (status.provider !== 'openai-codex'
    || status.profileId !== 'etienne-openai'
    || status.authState !== 'connected'
    || status.models.length === 0
    || status.models.some((model) => !model.id.trim())) {
    return 'unavailable';
  }
  const checkedAt = Date.parse(status.checkedAt);
  if (!Number.isFinite(checkedAt)
    || checkedAt < now - CATALOG_MAX_AGE_MS
    || checkedAt > now + CATALOG_MAX_FUTURE_SKEW_MS) {
    return 'stale';
  }
  return 'ready';
}

async function runtimeStatusWithin(
  runtime: ReadinessRuntime,
  requestedTimeoutMs: number | undefined,
): Promise<RuntimeStatus> {
  const timeoutMs = Number.isFinite(requestedTimeoutMs) && (requestedTimeoutMs ?? 0) > 0
    ? Math.floor(requestedTimeoutMs as number)
    : RUNTIME_STATUS_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      runtime.getRuntimeStatus(timeoutMs),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Runtime status timed out')), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function readinessFailure(
  dependencies: HealthRouterDependencies,
): Promise<ReadinessFailure | null> {
  if (!dependencies.controlLoopsReady()) return 'control-loops';
  try {
    if (!migrationsAreCurrent(dependencies.database)) return 'database-migration';
  } catch {
    return 'database-migration';
  }
  if (!databaseAcceptsWrites(dependencies.database)) return 'database-write';
  if (!await dependencies.runtime.healthCheck()) return 'worker';
  try {
    const catalog = catalogIsReady(
      await runtimeStatusWithin(dependencies.runtime, dependencies.runtimeStatusTimeoutMs),
      (dependencies.now ?? Date.now)(),
    );
    if (catalog === 'stale') return 'catalog-stale';
    if (catalog === 'unavailable') return 'runtime-catalog';
  } catch {
    return 'runtime-catalog';
  }
  return null;
}

export function createHealthRouter(dependencies: HealthRouterDependencies): ExpressRouter {
  const router = Router();

  router.get('/live', (_request, response) => {
    response.json({ status: 'live' });
  });

  const ready = async (_request: Request, response: Response) => {
    const failure = await readinessFailure(dependencies);
    if (failure) {
      dependencies.onFailure?.(failure);
      response.status(503).json({ status: 'not-ready' });
      return;
    }
    response.json({ status: 'ready' });
  };

  router.get('/ready', ready);
  router.get('/', ready);
  return router;
}
