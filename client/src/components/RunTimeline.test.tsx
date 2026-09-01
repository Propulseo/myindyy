// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { MissionRun, RunEvent } from '@shared/types';
import { RunTimeline } from './RunTimeline';
import { isEtienneRuntimeReady, RuntimeBadge } from './RuntimeBadge';

const RUN: MissionRun = {
  id: 'run-2',
  missionId: 'mission-1',
  sessionId: 'session-2',
  sessionConfirmedAt: 1_725_189_000_000,
  attempt: 2,
  provider: 'openai-codex',
  model: 'gpt-5.6-sol',
  reasoningEffort: 'high',
  status: 'completed',
  startedAt: 1_725_189_000_000,
  lastActivityAt: 1_725_189_180_000,
  finishedAt: 1_725_189_180_000,
  finishReason: 'Mission terminée',
  previousRunId: 'run-1',
};

const EVENTS: RunEvent[] = [
  { id: 'event-1', runId: 'run-2', type: 'run.started', occurredAt: 1_725_189_000_000, payload: {} },
  { id: 'event-2', runId: 'run-2', type: 'tool.started', occurredAt: 1_725_189_010_000, payload: { tool: 'terminal', label: 'Vérifier les tests' } },
  { id: 'event-3', runId: 'run-2', type: 'tool.completed', occurredAt: 1_725_189_020_000, payload: { tool: 'terminal', label: 'Vérifier les tests' } },
  { id: 'event-4', runId: 'run-2', type: 'artifact.produced', occurredAt: 1_725_189_030_000, payload: { path: 'rapport.md' } },
  { id: 'event-5', runId: 'run-2', type: 'run.completed', occurredAt: 1_725_189_180_000, payload: { reason: 'Mission terminée' } },
];

afterEach(cleanup);

describe('RuntimeBadge', () => {
  it('expose la connexion OAuth et les réglages réels du run', () => {
    render(<RuntimeBadge status={{
      provider: 'openai-codex',
      profileId: 'etienne-openai',
      authState: 'connected',
      checkedAt: '2026-09-01T10:00:00.000Z',
      models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', reasoningEfforts: ['high'] }],
    }} run={RUN} />);

    expect(screen.getByText('Codex OAuth connecté')).toBeVisible();
    expect(screen.getByText('Profil actif · etienne-openai')).toBeVisible();
    expect(screen.getByText('gpt-5.6-sol · high')).toBeVisible();
  });

  it('rend un profil différent actionnable et bloque la création', () => {
    const status = {
      provider: 'openai-codex' as const,
      profileId: 'profil-secondaire',
      authState: 'connected' as const,
      checkedAt: '2026-09-01T10:00:00.000Z',
      models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', reasoningEfforts: null }],
    };
    render(<RuntimeBadge status={status} />);

    expect(screen.getByText('Profil actif · profil-secondaire')).toBeVisible();
    expect(screen.getByText('Reconnecter le profil etienne-openai')).toBeVisible();
    expect(isEtienneRuntimeReady(status)).toBe(false);
    expect(isEtienneRuntimeReady({ ...status, profileId: 'etienne-openai', models: [] })).toBe(false);
  });
});

describe('RunTimeline', () => {
  it('regroupe les événements par tentative et montre outils, artefacts et fin', () => {
    render(<RunTimeline runs={[RUN]} events={EVENTS} />);

    expect(screen.getByRole('heading', { name: 'Tentative 2' })).toBeVisible();
    expect(screen.getAllByText('Vérifier les tests')).toHaveLength(2);
    expect(screen.getByText('Terminé', { selector: 'span' })).toBeVisible();
    expect(screen.getByText('rapport.md')).toBeVisible();
    expect(screen.getByText('Mission terminée')).toBeVisible();
  });

  it('donne une direction utile quand aucun run n’existe', () => {
    render(<RunTimeline runs={[]} events={[]} />);

    expect(screen.getByText('Lancez la mission pour voir son exécution ici.')).toBeVisible();
  });

  it('rend un outil terminé en erreur comme un échec', () => {
    render(<RunTimeline runs={[RUN]} events={[{
      id: 'event-error',
      runId: RUN.id,
      type: 'tool.completed',
      occurredAt: 1_725_189_020_000,
      payload: { tool: 'terminal', label: 'Compiler', status: 'error' },
    }]} />);

    expect(screen.getByText('Compiler')).toBeVisible();
    expect(screen.getByText('Échec')).toBeVisible();
    expect(screen.queryByText('Terminé')).not.toBeInTheDocument();
  });
});
