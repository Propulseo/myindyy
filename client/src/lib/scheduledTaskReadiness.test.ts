import { describe, expect, it } from 'vitest';
import type { ScheduledTask } from '@shared/types';
import { scheduledTaskRunReadiness } from './scheduledTaskReadiness';

function task(readiness: ScheduledTask['readiness']): ScheduledTask {
  return {
    id: 'cron-1',
    name: 'Brief',
    prompt: 'Préparer le brief',
    schedule: null,
    scheduleDisplay: '0 8 * * *',
    enabled: true,
    state: 'scheduled',
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    lastDeliveryError: null,
    model: 'gpt-5.6-sol',
    provider: 'openai-codex',
    reasoningEffort: 'high',
    baseUrl: null,
    deliver: 'local',
    origin: null,
    repeat: null,
    contextFrom: [],
    skills: [],
    workdir: '/srv/indy/client',
    createdAt: null,
    readiness,
  };
}

describe('scheduled task run readiness', () => {
  it('enables run-now only after an explicit ready acknowledgement from the server', () => {
    expect(scheduledTaskRunReadiness(task({ ready: true, code: null, reason: null }))).toEqual({
      ready: true,
      reason: null,
    });
    expect(scheduledTaskRunReadiness(task(undefined))).toEqual({
      ready: false,
      reason: 'Validation serveur indisponible. Rechargez les tâches planifiées.',
    });
  });

  it.each([
    ['SCHEDULED_OAUTH_EXPIRED', 'La connexion OAuth a expiré.'],
    ['SCHEDULED_PROFILE_UNSUPPORTED', 'Le profil actif n’est pas etienne-openai.'],
    ['SCHEDULED_MODEL_UNAVAILABLE', 'Le modèle a été retiré du catalogue.'],
    ['SCHEDULED_EFFORT_UNSUPPORTED', 'L’effort n’est pas supporté.'],
    ['SCHEDULED_WORKDIR_NOT_ALLOWED', 'Le dossier sort du registre serveur.'],
  ])('keeps the exact server refusal reason for %s', (code, reason) => {
    expect(scheduledTaskRunReadiness(task({ ready: false, code, reason }))).toEqual({
      ready: false,
      reason,
    });
  });
});
