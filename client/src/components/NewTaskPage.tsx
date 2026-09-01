import { useState, useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowUp, Loader2 } from 'lucide-react';
import { AttachButton, AttachDropOverlay, AttachmentTray, UploadErrorBar } from './ChatAttachments';
import { isEtienneRuntimeReady, RuntimeBadge } from './RuntimeBadge';
import { createTask, fetchRuntime, type RuntimeStatus } from '../lib/api';
import { useFileAttachments } from '../hooks/useFileAttachments';
import { isEditableTarget, handleChatKeyDown } from '../lib/keyboard';
import { toErrorMessage } from '../lib/format';
import type { ReasoningEffort } from '@shared/types';

type NewTaskLocationState = {
  draft?: string;
} | null;

function draftFromLocationState(state: unknown): string {
  const draft = (state as NewTaskLocationState)?.draft;
  return typeof draft === 'string' ? draft : '';
}

export function createTaskErrorMessage(error: unknown): string {
  return toErrorMessage(error, 'Impossible de créer la mission');
}

export function NewTaskPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const initialDraftRef = useRef(draftFromLocationState(location.state));
  const lastAppliedKeyRef = useRef(location.key);
  const [input, setInput] = useState(initialDraftRef.current);
  const [isCreating, setIsCreating] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [model, setModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | null>(null);
  const uploadBucketRef = useRef<string | null>(null);
  if (uploadBucketRef.current === null) uploadBucketRef.current = `draft-${crypto.randomUUID()}`;
  const uploadBucketId = uploadBucketRef.current;
  const {
    pendingFiles,
    dragOver,
    uploadError,
    setUploadError,
    hasUploadingFiles,
    uploadBlocksSend,
    sendBlockedLabel,
    addFiles,
    removeFile,
    retryFile,
    submitWithAttachments,
    dragHandlers,
    handlePaste,
  } = useFileAttachments(uploadBucketId);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const selectedModel = runtime?.models.find((candidate) => candidate.id === model) ?? null;
  const runtimeReady = isEtienneRuntimeReady(runtime);

  useEffect(() => {
    let cancelled = false;
    void fetchRuntime()
      .then((status) => {
        if (cancelled) return;
        setRuntime(status);
        setModel(status.models[0]?.id ?? '');
      })
      .catch(() => {
        if (!cancelled) setRuntime({ provider: 'openai-codex', profileId: null, authState: 'error', checkedAt: new Date().toISOString(), models: [] });
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (lastAppliedKeyRef.current === location.key) return;
    lastAppliedKeyRef.current = location.key;
    const nextDraft = draftFromLocationState(location.state);
    if (!nextDraft) return;
    setInput(nextDraft);
    inputRef.current?.focus();
  }, [location.key, location.state]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !isEditableTarget(e.target)) navigate('/');
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    const hasFiles = pendingFiles.length > 0;
    if ((!text && !hasFiles) || isCreating || !runtimeReady || !model || uploadBlocksSend) return;

    setIsCreating(true);
    setUploadError(null);
    try {
      const description = text || pendingFiles.map((f) => f.file.name).join(', ');
      const { task } = await createTask(description);
      const initialMessage = submitWithAttachments(text);
      navigate(`/tasks/${task.id}`, {
        state: {
          initialMessage,
          initialSettings: { model, provider: 'openai-codex', reasoningEffort, mode: 'task' },
        },
      });
    } catch (err) {
      setUploadError(createTaskErrorMessage(err));
      setIsCreating(false);
    }
  }, [uploadBlocksSend, input, isCreating, model, navigate, pendingFiles, reasoningEffort, runtimeReady, submitWithAttachments, setUploadError]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => handleChatKeyDown(e, handleSubmit),
    [handleSubmit],
  );

  return (
    <div className="cockpit-shell relative flex flex-1 flex-col items-center justify-center bg-[var(--cockpit-ink)] px-6 pb-24 text-[var(--cockpit-fog)]" {...(isCreating ? {} : dragHandlers)}>
      {dragOver && !isCreating && <AttachDropOverlay />}
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--cockpit-periwinkle)]">Nouvelle mission</p>
      <h1 className="mb-6 font-[var(--cockpit-mission-font)] text-3xl sm:text-4xl">
        Que faut-il accomplir ?
      </h1>

      <div className="w-full max-w-2xl">
        <div className="mb-3 flex justify-between gap-3">
          <RuntimeBadge status={runtime} />
        </div>
        <div className="rounded-xl border border-[var(--cockpit-panel-line)] bg-[var(--cockpit-panel)]">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={isCreating ? undefined : handlePaste}
            placeholder="Décrivez le résultat attendu, le contexte et les limites…"
            rows={4}
            className="w-full resize-none bg-transparent px-5 pb-2 pt-4 text-sm leading-relaxed text-[var(--cockpit-fog)] placeholder:text-[color:var(--cockpit-fog-muted)] focus:outline-none"
          />
          <AttachmentTray files={pendingFiles} onRemove={removeFile} onRetry={retryFile} />
          {uploadError && <UploadErrorBar error={uploadError} onDismiss={() => setUploadError(null)} />}
          <div className="flex items-center justify-between gap-2 px-3 pb-3 sm:gap-3 sm:px-4">
            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
              <AttachButton onFiles={addFiles} disabled={isCreating} />
              <select
                aria-label="Modèle Codex"
                value={model}
                disabled={isCreating || !runtimeReady}
                onChange={(event) => { setModel(event.target.value); setReasoningEffort(null); }}
                className="min-h-9 min-w-0 rounded-md border border-[var(--cockpit-panel-line)] bg-[var(--cockpit-ink)] px-2 font-mono text-[11px] text-[var(--cockpit-fog)]"
              >
                <option value="">Choisir un modèle</option>
                {runtime?.models.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
              <select
                aria-label="Effort de raisonnement"
                value={reasoningEffort ?? ''}
                disabled={isCreating || !runtimeReady || !model}
                onChange={(event) => setReasoningEffort(event.target.value ? event.target.value as ReasoningEffort : null)}
                className="min-h-9 min-w-0 rounded-md border border-[var(--cockpit-panel-line)] bg-[var(--cockpit-ink)] px-2 font-mono text-[11px] text-[var(--cockpit-fog)]"
              >
                <option value="">Réglage global</option>
                {selectedModel?.reasoningEfforts?.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
              </select>
            </div>
            <button
              onClick={handleSubmit}
              disabled={(!input.trim() && pendingFiles.length === 0) || isCreating || !runtimeReady || !model || uploadBlocksSend}
              title={sendBlockedLabel ?? (runtimeReady ? 'Créer la mission' : 'Reconnecter le profil etienne-openai')}
              aria-label={sendBlockedLabel ?? 'Créer la mission'}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--cockpit-periwinkle)] text-[var(--cockpit-ink)] transition-opacity hover:opacity-90 disabled:opacity-30"
            >
              {isCreating || hasUploadingFiles ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <ArrowUp size={16} />
              )}
            </button>
          </div>
        </div>
        <p className="mt-3 text-center text-xs text-[color:var(--cockpit-fog-muted)]">
          Donnez le contexte utile : l’agent démarre avec ce modèle et ce périmètre.
        </p>
      </div>
    </div>
  );
}
