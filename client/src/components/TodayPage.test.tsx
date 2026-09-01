// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MissionRun, Task, TaskRunState } from '@shared/types';
import { activityFreshness } from '../hooks/useFreshnessClock';
import { applyBoardEvent } from '../hooks/useTasks';
import { useStore } from '../lib/store';
import { MissionPulseRail, TodayPage } from './TodayPage';

const { fetchMessages, fetchRuntime } = vi.hoisted(() => ({
  fetchMessages: vi.fn(),
  fetchRuntime: vi.fn(),
}));

vi.mock('../lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/api')>(),
  fetchMessages,
  fetchRuntime,
}));

const TASK: Task = {
  id: 'mission-live', title: 'Réparer le déploiement', description: null, status: 'in_progress',
  agent_model: 'gpt-5.6-sol', agent_provider: 'openai-codex', reasoning_effort: 'high',
  created_at: 100, updated_at: 100, last_agent_response_at: null, last_viewed_at: null,
  last_context_used_tokens: null, last_context_window_tokens: null,
};

const SECOND_TASK: Task = {
  ...TASK,
  id: 'mission-sibling',
  title: 'Préparer la revue',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function run(status: MissionRun['status'], lastActivityAt = 100): MissionRun {
  return {
    id: `run-${status}`, missionId: TASK.id, sessionId: 'session', sessionConfirmedAt: 100,
    attempt: 1, provider: 'openai-codex', model: 'gpt-5.6-sol', reasoningEffort: 'high', status,
    startedAt: 100, lastActivityAt, finishedAt: null, finishReason: null, previousRunId: null,
  };
}

beforeEach(() => {
  fetchRuntime.mockResolvedValue({
    provider: 'openai-codex', profileId: 'etienne-openai', authState: 'connected',
    checkedAt: '2026-09-01T10:00:00.000Z', models: [],
  });
  fetchMessages.mockReset();
  useStore.setState({
    tasks: [TASK], tasksLoaded: true, taskRuns: new Map(),
    missionHistories: new Map([[TASK.id, { runs: [run('completed')], events: [], revision: 0 }]]),
    missionHistoryRevisions: new Map([[TASK.id, 0]]),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('historique live', () => {
  it('recharge une fois après task_run_updated et reclassifie la mission', async () => {
    fetchMessages.mockResolvedValue({ messages: [], context: null, runs: [run('blocked')], events: [] });
    render(<MemoryRouter><TodayPage /></MemoryRouter>);
    expect(screen.getByRole('link', { name: /Suivre/ })).toBeVisible();

    const liveRun: TaskRunState = {
      taskId: TASK.id, runId: 'run-blocked', kind: 'chat', status: 'error', startedAt: 100, updatedAt: 200,
    };
    act(() => applyBoardEvent({ type: 'task_run_updated', run: liveRun }));

    expect(await screen.findByRole('link', { name: /Débloquer/ })).toBeVisible();
    await waitFor(() => expect(fetchMessages).toHaveBeenCalledTimes(1));
  });

  it('termine chaque recharge du batch quand une réponse sœur met le store à jour', async () => {
    const first = deferred<{ messages: []; context: null; runs: MissionRun[]; events: [] }>();
    const second = deferred<{ messages: []; context: null; runs: MissionRun[]; events: [] }>();
    fetchMessages.mockImplementation((taskId: string) => (
      taskId === TASK.id ? first.promise : second.promise
    ));
    useStore.setState({
      tasks: [TASK, SECOND_TASK],
      missionHistories: new Map(),
      missionHistoryRevisions: new Map([[TASK.id, 0], [SECOND_TASK.id, 0]]),
    });

    render(<MemoryRouter><TodayPage /></MemoryRouter>);
    await waitFor(() => expect(fetchMessages).toHaveBeenCalledTimes(2));

    await act(async () => first.resolve({ messages: [], context: null, runs: [run('completed')], events: [] }));
    await act(async () => second.resolve({
      messages: [], context: null,
      runs: [{ ...run('blocked'), id: 'run-sibling', missionId: SECOND_TASK.id }],
      events: [],
    }));

    await waitFor(() => expect(useStore.getState().missionHistories.has(SECOND_TASK.id)).toBe(true));
    expect(fetchMessages).toHaveBeenCalledTimes(2);
  });
});

describe('fraîcheur du pulse rail', () => {
  it.each([
    [14 * 60_000 + 59_999, 'fresh'],
    [15 * 60_000, 'warm'],
    [44 * 60_000 + 59_999, 'warm'],
    [45 * 60_000, 'stale'],
    [null, 'stale'],
  ] as const)('classe la frontière %s en %s', (age, expected) => {
    const now = 10_000_000;
    expect(activityFreshness(age === null ? null : now - age, now)).toBe(expected);
  });

  it('rend la fraîcheur accessible sur chaque repère', () => {
    const now = 10_000_000;
    render(
      <MemoryRouter>
        <MissionPulseRail missions={[{ task: TASK, run: run('running', now - 15 * 60_000), live: true, priority: 'running' }]} now={now} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: /activité tiède/ })).toHaveAttribute('data-freshness', 'warm');
  });

  it('vieillit automatiquement aux seuils de quinze et quarante-cinq minutes', async () => {
    vi.useFakeTimers();
    const now = 10_000_000;
    vi.setSystemTime(now);
    useStore.setState({
      missionHistories: new Map([[TASK.id, { runs: [run('running', now - FIFTEEN_MINUTES_PLUS_ONE_SECOND)], events: [], revision: 0 }]]),
    });

    render(<MemoryRouter><TodayPage /></MemoryRouter>);
    const pulse = screen.getByRole('link', { name: /activité récente/ });
    expect(pulse).toHaveAttribute('data-freshness', 'fresh');

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(pulse).toHaveAttribute('data-freshness', 'warm');

    await act(async () => vi.advanceTimersByTimeAsync(30 * 60_000));
    expect(pulse).toHaveAttribute('data-freshness', 'stale');
  });
});

const FIFTEEN_MINUTES_PLUS_ONE_SECOND = 15 * 60_000 - 1_000;
