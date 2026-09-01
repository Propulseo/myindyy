import type { ReactNode } from 'react';

interface AppMainProps {
  children: ReactNode;
}

export function AppMain({ children }: AppMainProps) {
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-surface pb-[calc(3.75rem_+_env(safe-area-inset-bottom))] dark:bg-zinc-900 sm:m-2 sm:ml-0 sm:overflow-hidden sm:rounded-xl sm:border sm:border-zinc-200 sm:pb-0 sm:shadow-sm sm:dark:border-zinc-800">
      {children}
    </main>
  );
}
