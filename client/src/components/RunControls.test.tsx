// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MissionRun } from '@shared/types';
import { RunControls } from './RunControls';

const BLOCKED_RUN: MissionRun = {
  id: 'run-blocked',
  missionId: 'mission-1',
  sessionId: 'session-1',
  sessionConfirmedAt: 1_725_189_000_000,
  attempt: 1,
  provider: 'openai-codex',
  model: 'gpt-5.6-sol',
  reasoningEffort: 'high',
  status: 'blocked',
  startedAt: 1_725_189_000_000,
  lastActivityAt: 1_725_189_100_000,
  finishedAt: null,
  finishReason: 'inactive',
  previousRunId: null,
};

afterEach(cleanup);

describe('RunControls', () => {
  it('envoie une correction avec une clé idempotente et sans succès optimiste', async () => {
    const user = userEvent.setup();
    let resolveCommand: (() => void) | undefined;
    const onCommand = vi.fn(() => new Promise<void>((resolve) => { resolveCommand = resolve; }));
    render(<RunControls run={BLOCKED_RUN} onCommand={onCommand} />);

    await user.click(screen.getByRole('button', { name: 'Interrompre et corriger' }));
    expect(screen.getByLabelText('Instruction de correction')).toBeVisible();
    await user.type(screen.getByLabelText('Instruction de correction'), 'Travaille uniquement sur le dépôt client');
    await user.click(screen.getByRole('button', { name: 'Envoyer la correction' }));

    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'correct',
      runId: 'run-blocked',
      reason: 'Travaille uniquement sur le dépôt client',
      idempotencyKey: expect.any(String),
    }));
    expect(screen.queryByText('Correction envoyée')).not.toBeInTheDocument();

    resolveCommand?.();
    expect(await screen.findByText('Correction envoyée')).toBeVisible();
  });

  it('distingue le libellé d’ajout de celui de correction', async () => {
    const user = userEvent.setup();
    render(<RunControls run={BLOCKED_RUN} onCommand={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Ajouter une instruction' }));

    expect(screen.getByLabelText('Instruction à ajouter')).toBeVisible();
    expect(screen.queryByLabelText('Instruction de correction')).not.toBeInTheDocument();
  });

  it('affiche la cause serveur sans annoncer de succès', async () => {
    const user = userEvent.setup();
    const onCommand = vi.fn().mockRejectedValue(new Error('runId must be the current attempt for this mission'));
    render(<RunControls run={BLOCKED_RUN} onCommand={onCommand} />);

    await user.click(screen.getByRole('button', { name: 'Relancer' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('runId must be the current attempt for this mission');
    expect(screen.queryByText('Mission relancée')).not.toBeInTheDocument();
  });

  it('propose les quatre contrôles opérateur', () => {
    render(<RunControls run={BLOCKED_RUN} onCommand={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Ajouter une instruction' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Interrompre et corriger' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Relancer' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Arrêter' })).toBeVisible();
  });
});
