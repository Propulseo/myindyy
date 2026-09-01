import { useState } from 'react';
import { MessageSquarePlus, Octagon, RefreshCw, RotateCcw, Send } from 'lucide-react';
import type { MissionRun, RunCommandType } from '@shared/types';
import type { RunCommandRequest } from '../lib/api';

interface RunControlsProps {
  run: MissionRun;
  onCommand: (command: RunCommandRequest) => Promise<unknown>;
}

type InstructionMode = 'resume' | 'correct';

const SUCCESS_COPY: Record<RunCommandType, string> = {
  interrupt: 'Mission interrompue',
  correct: 'Correction envoyée',
  resume: 'Instruction ajoutée',
  retry: 'Mission relancée',
  stop: 'Mission arrêtée',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'La commande n’a pas été acceptée.';
}

export function RunControls({ run, onCommand }: RunControlsProps) {
  const [mode, setMode] = useState<InstructionMode | null>(null);
  const [instruction, setInstruction] = useState('');
  const [pending, setPending] = useState<RunCommandType | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  async function send(type: RunCommandType, reason?: string) {
    setPending(type);
    setFeedback(null);
    try {
      await onCommand({
        type,
        runId: run.id,
        ...(reason ? { reason } : {}),
        idempotencyKey: crypto.randomUUID(),
      });
      setFeedback({ kind: 'success', message: SUCCESS_COPY[type] });
      setMode(null);
      setInstruction('');
    } catch (error) {
      setFeedback({ kind: 'error', message: errorMessage(error) });
    } finally {
      setPending(null);
    }
  }

  function openInstruction(nextMode: InstructionMode) {
    setFeedback(null);
    setInstruction('');
    setMode(nextMode);
  }

  return (
    <section aria-label="Contrôles de mission" className="border-y border-[var(--cockpit-panel-line)] py-4">
      <div className="flex flex-wrap gap-2">
        <ControlButton icon={MessageSquarePlus} label="Ajouter une instruction" onClick={() => openInstruction('resume')} disabled={pending !== null} />
        <ControlButton icon={RotateCcw} label="Interrompre et corriger" onClick={() => openInstruction('correct')} disabled={pending !== null} />
        <ControlButton icon={RefreshCw} label="Relancer" onClick={() => void send('retry')} disabled={pending !== null} />
        <ControlButton icon={Octagon} label="Arrêter" onClick={() => void send('stop')} disabled={pending !== null} danger />
      </div>

      {mode && (
        <form
          className="mt-4 border-l-2 border-[var(--cockpit-periwinkle)] pl-4"
          onSubmit={(event) => {
            event.preventDefault();
            const reason = instruction.trim();
            if (reason) void send(mode, reason);
          }}
        >
          <label htmlFor="run-instruction" className="mb-2 block font-mono text-[10px] uppercase tracking-[0.14em] text-[color:var(--cockpit-fog-muted)]">
            {mode === 'correct' ? 'Instruction de correction' : 'Instruction à ajouter'}
          </label>
          <div className="flex gap-2">
            <textarea
              id="run-instruction"
              rows={2}
              autoFocus
              required
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              className="min-w-0 flex-1 resize-none rounded-md border border-[var(--cockpit-panel-line)] bg-[var(--cockpit-ink)] px-3 py-2 text-sm text-[var(--cockpit-fog)] outline-none focus:border-[var(--cockpit-periwinkle)]"
            />
            <button
              type="submit"
              aria-label={mode === 'correct' ? 'Envoyer la correction' : 'Envoyer l’instruction'}
              disabled={!instruction.trim() || pending !== null}
              className="inline-flex h-10 w-10 items-center justify-center rounded-md bg-[var(--cockpit-periwinkle)] text-[var(--cockpit-ink)] disabled:opacity-40"
            >
              <Send aria-hidden="true" size={16} />
            </button>
          </div>
        </form>
      )}

      {feedback && (
        <p role={feedback.kind === 'error' ? 'alert' : 'status'} className={`mt-3 text-xs ${feedback.kind === 'error' ? 'text-[var(--cockpit-amber)]' : 'text-[var(--cockpit-stable)]'}`}>
          {feedback.message}
        </p>
      )}
    </section>
  );
}

interface ControlButtonProps {
  icon: typeof MessageSquarePlus;
  label: string;
  onClick: () => void;
  disabled: boolean;
  danger?: boolean;
}

function ControlButton({ icon: Icon, label, onClick, disabled, danger = false }: ControlButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-10 items-center gap-2 rounded-md border px-3 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cockpit-periwinkle)] disabled:opacity-40 ${danger ? 'border-[color:var(--cockpit-amber-muted)] text-[var(--cockpit-amber)] hover:bg-[color:var(--cockpit-amber-wash)]' : 'border-[var(--cockpit-panel-line)] text-[var(--cockpit-fog)] hover:border-[var(--cockpit-periwinkle)]'}`}
    >
      <Icon aria-hidden="true" size={15} />
      {label}
    </button>
  );
}
