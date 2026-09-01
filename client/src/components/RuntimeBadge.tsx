import { CircleAlert, CircleCheck, CircleX } from 'lucide-react';
import type { MissionRun } from '@shared/types';
import type { RuntimeStatus } from '../lib/api';

interface RuntimeBadgeProps {
  status: RuntimeStatus | null;
  run?: MissionRun | null;
}

const AUTH_COPY: Record<RuntimeStatus['authState'], string> = {
  connected: 'Codex OAuth connecté',
  expired: 'Connexion Codex expirée',
  missing: 'Codex OAuth non connecté',
  error: 'État Codex indisponible',
};

export function RuntimeBadge({ status, run }: RuntimeBadgeProps) {
  const connected = status?.authState === 'connected';
  const Icon = connected ? CircleCheck : status?.authState === 'error' ? CircleX : CircleAlert;
  const settings = run
    ? `${run.model} · ${run.reasoningEffort ?? 'réglage global'}`
    : null;

  return (
    <div className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--cockpit-fog)]">
      <span className="inline-flex items-center gap-1.5">
        <Icon aria-hidden="true" className={connected ? 'text-[var(--cockpit-stable)]' : 'text-[var(--cockpit-amber)]'} size={14} />
        {status ? AUTH_COPY[status.authState] : 'Vérification de Codex OAuth'}
      </span>
      {settings && <span className="text-[color:var(--cockpit-fog-muted)]">{settings}</span>}
    </div>
  );
}
