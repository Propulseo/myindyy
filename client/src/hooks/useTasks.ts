import { useEffect, useRef } from 'react';
import type { BoardEvent } from '@shared/types';
import { useStore } from '../lib/store';
import { fetchTasks } from '../lib/api';
import { playCompletionSound } from './useSoundOnComplete';

export function applyBoardEvent(event: BoardEvent): void {
  const state = useStore.getState();
  if (event.type === 'task_created' || event.type === 'task_updated') {
    if (event.type === 'task_updated') {
      const previous = state.tasks.find((task) => task.id === event.task.id);
      if (previous && previous.status === 'in_progress' && event.task.status === 'in_review') {
        playCompletionSound();
      }
      if (!previous || previous.updated_at !== event.task.updated_at || previous.last_agent_response_at !== event.task.last_agent_response_at) {
        state.invalidateMissionHistory(event.task.id);
      }
    }
    state.upsertTask(event.task);
    return;
  }
  if (event.type === 'task_deleted') {
    state.removeTask(event.taskId);
    return;
  }
  if (event.type === 'task_runs_snapshot') {
    state.setTaskRuns(event.runs);
    for (const run of event.runs) state.invalidateMissionHistory(run.taskId);
    return;
  }
  state.setTaskRun(event.run);
  state.invalidateMissionHistory(event.run.taskId);
}

export function useTasks() {
  const setTasks = useStore((s) => s.setTasks);
  const retryRef = useRef(0);

  useEffect(() => {
    fetchTasks().then((res) => setTasks(res.tasks)).catch(console.error);
  }, [setTasks]);

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout>;
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      es = new EventSource('/api/events');

      es.onopen = () => {
        if (retryRef.current > 0) {
          fetchTasks().then((res) => setTasks(res.tasks)).catch(console.error);
        }
        retryRef.current = 0;
      };

      es.onmessage = (e) => {
        try {
          applyBoardEvent(JSON.parse(e.data) as BoardEvent);
        } catch {}
      };

      es.onerror = () => {
        es?.close();
        const delay = Math.min(1000 * 2 ** retryRef.current, 30_000);
        retryRef.current++;
        retryTimeout = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(retryTimeout);
      es?.close();
    };
  }, [setTasks]);
}
