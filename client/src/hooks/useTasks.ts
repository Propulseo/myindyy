import { useEffect, useRef } from 'react';
import type { BoardEvent, Task } from '@shared/types';
import { useStore } from '../lib/store';
import { fetchTasks } from '../lib/api';
import { playCompletionSound } from './useSoundOnComplete';

export interface TaskSnapshotBaseline {
  tasks: Map<string, Task>;
  boardSequence: number;
}

let boardSequence = 0;
const taskBoardSequences = new Map<string, number>();

function recordTaskBoardMutation(taskId: string): void {
  boardSequence += 1;
  taskBoardSequences.set(taskId, boardSequence);
}

export function applyBoardEvent(event: BoardEvent): void {
  const state = useStore.getState();
  if (event.type === 'task_created' || event.type === 'task_updated') {
    recordTaskBoardMutation(event.task.id);
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
    recordTaskBoardMutation(event.taskId);
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

function durableVersionAdvanced(previous: Task, current: Task): boolean {
  return current.updated_at > previous.updated_at
    || (current.last_agent_response_at ?? 0) > (previous.last_agent_response_at ?? 0);
}

function compareTaskVersion(left: Task, right: Task): number {
  const leftVersion = [left.updated_at, left.last_agent_response_at ?? 0, left.last_viewed_at ?? 0];
  const rightVersion = [right.updated_at, right.last_agent_response_at ?? 0, right.last_viewed_at ?? 0];
  for (let index = 0; index < leftVersion.length; index += 1) {
    if (leftVersion[index] !== rightVersion[index]) {
      return leftVersion[index] > rightVersion[index] ? 1 : -1;
    }
  }
  return 0;
}

export function captureTaskSnapshot(): TaskSnapshotBaseline {
  return {
    tasks: new Map(useStore.getState().tasks.map((task) => [task.id, task])),
    boardSequence,
  };
}

export function applyTaskSnapshot(tasks: Task[], baseline = captureTaskSnapshot()): void {
  const state = useStore.getState();
  const currentTasks = new Map(state.tasks.map((task) => [task.id, task]));
  const incomingIds = new Set(tasks.map((task) => task.id));
  const merged: Task[] = [];

  for (const incoming of tasks) {
    const current = currentTasks.get(incoming.id);
    const existedAtRequestStart = baseline.tasks.has(incoming.id);
    const changedDuringRequest = (taskBoardSequences.get(incoming.id) ?? 0) > baseline.boardSequence;
    const comparison = current ? compareTaskVersion(current, incoming) : 0;
    if (!current && (existedAtRequestStart || changedDuringRequest)) continue;
    if (current && (comparison > 0 || (changedDuringRequest && comparison === 0))) {
      merged.push(current);
      continue;
    }
    if (current && durableVersionAdvanced(current, incoming)) {
      state.invalidateMissionHistory(incoming.id);
    }
    merged.push(incoming);
  }

  for (const current of state.tasks) {
    if (incomingIds.has(current.id)) continue;
    const previous = baseline.tasks.get(current.id);
    const changedDuringRequest = (taskBoardSequences.get(current.id) ?? 0) > baseline.boardSequence;
    if (changedDuringRequest || !previous || compareTaskVersion(current, previous) > 0) merged.push(current);
  }

  state.setTasks(merged);
}

function fetchTaskSnapshot(): Promise<void> {
  const baseline = captureTaskSnapshot();
  return fetchTasks().then((response) => applyTaskSnapshot(response.tasks, baseline));
}

export function useTasks() {
  const retryRef = useRef(0);

  useEffect(() => {
    fetchTaskSnapshot().catch(console.error);
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout>;
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      es = new EventSource('/api/events');

      es.onopen = () => {
        if (retryRef.current > 0) {
          fetchTaskSnapshot().catch(console.error);
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
  }, []);
}
