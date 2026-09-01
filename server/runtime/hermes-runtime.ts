import type {
  AgentDefaults,
  CompactResult,
  ScheduledTask,
  ScheduledTaskInput,
} from '../../shared/types.js';
import type { AgentRunOptions, AgentRunSettings, StreamEvent } from '../adapters/types.js';
import { HermesWorkerAdapter } from '../adapters/hermes-worker.js';
import { assertAllowedRuntime, RuntimePolicyError } from './policy.js';

function runtimeOptions(options?: AgentRunOptions): AgentRunOptions {
  return {
    ...options,
    settings: assertAllowedRuntime(options?.settings ?? {}),
  };
}

function scheduledTaskSettings(input: Pick<ScheduledTaskInput, 'provider' | 'model'>): AgentRunSettings {
  return { provider: input.provider, model: input.model };
}

export class HermesOAuthRuntime extends HermesWorkerAdapter {
  async chat(sessionId: string, message: string, options?: AgentRunOptions): Promise<{ text: string; sessionId: string }> {
    return await super.chat(sessionId, message, runtimeOptions(options));
  }

  async *chatStream(sessionId: string, message: string, options?: AgentRunOptions): AsyncIterable<StreamEvent> {
    for await (const event of super.chatStream(sessionId, message, runtimeOptions(options))) {
      yield event;
    }
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
    });
    return await super.updateScheduledTask(scheduledTaskId, updates);
  }

  async resumeScheduledTask(scheduledTaskId: string): Promise<ScheduledTask | null> {
    const scheduledTask = await super.getScheduledTask(scheduledTaskId);
    if (!scheduledTask) return null;
    assertAllowedRuntime({ provider: scheduledTask.provider, model: scheduledTask.model });
    return await super.resumeScheduledTask(scheduledTaskId);
  }

  async runScheduledTask(scheduledTaskId: string): Promise<ScheduledTask | null> {
    const scheduledTask = await super.getScheduledTask(scheduledTaskId);
    if (!scheduledTask) return null;
    assertAllowedRuntime({ provider: scheduledTask.provider, model: scheduledTask.model });
    return await super.runScheduledTask(scheduledTaskId);
  }

  async tickScheduledTasks(): Promise<number> {
    const scheduledTasks = await super.listScheduledTasks(false);
    for (const scheduledTask of scheduledTasks) {
      assertAllowedRuntime({ provider: scheduledTask.provider, model: scheduledTask.model });
    }
    return await super.tickScheduledTasks();
  }

  async generateTitle(_description: string): Promise<{ title: string }> {
    throw new RuntimePolicyError('LLM task title generation is disabled');
  }
}
