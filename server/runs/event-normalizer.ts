import type { StreamEvent } from '../adapters/types.js';
import type { MissionRun, RunEventType } from '../../shared/types.js';

export interface NormalizedRunEvent {
  readonly type: RunEventType;
  readonly payload: Readonly<Record<string, unknown>>;
}

function definedPayload(entries: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
}

export function normalizeHermesEvent(
  _run: MissionRun,
  event: StreamEvent,
): NormalizedRunEvent {
  switch (event.type) {
    case 'text_delta':
    case 'thinking_delta':
      return {
        type: 'run.heartbeat',
        payload: definedPayload({ kind: event.type, content: event.content }),
      };
    case 'tool_progress':
      const status = event.status ?? 'running';
      return {
        type: status === 'running' ? 'tool.started' : 'tool.completed',
        payload: definedPayload({
          tool: event.tool ?? 'tool',
          status,
          duration: event.duration,
          label: event.label,
        }),
      };
    case 'done':
      return {
        type: event.interrupted ? 'run.cancelled' : 'run.completed',
        payload: definedPayload({
          sessionId: event.sessionId,
          context: event.context,
          interrupted: event.interrupted,
        }),
      };
    case 'error':
      return {
        type: 'run.failed',
        payload: definedPayload({ code: event.code, error: event.error ?? 'Unknown error' }),
      };
  }
}
