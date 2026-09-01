// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MissionRun, Task } from '@shared/types';
import { useStore } from '../lib/store';
import { TaskDetailPage } from './TaskDetailPage';

const { fetchMessages, fetchRuntime } = vi.hoisted(() => ({
  fetchMessages: vi.fn(),
  fetchRuntime: vi.fn(),
}));

vi.mock('../lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/api')>(),
  fetchMessages,
  fetchRuntime,
}));
vi.mock('./TaskChat', () => ({ TaskChat: () => null }));
vi.mock('./MissionWorkspace', () => ({ MissionWorkspace: ({ execution }: { execution: React.ReactNode }) => <div>{execution}</div> }));
vi.mock('./RuntimeBadge', () => ({ RuntimeBadge: () => null }));
vi.mock('./RunControls', () => ({ RunControls: () => null }));
vi.mock('./RunTimeline', () => ({ RunTimeline: () => null }));
vi.mock('./RenameTitle', () => ({ RenameReveal: () => null, useRenameAnimation: () => ({ isAnimating: false }) }));

const TASK_A: Task = {
  id: 'mission-a', title: 'Mission A', description: null, status: 'in_progress',
  agent_model: null, agent_provider: null, reasoning_effort: null,
  created_at: 100, updated_at: 100, last_agent_response_at: null, last_viewed_at: null,
  last_context_used_tokens: null, last_context_window_tokens: null,
};
const TASK_B: Task = { ...TASK_A, id: 'mission-b', title: 'Mission B' };

function deferred() {
  let resolve!: (value: { messages: []; context: null; runs: MissionRun[]; events: [] }) => void;
  const promise = new Promise<{ messages: []; context: null; runs: MissionRun[]; events: [] }>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function Navigator() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('/tasks/mission-b')}>Mission B</button>;
}

beforeEach(() => {
  fetchMessages.mockReset();
  fetchRuntime.mockResolvedValue({ provider: 'openai-codex', profileId: 'etienne-openai', authState: 'connected', checkedAt: '', models: [] });
  useStore.setState({
    tasks: [TASK_A, TASK_B], tasksLoaded: true,
    missionHistories: new Map(),
    missionHistoryRevisions: new Map([[TASK_A.id, 0], [TASK_B.id, 0]]),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('historique de mission', () => {
  it('charge la nouvelle mission quand elle partage la même révision que la précédente', async () => {
    const first = deferred();
    const second = deferred();
    fetchMessages.mockImplementation((taskId: string) => taskId === TASK_A.id ? first.promise : second.promise);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/tasks/mission-a']}>
        <Navigator />
        <Routes><Route path="/tasks/:taskId" element={<TaskDetailPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(fetchMessages).toHaveBeenCalledWith(TASK_A.id));

    await user.click(screen.getByRole('button', { name: 'Mission B' }));
    await waitFor(() => expect(fetchMessages).toHaveBeenCalledWith(TASK_B.id));

    await act(async () => second.resolve({ messages: [], context: null, runs: [], events: [] }));
    await act(async () => first.resolve({ messages: [], context: null, runs: [], events: [] }));
    expect(fetchMessages).toHaveBeenCalledTimes(2);
  });
});
