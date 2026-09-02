import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REASONING_EFFORTS, type ReasoningEffort } from '../../shared/types.js';
import { resolveHermesHome } from '../paths.js';

export type HermesTerminalStatus = 'completed' | 'failed' | 'unknown';

export interface ScheduledTaskOccurrenceProvenance {
  readonly source: 'indy-hermes-run-job-hook';
  readonly evidence: 'cron.executions';
  readonly originalHermesStatus: HermesTerminalStatus | null;
  readonly startedAtEvidence: 'claimed_at' | 'started_at' | null;
}

export interface ScheduledTaskOccurrenceManifest {
  readonly schemaVersion: 1;
  readonly hermesRunId: string;
  readonly scheduledTaskId: string;
  readonly scheduledTaskName: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: 'completed' | 'failed';
  readonly hermesStatus: HermesTerminalStatus;
  readonly provenance: ScheduledTaskOccurrenceProvenance | null;
  readonly error: string | null;
  readonly outputRef: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort | null;
  readonly workdir: string | null;
  readonly dispatchToken: string | null;
  readonly manifestPath: string;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

type ProvenanceParseResult =
  | { readonly ok: true; readonly value: ScheduledTaskOccurrenceProvenance | null }
  | { readonly ok: false };

function parseProvenance(value: unknown, hermesStatus: HermesTerminalStatus): ProvenanceParseResult {
  if (value === undefined) return hermesStatus === 'unknown' ? { ok: false } : { ok: true, value: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  const raw = value as Record<string, unknown>;
  const allowedKeys = new Set(['source', 'evidence', 'originalHermesStatus', 'startedAtEvidence']);
  if (Object.keys(raw).some((key) => !allowedKeys.has(key))) return { ok: false };
  if (raw.source !== 'indy-hermes-run-job-hook' || raw.evidence !== 'cron.executions') return { ok: false };
  const originalHermesStatus = text(raw.originalHermesStatus);
  const startedAtEvidence = text(raw.startedAtEvidence);
  if ((originalHermesStatus === null) !== (startedAtEvidence === null)) return { ok: false };
  if (originalHermesStatus !== null
    && (!['completed', 'failed', 'unknown'].includes(originalHermesStatus) || originalHermesStatus !== hermesStatus)) {
    return { ok: false };
  }
  if (startedAtEvidence !== null && startedAtEvidence !== 'claimed_at' && startedAtEvidence !== 'started_at') {
    return { ok: false };
  }
  if (hermesStatus === 'unknown' && (originalHermesStatus !== 'unknown' || startedAtEvidence === null)) {
    return { ok: false };
  }
  return {
    ok: true,
    value: {
      source: 'indy-hermes-run-job-hook',
      evidence: 'cron.executions',
      originalHermesStatus: originalHermesStatus as HermesTerminalStatus | null,
      startedAtEvidence: startedAtEvidence as ScheduledTaskOccurrenceProvenance['startedAtEvidence'],
    },
  };
}

function parseManifest(value: unknown, manifestPath: string): ScheduledTaskOccurrenceManifest | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) return null;
  const hermesRunId = text(raw.hermesRunId);
  const scheduledTaskId = text(raw.scheduledTaskId);
  const scheduledTaskName = text(raw.scheduledTaskName);
  const startedAt = text(raw.startedAt);
  const finishedAt = text(raw.finishedAt);
  const outputRef = text(raw.outputRef);
  const provider = text(raw.provider);
  const model = text(raw.model);
  const workdir = text(raw.workdir);
  const effort = text(raw.reasoningEffort);
  const hermesStatus = text(raw.hermesStatus) ?? text(raw.status);
  const started = startedAt ? Date.parse(startedAt) : NaN;
  const finished = finishedAt ? Date.parse(finishedAt) : NaN;
  if (!hermesRunId || !scheduledTaskId || !scheduledTaskName || !startedAt || !finishedAt
    || !outputRef || !provider || !model || !Number.isFinite(started) || !Number.isFinite(finished)
    || finished < started || (raw.status !== 'completed' && raw.status !== 'failed')
    || !hermesStatus || !['completed', 'failed', 'unknown'].includes(hermesStatus)) return null;
  if ((raw.status === 'completed') !== (hermesStatus === 'completed')) return null;
  if (effort !== null && !REASONING_EFFORTS.includes(effort as ReasoningEffort)) return null;
  const provenance = parseProvenance(raw.provenance, hermesStatus as HermesTerminalStatus);
  if (!provenance.ok) return null;
  return {
    schemaVersion: 1,
    hermesRunId,
    scheduledTaskId,
    scheduledTaskName,
    startedAt,
    finishedAt,
    status: raw.status,
    hermesStatus: hermesStatus as HermesTerminalStatus,
    provenance: provenance.value,
    error: text(raw.error),
    outputRef,
    provider,
    model,
    reasoningEffort: effort as ReasoningEffort | null,
    workdir,
    dispatchToken: text(raw.dispatchToken),
    manifestPath,
  };
}

export function resolveScheduledTaskManifestDir(): string {
  return join(resolveHermesHome(), 'cron', 'indy-manifests');
}

export async function listScheduledTaskOccurrenceManifests(
  root = resolveScheduledTaskManifestDir(),
): Promise<ScheduledTaskOccurrenceManifest[]> {
  let taskEntries;
  try { taskEntries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const paths: string[] = [];
  for (const taskEntry of taskEntries) {
    if (!taskEntry.isDirectory()) continue;
    const taskDir = join(root, taskEntry.name);
    let entries;
    try { entries = await readdir(taskDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.output.json') && !entry.name.endsWith('.tmp')) {
        paths.push(join(taskDir, entry.name));
      }
    }
  }
  const manifests = await Promise.all(paths.sort().map(async (path) => {
    try { return parseManifest(JSON.parse(await readFile(path, 'utf8')), path); } catch { return null; }
  }));
  return manifests.filter((value): value is ScheduledTaskOccurrenceManifest => value !== null);
}
