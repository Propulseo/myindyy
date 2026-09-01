"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Ban, Check, Ellipsis, Lock, SlidersHorizontal } from "lucide-react";
import { cn } from "@/components/primitives/cn";
import { useSensitiveAction } from "@/components/decision/SensitiveAction";
import { peopleById, projectsById } from "@/fixtures";
import { canManageTask, taskDenial } from "@/lib/access";
import { useCockpit } from "@/lib/cockpit";
import { TASK_CANCEL_CONSEQUENCE } from "@/lib/cockpit-state";
import { formatDayTime } from "@/lib/format";
import type { ObsidianTask } from "@/types/domain";

/**
 * Les trois commandes qu'une tâche accepte depuis le cockpit.
 *
 * Indy n'écrit pas dans le coffre Obsidian : chaque entrée envoie une commande à
 * Hermes, qui l'applique. Hors du périmètre du rôle, le menu explique pourquoi
 * plutôt que de disparaître sans un mot.
 */
export function TaskActions({
  task,
  onTriage,
}: {
  task: ObsidianTask;
  onTriage: (task: ObsidianTask) => void;
}) {
  const { viewer, completeTask, cancelTask } = useCockpit();
  const sensitive = useSensitiveAction();

  const allowed = canManageTask(viewer, task);
  const denial = taskDenial(viewer, task);
  const closed = task.state === "fait" || task.state === "annulee";
  const owner = peopleById[task.ownerId]?.name ?? task.ownerId;
  const project = task.projectId ? projectsById[task.projectId]?.name : "Personnel";

  function askCancel() {
    sensitive.request({
      kind: "annulation_tache",
      action: `Annuler la tâche « ${task.title} »`,
      target: `${task.title} · échéance ${formatDayTime(task.dueAt)}`,
      projectId: task.projectId,
      environment: "Coffre Obsidian, par commande Hermes",
      revision: `todo.cancel · ${project} · responsable ${owner}${task.note ? ` · ${task.note}` : ""}`,
      consequence: TASK_CANCEL_CONSEQUENCE,
      requiredCapability: "tasks.manage",
      confirmLabel: "Annuler la tâche",
      onConfirm: () => cancelTask(task),
    });
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className={cn(
          "-my-1 grid size-8 shrink-0 place-items-center rounded-sm text-muted",
          "transition-colors hover:bg-raised hover:text-ivory",
          "data-[state=open]:bg-raised data-[state=open]:text-ivory",
        )}
      >
        <Ellipsis aria-hidden size={15} strokeWidth={1.75} />
        <span className="sr-only">Actions sur la tâche « {task.title} »</span>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 w-[min(19rem,calc(100vw-1.5rem))] rounded-md border border-line bg-surface p-1 data-[state=open]:animate-rise"
        >
          <DropdownMenu.Label className="flex items-center gap-2 px-3 pt-2.5 pb-2">
            <span className="label-mono">Commande Hermes</span>
            <span className="h-px flex-1 bg-line" />
          </DropdownMenu.Label>

          {allowed ? (
            <>
              {closed ? null : (
                <MenuItem
                  icon={Check}
                  label="Terminer"
                  command="todo.complete"
                  hint="Hermes coche la tâche dans le coffre."
                  onSelect={() => completeTask(task)}
                />
              )}
              <MenuItem
                icon={SlidersHorizontal}
                label="Trier ou modifier"
                command="todo.triage"
                hint="Projet, responsable, échéance, note."
                onSelect={() => onTriage(task)}
              />
              {closed ? null : (
                <MenuItem
                  icon={Ban}
                  label="Annuler la tâche"
                  command="todo.cancel"
                  hint="Demande une confirmation, avec sa conséquence."
                  onSelect={askCancel}
                />
              )}
            </>
          ) : (
            <p className="flex items-start gap-2.5 px-3 pt-1 pb-3 text-xs leading-relaxed text-muted">
              <Lock aria-hidden size={12} strokeWidth={1.75} className="mt-0.5 shrink-0" />
              {denial}
            </p>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function MenuItem({
  icon: Icon,
  label,
  command,
  hint,
  onSelect,
}: {
  icon: typeof Check;
  label: string;
  command: string;
  hint: string;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className="flex cursor-pointer items-start gap-3 rounded-sm px-3 py-2.5 outline-none data-[highlighted]:bg-raised"
    >
      <Icon aria-hidden size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-2">
          <span className="text-[0.8125rem] text-ivory">{label}</span>
          <span className="font-mono text-[0.625rem] text-muted">{command}</span>
        </span>
        <span className="mt-0.5 block text-xs leading-snug text-muted">{hint}</span>
      </span>
    </DropdownMenu.Item>
  );
}
