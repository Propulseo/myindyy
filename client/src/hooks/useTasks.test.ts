// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '@shared/types';
import { useStore } from '../lib/store';
import { applyBoardEvent, applyTaskSnapshot, captureTaskSnapshot } from './useTasks';

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

  it('ne remplace pas une mise à jour SSE arrivée pendant le snapshot HTTP', async () => {
    const baseline = captureTaskSnapshot();
    const pending = deferred<Task[]>();
    const applying = pending.promise.then((tasks) => applyTaskSnapshot(tasks, baseline));
    const liveTask = { ...TASK, status: 'in_review' as const, updated_at: 300 };

    applyBoardEvent({ type: 'task_updated', task: liveTask });
    pending.resolve([{ ...TASK, updated_at: 200 }]);
    await applying;

    expect(useStore.getState().tasks).toEqual([liveTask]);
  });

  it('conserve last_agent_response_at quand ce signal SSE progresse seul', () => {
    const baseline = captureTaskSnapshot();
    const liveTask = { ...TASK, last_agent_response_at: 300 };

    applyBoardEvent({ type: 'task_updated', task: liveTask });
    applyTaskSnapshot([TASK], baseline);

    expect(useStore.getState().tasks).toEqual([liveTask]);
  });

  it('préserve une mission créée par SSE après le début du snapshot', () => {
    const baseline = captureTaskSnapshot();
    const created = { ...TASK, id: 'mission-created', title: 'Mission créée', updated_at: 200 };

    applyBoardEvent({ type: 'task_created', task: created });
    applyTaskSnapshot([TASK], baseline);

    expect(useStore.getState().tasks).toContainEqual(created);
  });

  it('préserve une suppression SSE face à une réponse HTTP plus ancienne', () => {
    const baseline = captureTaskSnapshot();

    applyBoardEvent({ type: 'task_deleted', taskId: TASK.id });
    applyTaskSnapshot([TASK], baseline);

    expect(useStore.getState().tasks).toEqual([]);
  });

  it('retire une mission absente d’un snapshot autoritaire sans mutation concurrente', () => {
    const baseline = captureTaskSnapshot();

    applyTaskSnapshot([], baseline);

    expect(useStore.getState().tasks).toEqual([]);
  });

  it('ne ressuscite pas une mission inconnue supprimée par SSE pendant le snapshot', () => {
    useStore.setState({ tasks: [] });
    const baseline = captureTaskSnapshot();

    applyBoardEvent({ type: 'task_deleted', taskId: TASK.id });
    applyTaskSnapshot([TASK], baseline);

    expect(useStore.getState().tasks).toEqual([]);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
