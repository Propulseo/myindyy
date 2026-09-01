import type { TaskStatus } from '@shared/types';

export const STATUS_META: Record<TaskStatus, { label: string; color: string; tint: string }> = {
  in_progress: { label: 'En cours', color: 'bg-amber-500', tint: 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300' },
  in_review: { label: 'À relire', color: 'bg-purple-500', tint: 'bg-purple-50 text-purple-700 dark:bg-purple-950/30 dark:text-purple-300' },
  done: { label: 'Terminée', color: 'bg-emerald-500', tint: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400' },
};
