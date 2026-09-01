"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/components/primitives/cn";
import { useCockpit } from "@/lib/cockpit";
import type { PersonId } from "@/types/domain";

/**
 * Sélecteur de rôle de démonstration. Il est marqué comme tel, sans ambiguïté :
 * ce n'est pas un compte, c'est une simulation de point de vue.
 */
export function RoleSwitcher({ className }: { className?: string }) {
  const { viewer, people, setViewer } = useCockpit();

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className={cn(
          "group flex items-center gap-2.5 rounded-sm border border-line bg-surface py-1.5 pr-2 pl-2.5",
          "transition-colors hover:border-line-strong hover:bg-raised",
          className,
        )}
      >
        <span
          aria-hidden
          className="grid size-6 shrink-0 place-items-center rounded-xs bg-indy/15 font-mono text-[0.625rem] text-indy"
        >
          {viewer.initials}
        </span>
        <span className="hidden text-left sm:block">
          <span className="block text-[0.8125rem] leading-tight text-ivory">
            {viewer.name}
          </span>
          <span className="block font-mono text-[0.625rem] leading-tight text-muted">
            démonstration · {viewer.role.toLowerCase()}
          </span>
        </span>
        <ChevronDown
          aria-hidden
          size={14}
          strokeWidth={1.75}
          className="text-muted transition-transform group-data-[state=open]:rotate-180"
        />
        <span className="sr-only">
          Changer de rôle de démonstration. Rôle actuel : {viewer.name}, {viewer.role}.
        </span>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 w-[min(21rem,calc(100vw-1.5rem))] rounded-md border border-line bg-surface p-1 data-[state=open]:animate-rise"
        >
          <DropdownMenu.Label className="flex items-center gap-2 px-3 pt-2.5 pb-2">
            <span className="label-mono">Démonstration</span>
            <span className="h-px flex-1 bg-line" />
          </DropdownMenu.Label>
          <p className="px-3 pb-2 text-xs leading-relaxed text-muted">
            Change le point de vue pour vérifier ce que chaque rôle voit et peut faire.
            Aucune authentification réelle.
          </p>

          {people.map((person) => {
            const selected = person.id === viewer.id;
            return (
              <DropdownMenu.Item
                key={person.id}
                onSelect={() => setViewer(person.id as PersonId)}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-sm px-3 py-2.5 outline-none",
                  "data-[highlighted]:bg-raised",
                  selected && "bg-raised/60",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 grid size-6 shrink-0 place-items-center rounded-xs font-mono text-[0.625rem]",
                    selected ? "bg-indy/20 text-indy" : "bg-line text-muted",
                  )}
                >
                  {person.initials}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-[0.8125rem] font-medium text-ivory">
                      {person.name}
                    </span>
                    <span className="font-mono text-[0.625rem] tracking-[0.08em] text-muted uppercase">
                      {person.role}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-xs leading-snug text-muted">
                    {person.roleSummary}
                  </span>
                </span>
                {selected ? (
                  <Check
                    aria-hidden
                    size={14}
                    strokeWidth={2}
                    className="mt-1 shrink-0 text-indy"
                  />
                ) : null}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
