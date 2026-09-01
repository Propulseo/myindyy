// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '@shared/types';
import { useStore } from '../lib/store';
import { applyTaskSnapshot } from './useTasks';

const TASK: Task = {
  id: 'mission-reconnect', title: 'Mission déconnectée', description: null, status: 'in_progress',
  agent_model: 'gpt-5.6-sol', agent_provider: 'openai-codex', reasoning_effort: 'high',
  created_at: 100, updated_at: 100, last_agent_response_at: null, last_viewed_at: null,
  last_context_used_tokens: null, last_context_window_tokens: null,
};

beforeEach(() => {
  useStore.setState({
    tasks: [TASK], tasksLoaded: true,
    missionHistories: new Map([[TASK.id, { runs: [], events: [], revision: 0 }]]),
    missionHistoryRevisions: new Map([[TASK.id, 0]]),
  });
});

describe('applyTaskSnapshot', () => {
  it('invalide l’historique quand la version serveur progresse après reconnexion', () => {
    applyTaskSnapshot([{ ...TASK, status: 'in_review', updated_at: 200 }]);

    expect(useStore.getState().missionHistoryRevisions.get(TASK.id)).toBe(1);
    expect(useStore.getState().tasks[0]?.status).toBe('in_review');
  });

  it('conserve la révision quand le snapshot serveur est identique', () => {
    applyTaskSnapshot([TASK]);

    expect(useStore.getState().missionHistoryRevisions.get(TASK.id)).toBe(0);
  });
});
