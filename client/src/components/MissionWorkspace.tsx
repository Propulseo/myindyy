import type { ReactNode } from 'react';

interface MissionWorkspaceProps {
  chat: ReactNode;
  execution: ReactNode;
}

export function MissionWorkspace({ chat, execution }: MissionWorkspaceProps) {
  return (
    <div
      data-testid="mission-workspace"
      className="grid min-h-0 w-full flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_24rem] lg:overflow-hidden"
    >
      <section className="flex min-h-[28rem] min-w-0 flex-col border-t border-[var(--cockpit-panel-line)] lg:min-h-0 lg:border-r">
        {chat}
      </section>
      <aside
        aria-label="Exécution de la mission"
        className="cockpit-shell min-h-0 overflow-visible bg-[var(--cockpit-ink)] p-5 text-[var(--cockpit-fog)] sm:p-6 lg:overflow-y-auto"
      >
        {execution}
      </aside>
    </div>
  );
}
