import type { ScheduledTask } from '@shared/types';

export interface ScheduledTaskRunReadiness {
  readonly ready: boolean;
  readonly reason: string | null;
}

export function scheduledTaskRunReadiness(task: ScheduledTask): ScheduledTaskRunReadiness {
  if (!task.readiness) {
    return {
      ready: false,
      reason: 'Validation serveur indisponible. Rechargez les tâches planifiées.',
    };
  }
  return task.readiness.ready
    ? { ready: true, reason: null }
    : {
        ready: false,
        reason: task.readiness.reason ?? 'La politique serveur refuse cette exécution.',
      };
}
