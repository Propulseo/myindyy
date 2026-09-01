import { CircleAlert, CircleCheck, CircleX } from 'lucide-react';
import type { MissionRun } from '@shared/types';
import type { RuntimeStatus } from '../lib/api';

interface RuntimeBadgeProps {
  status: RuntimeStatus | null;
  run?: MissionRun | null;
}

export const ETIENNE_PROFILE_ID = 'etienne-openai';

export function isEtienneRuntimeReady(status: RuntimeStatus | null): boolean {
  return status?.authState === 'connected'
    && status.profileId === ETIENNE_PROFILE_ID
    && status.models.length > 0;
}

const AUTH_COPY: Record<RuntimeStatus['authState'], string> = {
  connected: 'Codex OAuth connecté',
  expired: 'Connexion Codex expirée',
  missing: 'Codex OAuth non connecté',
  error: 'État Codex indisponible',
};

export function RuntimeBadge({ status, run }: RuntimeBadgeProps) {
  const ready = isEtienneRuntimeReady(status);
  const expectedProfileActive = status?.profileId === ETIENNE_PROFILE_ID;
  const Icon = ready ? CircleCheck : status?.authState === 'error' ? CircleX : CircleAlert;
  const settings = run
    ? `${run.model} · ${run.reasoningEffort ?? 'réglage global'}`
    : null;

  return (
    <div className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--cockpit-fog)]">
      <span className="inline-flex items-center gap-1.5">
        <Icon aria-hidden="true" className={ready ? 'text-[var(--cockpit-stable)]' : 'text-[var(--cockpit-amber)]'} size={14} />
        {status ? AUTH_COPY[status.authState] : 'Vérification de Codex OAuth'}
      </span>
      {status && (
        <span className="text-[color:var(--cockpit-fog-muted)]">
          {status.profileId ? `Profil actif · ${status.profileId}` : 'Aucun profil actif'}
        </span>
      )}
      {status?.authState === 'connected' && !expectedProfileActive && (
        <span className="text-[var(--cockpit-amber)]">Reconnecter le profil {ETIENNE_PROFILE_ID}</span>
      )}
      {status?.authState === 'connected' && expectedProfileActive && status.models.length === 0 && (
        <span className="text-[var(--cockpit-amber)]">Aucun modèle Codex disponible</span>
      )}
      {settings && <span className="text-[color:var(--cockpit-fog-muted)]">{settings}</span>}
    </div>
  );
}
