import { realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, relative, resolve } from 'node:path';
import type {
  ReasoningEffort,
  ScheduledTaskInput,
} from '../../shared/types.js';
import type { RuntimeStatus } from '../runtime/hermes-runtime.js';
import { expandHomePrefix, resolveMinionsWorkspaceDir } from '../paths.js';

export const SCHEDULED_TASK_PROVIDER = 'openai-codex' as const;
export const SCHEDULED_TASK_PROFILE = 'etienne-openai' as const;

export type ScheduledTaskPolicyErrorCode =
  | 'SCHEDULED_OAUTH_EXPIRED'
  | 'SCHEDULED_OAUTH_MISSING'
  | 'SCHEDULED_RUNTIME_UNAVAILABLE'
  | 'SCHEDULED_PROFILE_UNSUPPORTED'
  | 'SCHEDULED_PROVIDER_REQUIRED'
  | 'SCHEDULED_PROVIDER_UNSUPPORTED'
  | 'SCHEDULED_MODEL_REQUIRED'
  | 'SCHEDULED_MODEL_UNAVAILABLE'
  | 'SCHEDULED_EFFORT_REQUIRED'
  | 'SCHEDULED_EFFORT_UNSUPPORTED'
  | 'SCHEDULED_EFFORT_CAPABILITIES_UNAVAILABLE'
  | 'SCHEDULED_WORKDIR_REQUIRED'
  | 'SCHEDULED_WORKDIR_UNAVAILABLE'
  | 'SCHEDULED_WORKDIR_NOT_ALLOWED';

export type ScheduledTaskPolicyField = 'runtime' | 'profileId' | 'provider' | 'model' | 'reasoningEffort' | 'workdir';

export interface ScheduledTaskPolicyError {
  readonly code: ScheduledTaskPolicyErrorCode;
  readonly field: ScheduledTaskPolicyField;
  readonly message: string;
  readonly status: 400 | 409 | 503;
}

export interface ScheduledWorkdirRegistry {
  readonly roots: readonly string[];
}

export interface ResolvedScheduledTaskRuntime {
  readonly provider: typeof SCHEDULED_TASK_PROVIDER;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly workdir: string;
}

export type ScheduledTaskValidationResult =
  | { readonly ok: true; readonly value: ResolvedScheduledTaskRuntime }
  | { readonly ok: false; readonly error: ScheduledTaskPolicyError };

function failure(
  code: ScheduledTaskPolicyErrorCode,
  field: ScheduledTaskPolicyField,
  message: string,
  status: ScheduledTaskPolicyError['status'],
): ScheduledTaskValidationResult {
  return { ok: false, error: { code, field, message, status } };
}

function canonicalDirectory(path: string): string | null {
  try {
    const canonical = realpathSync.native(resolve(path));
    return statSync(canonical).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}

export function createScheduledWorkdirRegistry(roots: readonly string[]): ScheduledWorkdirRegistry {
  const canonicalRoots = roots.flatMap((root) => {
    const canonical = typeof root === 'string' && root.trim() ? canonicalDirectory(root.trim()) : null;
    return canonical ? [canonical] : [];
  });
  return { roots: [...new Set(canonicalRoots)] };
}

export function resolveScheduledWorkdirRegistry(
  environment: NodeJS.ProcessEnv = process.env,
): ScheduledWorkdirRegistry {
  const configured = environment.INDY_SCHEDULED_WORKDIRS?.split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(expandHomePrefix) ?? [];
  return createScheduledWorkdirRegistry([
    resolveMinionsWorkspaceDir(),
    ...configured,
  ]);
}

export function validateScheduledTask(
  input: Pick<ScheduledTaskInput, 'provider' | 'model' | 'reasoningEffort' | 'workdir'>,
  runtime: RuntimeStatus,
  registry: ScheduledWorkdirRegistry,
): ScheduledTaskValidationResult {
  if (runtime.authState === 'expired') {
    return failure('SCHEDULED_OAUTH_EXPIRED', 'runtime', 'La connexion Codex OAuth a expiré. Reconnectez le profil Étienne.', 409);
  }
  if (runtime.authState === 'missing') {
    return failure('SCHEDULED_OAUTH_MISSING', 'runtime', 'Codex OAuth n’est pas connecté pour le profil Étienne.', 409);
  }
  if (runtime.authState !== 'connected') {
    return failure('SCHEDULED_RUNTIME_UNAVAILABLE', 'runtime', 'Le catalogue Codex OAuth frais est indisponible.', 503);
  }
  if (runtime.profileId !== SCHEDULED_TASK_PROFILE) {
    return failure('SCHEDULED_PROFILE_UNSUPPORTED', 'profileId', 'Le profil OAuth actif doit être etienne-openai.', 409);
  }
  if (typeof input.provider !== 'string' || !input.provider.trim()) {
    return failure('SCHEDULED_PROVIDER_REQUIRED', 'provider', 'Le provider openai-codex doit être explicite.', 400);
  }
  if (input.provider !== SCHEDULED_TASK_PROVIDER) {
    return failure('SCHEDULED_PROVIDER_UNSUPPORTED', 'provider', 'Seul le provider OAuth openai-codex est autorisé.', 400);
  }

  const modelId = typeof input.model === 'string' ? input.model.trim() : '';
  if (!modelId) {
    return failure('SCHEDULED_MODEL_REQUIRED', 'model', 'Un modèle Codex explicite est requis.', 400);
  }
  const model = runtime.models.find((candidate) => candidate.id === modelId);
  if (!model) {
    return failure('SCHEDULED_MODEL_UNAVAILABLE', 'model', 'Ce modèle n’est pas disponible dans le catalogue OAuth frais.', 409);
  }

  if (!input.reasoningEffort) {
    return failure('SCHEDULED_EFFORT_REQUIRED', 'reasoningEffort', 'Un effort de raisonnement explicite est requis.', 400);
  }
  if (model.reasoningEfforts === null) {
    return failure(
      'SCHEDULED_EFFORT_CAPABILITIES_UNAVAILABLE',
      'reasoningEffort',
      'Hermes ne publie pas les efforts supportés par ce modèle; exécution refusée par sécurité.',
      409,
    );
  }
  if (!model.reasoningEfforts.includes(input.reasoningEffort)) {
    return failure('SCHEDULED_EFFORT_UNSUPPORTED', 'reasoningEffort', 'Cet effort n’est pas supporté par le modèle sélectionné.', 409);
  }

  const rawWorkdir = typeof input.workdir === 'string' ? input.workdir.trim() : '';
  if (!rawWorkdir) {
    return failure('SCHEDULED_WORKDIR_REQUIRED', 'workdir', 'Un dossier de travail enregistré côté serveur est requis.', 400);
  }
  const workdir = canonicalDirectory(rawWorkdir);
  if (!workdir) {
    return failure('SCHEDULED_WORKDIR_UNAVAILABLE', 'workdir', 'Le dossier de travail n’existe pas ou n’est pas accessible.', 400);
  }
  if (!registry.roots.some((root) => isInside(root, workdir))) {
    return failure('SCHEDULED_WORKDIR_NOT_ALLOWED', 'workdir', 'Le dossier de travail sort du registre autorisé par le serveur.', 400);
  }

  return {
    ok: true,
    value: {
      provider: SCHEDULED_TASK_PROVIDER,
      model: modelId,
      reasoningEffort: input.reasoningEffort,
      workdir,
    },
  };
}
