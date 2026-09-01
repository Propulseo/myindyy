"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Ellipsis, Plus, X } from "lucide-react";
import { cn } from "@/components/primitives/cn";
import { Button, buttonClasses } from "@/components/primitives/Button";
import { Sheet } from "@/components/primitives/Overlay";
import { IndyPulse } from "@/components/pulse/IndyPulse";
import { NewMissionPanel } from "@/components/mission/NewMissionPanel";
import { useCockpit } from "@/lib/cockpit";
import { pulseSnapshot } from "@/lib/selectors";
import { isActivePath, mobilePrimary, mobileSecondary, navItems } from "./nav";
import { RoleSwitcher } from "./RoleSwitcher";

interface ShellActions {
  openNewMission: (projectId?: string) => void;
}

const ShellActionsContext = createContext<ShellActions | null>(null);

export function useShellActions(): ShellActions {
  const value = useContext(ShellActionsContext);
  if (!value) throw new Error("useShellActions hors de AppShell.");
  return value;
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { viewer, data } = useCockpit();
  const [newMissionOpen, setNewMissionOpen] = useState(false);
  const [newMissionProject, setNewMissionProject] = useState<string | undefined>();
  const [moreOpen, setMoreOpen] = useState(false);

  const openNewMission = useCallback((projectId?: string) => {
    setNewMissionProject(projectId);
    setNewMissionOpen(true);
  }, []);

  const actions = useMemo<ShellActions>(() => ({ openNewMission }), [openNewMission]);

  // Raccourci « n » : lancer une mission depuis n'importe quel écran.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "n" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      openNewMission();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openNewMission]);

  const snapshot = useMemo(() => pulseSnapshot(data, viewer), [data, viewer]);
  const current = navItems.find((item) => isActivePath(pathname, item.href));

  return (
    <ShellActionsContext.Provider value={actions}>
      <div className="min-h-dvh">
        <a
          href="#contenu"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-sm focus:border focus:border-indy focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:text-ivory"
        >
          Aller au contenu
        </a>

        <Sidebar pathname={pathname} onNewMission={() => openNewMission()} />

        <div className="md:pl-[68px] xl:pl-[232px]">
          <header className="sticky top-0 z-30 border-b border-line bg-obsidian/85 backdrop-blur-md">
            <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
              <Link
                href="/"
                className="font-display text-lg leading-none text-ivory md:hidden"
                aria-label="Indy, accueil"
              >
                I<span className="text-indy">.</span>
              </Link>

              <p className="hidden min-w-0 truncate font-mono text-[0.6875rem] tracking-[0.09em] text-muted uppercase md:block">
                {current?.label ?? "Indy"}
              </p>

              <div className="mx-auto flex min-w-0 justify-center">
                <IndyPulse snapshot={snapshot} />
              </div>

              <Button
                variant="quiet"
                size="sm"
                className="md:hidden"
                onClick={() => openNewMission()}
                aria-label="Nouvelle mission"
              >
                <Plus aria-hidden size={14} strokeWidth={2} />
              </Button>

              <RoleSwitcher />
            </div>
          </header>

          <main
            id="contenu"
            className="mx-auto w-full max-w-[1180px] px-4 pt-7 pb-28 sm:px-6 md:pb-16"
          >
            {children}
          </main>
        </div>

        <MobileNav pathname={pathname} onMore={() => setMoreOpen(true)} />

        <Sheet
          open={moreOpen}
          onOpenChange={setMoreOpen}
          title="Tout le cockpit"
          description="Les écrans qui ne tiennent pas dans la barre du bas."
        >
          <nav aria-label="Navigation complémentaire">
            <ul className="divide-y divide-line">
              {mobileSecondary.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setMoreOpen(false)}
                    className="flex items-center gap-3 py-3.5 text-sm text-ivory"
                  >
                    <item.icon
                      aria-hidden
                      size={16}
                      strokeWidth={1.6}
                      className="text-muted"
                    />
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="mt-6 border-t border-line pt-5">
            <p className="label-mono mb-3">Pouls Indy</p>
            <IndyPulse snapshot={snapshot} className="w-full justify-start" />
          </div>
        </Sheet>

        <Journal />

        <NewMissionPanel
          open={newMissionOpen}
          onOpenChange={setNewMissionOpen}
          initialProjectId={newMissionProject}
        />
      </div>
    </ShellActionsContext.Provider>
  );
}

function Sidebar({
  pathname,
  onNewMission,
}: {
  pathname: string;
  onNewMission: () => void;
}) {
  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-40 hidden border-r border-line bg-surface md:flex",
        "w-[68px] flex-col xl:w-[232px]",
      )}
    >
      <div className="flex h-14 items-center justify-center border-b border-line xl:justify-start xl:px-5">
        <Link
          href="/"
          className="font-display text-xl leading-none text-ivory"
          aria-label="Indy, accueil"
        >
          I<span className="text-indy">.</span>
        </Link>
        <span className="ml-3 hidden font-mono text-[0.625rem] tracking-[0.14em] text-muted uppercase xl:inline">
          cockpit
        </span>
      </div>

      <nav aria-label="Navigation principale" className="flex-1 py-3">
        <ul className="space-y-0.5 px-2 xl:px-3">
          {navItems.map((item) => {
            const active = isActivePath(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  title={item.label}
                  className={cn(
                    "group relative flex items-center rounded-sm transition-colors",
                    "h-11 justify-center xl:h-9 xl:justify-start xl:gap-3 xl:px-3",
                    active
                      ? "bg-raised text-ivory"
                      : "text-muted hover:bg-raised/60 hover:text-ivory",
                  )}
                >
                  {active ? (
                    <span
                      aria-hidden
                      className="absolute top-1/2 left-0 h-5 w-0.5 -translate-y-1/2 rounded-full bg-indy xl:-left-1"
                    />
                  ) : null}
                  <item.icon aria-hidden size={17} strokeWidth={1.6} />
                  <span className="hidden text-[0.8125rem] xl:inline">{item.label}</span>
                  <span className="sr-only xl:hidden">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-line p-2 xl:p-3">
        <button
          type="button"
          onClick={onNewMission}
          className={buttonClasses(
            "primary",
            "sm",
            "w-full px-0 xl:px-3 xl:justify-start",
          )}
        >
          <Plus aria-hidden size={14} strokeWidth={2.2} />
          <span className="hidden xl:inline">Nouvelle mission</span>
          <span className="sr-only xl:hidden">Nouvelle mission</span>
          <kbd className="ml-auto hidden font-mono text-[0.625rem] text-obsidian/60 xl:inline">
            N
          </kbd>
        </button>
      </div>
    </aside>
  );
}

function MobileNav({
  pathname,
  onMore,
}: {
  pathname: string;
  onMore: () => void;
}) {
  return (
    <nav
      aria-label="Navigation principale"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur-md md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="grid grid-cols-5">
        {mobilePrimary.map((item) => {
          const active = isActivePath(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-15 flex-col items-center justify-center gap-1 py-2 transition-colors",
                  active ? "text-ivory" : "text-muted",
                )}
              >
                <item.icon aria-hidden size={18} strokeWidth={1.6} />
                <span className="font-mono text-[0.5625rem] tracking-[0.06em] uppercase">
                  {item.short}
                </span>
                {active ? (
                  <span aria-hidden className="h-0.5 w-5 rounded-full bg-indy" />
                ) : null}
              </Link>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            onClick={onMore}
            className="flex h-15 w-full flex-col items-center justify-center gap-1 py-2 text-muted"
          >
            <Ellipsis aria-hidden size={18} strokeWidth={1.6} />
            <span className="font-mono text-[0.5625rem] tracking-[0.06em] uppercase">
              Plus
            </span>
          </button>
        </li>
      </ul>
    </nav>
  );
}

/** Journal des actions simulées. Annoncé aux lecteurs d'écran, jamais bloquant. */
function Journal() {
  const { journal, dismissJournalEntry } = useCockpit();

  useEffect(() => {
    if (journal.length === 0) return;
    const timers = journal.map((entry) =>
      window.setTimeout(() => dismissJournalEntry(entry.id), 6000),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [journal, dismissJournalEntry]);

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-3 bottom-20 z-50 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2 md:right-5 md:bottom-5"
    >
      {journal.map((entry) => (
        <div
          key={entry.id}
          className={cn(
            "pointer-events-auto flex items-start gap-3 rounded-sm border bg-surface px-3.5 py-3",
            "data-[state=open]:animate-rise",
            entry.tone === "success"
              ? "border-ok/35"
              : entry.tone === "danger"
                ? "border-danger/35"
                : "border-line-strong",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "mt-1.5 size-1.5 shrink-0 rounded-full",
              entry.tone === "success"
                ? "bg-ok"
                : entry.tone === "danger"
                  ? "bg-danger"
                  : "bg-indy",
            )}
          />
          <p className="min-w-0 flex-1 text-[0.8125rem] leading-snug text-ivory">
            {entry.message}
          </p>
          <button
            type="button"
            onClick={() => dismissJournalEntry(entry.id)}
            className="-mt-0.5 -mr-1 rounded-xs p-1 text-muted transition-colors hover:text-ivory"
            aria-label="Masquer ce message"
          >
            <X aria-hidden size={13} strokeWidth={1.75} />
          </button>
        </div>
      ))}
    </div>
  );
}
