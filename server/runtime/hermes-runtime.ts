import type {
  AgentDefaults,
  AgentModelGroup,
  CompactResult,
  ReasoningEffort,
  ScheduledTask,
  ScheduledTaskInput,
} from '../../shared/types.js';
import type { AgentRunOptions, AgentRunSettings, StreamEvent } from '../adapters/types.js';
import { HermesWorkerAdapter } from '../adapters/hermes-worker.js';
import type { RuntimeAuthState } from '../adapters/worker-protocol.js';
import { assertAllowedRuntime, RuntimePolicyError } from './policy.js';
import type { RuntimeSessionInspection } from '../runs/reconcile.js';
import { REASONING_EFFORTS } from '../../shared/types.js';

export interface RuntimeModel {
  id: string;
  label: string;
  reasoningEfforts: ReasoningEffort[] | null;
}

export interface RuntimeStatus {
  provider: 'openai-codex';
  profileId: string | null;
  authState: RuntimeAuthState;
  checkedAt: string;
  models: RuntimeModel[];
}

type RuntimeCatalogGroup = Omit<AgentModelGroup, 'models'> & {
  models: Array<AgentModelGroup['models'][number] & { reasoningEfforts?: unknown }>;
};

export function filterOAuthModels(groups: readonly RuntimeCatalogGroup[]): RuntimeModel[] {
  const oauthGroup = groups.find((group) => group.provider === 'openai-codex');
  if (!oauthGroup) return [];

  return oauthGroup.models.flatMap((model) => {
    if (typeof model.id !== 'string' || !model.id.trim()) return [];
    const efforts = Array.isArray(model.reasoningEfforts)
      ? model.reasoningEfforts.filter((effort): effort is ReasoningEffort => (
        typeof effort === 'string'
        && (REASONING_EFFORTS as readonly string[]).includes(effort)
      ))
      : null;
    return [{
      id: model.id.trim(),
      label: typeof model.label === 'string' && model.label.trim() ? model.label.trim() : model.id.trim(),
      reasoningEfforts: efforts,
    }];
  });
}

function runtimeOptions(options?: AgentRunOptions): AgentRunOptions {
  return {
    ...options,
    settings: assertAllowedRuntime(options?.settings ?? {}),
  };
}

function scheduledTaskSettings(input: Pick<ScheduledTaskInput, 'provider' | 'model' | 'reasoningEffort'>): AgentRunSettings {
  return { provider: input.provider, model: input.model, reasoningEffort: input.reasoningEffort };
}

export class HermesOAuthRuntime extends HermesWorkerAdapter {
  private readonly activeSessions = new Map<string, number>();
  private readonly completedSessions = new Set<string>();

  async getRuntimeStatus(): Promise<RuntimeStatus> {
    const diagnostic = await super.getRuntimeDiagnostic();
    const providerMatches = diagnostic.provider === 'openai-codex';
    const authState = providerMatches ? diagnostic.authState : 'error';
    return {
      provider: 'openai-codex',
      profileId: providerMatches && typeof diagnostic.profileId === 'string'
        ? diagnostic.profileId
        : null,
      authState,
      checkedAt: typeof diagnostic.checkedAt === 'string'
        ? diagnostic.checkedAt
        : new Date().toISOString(),
      models: providerMatches && authState === 'connected'
        ? filterOAuthModels([{ provider: diagnostic.provider, models: diagnostic.models.map((model) => ({
          ...model,
          source: 'catalog' as const,
          provider: diagnostic.provider,
        })) }])
        : [],
    };
  }

  async chat(sessionId: string, message: string, options?: AgentRunOptions): Promise<{ text: string; sessionId: string }> {
    return await super.chat(sessionId, message, runtimeOptions(options));
  }

  async *chatStream(sessionId: string, message: string, options?: AgentRunOptions): AsyncIterable<StreamEvent> {
    this.activeSessions.set(sessionId, (this.activeSessions.get(sessionId) ?? 0) + 1);
    this.completedSessions.delete(sessionId);
    try {
      for await (const event of super.chatStream(sessionId, message, runtimeOptions(options))) {
        if (event.type === 'done' && event.interrupted !== true) {
          this.completedSessions.add(sessionId);
          if (event.sessionId) this.completedSessions.add(event.sessionId);
        }
        yield event;
      }
    } finally {
      const remaining = (this.activeSessions.get(sessionId) ?? 1) - 1;
      if (remaining === 0) this.activeSessions.delete(sessionId);
      else this.activeSessions.set(sessionId, remaining);
    }
  }

  async inspectSession(sessionId: string): Promise<RuntimeSessionInspection> {
    if ((this.activeSessions.get(sessionId) ?? 0) > 0) {
      return { state: 'active', processActive: true };
    }
    if (this.completedSessions.has(sessionId)) {
      return { state: 'completed', processActive: false };
    }

    const session = await this.getSessionMetadata(sessionId);
    return session
      ? { state: 'unknown', processActive: false }
      : { state: 'missing', processActive: false };
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
    return await super.compressSession(sessionId, {
      ...options,
      settings: assertAllowedRuntime(options?.settings ?? {}),
    });
  }

  async setDefaults(updates: { provider?: string | null; model?: string | null; reasoningEffort?: string | null }): Promise<AgentDefaults> {
    const current = await super.getDefaults();
    const settings = assertAllowedRuntime({
      provider: updates.provider === undefined ? current.provider : updates.provider,
      model: updates.model === undefined ? current.model : updates.model,
      reasoningEffort: updates.reasoningEffort === undefined ? current.reasoningEffort : updates.reasoningEffort as AgentRunSettings['reasoningEffort'],
    });
    return await super.setDefaults(settings);
  }

  async createScheduledTask(input: ScheduledTaskInput): Promise<ScheduledTask> {
    assertAllowedRuntime(scheduledTaskSettings(input));
    return await super.createScheduledTask(input);
  }

  async updateScheduledTask(scheduledTaskId: string, updates: Partial<ScheduledTaskInput>): Promise<ScheduledTask | null> {
    const current = await super.getScheduledTask(scheduledTaskId);
    if (!current) return null;

    assertAllowedRuntime({
      provider: updates.provider === undefined ? current.provider : updates.provider,
      model: updates.model === undefined ? current.model : updates.model,
      reasoningEffort: updates.reasoningEffort === undefined ? current.reasoningEffort : updates.reasoningEffort,
    });
    return await super.updateScheduledTask(scheduledTaskId, updates);
  }

  async resumeScheduledTask(scheduledTaskId: string): Promise<ScheduledTask | null> {
    const scheduledTask = await super.getScheduledTask(scheduledTaskId);
    if (!scheduledTask) return null;
    assertAllowedRuntime({ provider: scheduledTask.provider, model: scheduledTask.model, reasoningEffort: scheduledTask.reasoningEffort });
    return await super.resumeScheduledTask(scheduledTaskId);
  }

  async runScheduledTask(scheduledTaskId: string): Promise<ScheduledTask | null> {
    const scheduledTask = await super.getScheduledTask(scheduledTaskId);
    if (!scheduledTask) return null;
    assertAllowedRuntime({ provider: scheduledTask.provider, model: scheduledTask.model, reasoningEffort: scheduledTask.reasoningEffort });
    return await super.runScheduledTask(scheduledTaskId);
  }

  async tickScheduledTasks(): Promise<number> {
    const scheduledTasks = await super.listScheduledTasks(false);
    for (const scheduledTask of scheduledTasks) {
      assertAllowedRuntime({ provider: scheduledTask.provider, model: scheduledTask.model, reasoningEffort: scheduledTask.reasoningEffort });
    }
    return await super.tickScheduledTasks();
  }

  async generateTitle(_description: string): Promise<{ title: string }> {
    throw new RuntimePolicyError('LLM task title generation is disabled');
  }
}
