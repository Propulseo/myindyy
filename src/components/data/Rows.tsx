import Link from "next/link";
import type { ReactNode } from "react";
import { FileText, GitBranch, Image as ImageIcon, Send, NotebookPen } from "lucide-react";
import { cn } from "@/components/primitives/cn";
import { StatusMark, StatusRail } from "@/components/status/StatusMark";
import { SourceTag } from "@/components/status/Meter";
import { peopleById, projectsById } from "@/fixtures";
import { formatDuration, formatRelative, formatStamp } from "@/lib/format";
import type { HistoryEntry } from "@/lib/selectors";
import { taskStateMeta, toneClasses } from "@/lib/status";
import type { Deliverable, DeliverableFormat, ObsidianTask } from "@/types/domain";

/* ------------------------------------------------------------------ */
/* Tâches Obsidian                                                     */
/* ------------------------------------------------------------------ */

export function TaskRow({
  task,
  actions,
}: {
  task: ObsidianTask;
  /** Menu de commandes, quand l'écran en propose. */
  actions?: ReactNode;
}) {
  const meta = taskStateMeta[task.state];
  const project = task.projectId ? projectsById[task.projectId] : undefined;
  const closed = task.state === "fait" || task.state === "annulee";

  return (
    <li className="flex items-start gap-3 py-2.5">
      <StatusMark
        shape={meta.shape}
        tone={meta.tone}
        className="mt-0.5 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-[0.8125rem] leading-snug",
            closed ? "text-muted line-through decoration-line-strong" : "text-ivory",
          )}
        >
          {task.title}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 font-mono text-[0.625rem] text-muted">
          <span>{project ? project.name : "Personnel"}</span>
          <span className="text-line-strong">·</span>
          <span>{peopleById[task.ownerId]?.name}</span>
          <span className="text-line-strong">·</span>
          {/* L'état est toujours écrit : la pastille et sa couleur ne le portent jamais seules. */}
          <span className={toneClasses[meta.tone].text}>{meta.label}</span>
          {task.note ? (
            <>
              <span className="text-line-strong">·</span>
              <span className="font-sans text-[0.6875rem]">{task.note}</span>
            </>
          ) : null}
        </p>
      </div>
      <span className="mt-0.5 shrink-0 font-mono text-[0.625rem] whitespace-nowrap text-muted tabular-nums">
        {formatStamp(task.dueAt)}
      </span>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Livrables                                                           */
/* ------------------------------------------------------------------ */

const FORMAT_ICON = {
  rapport: FileText,
  code: GitBranch,
  document: NotebookPen,
  visuel: ImageIcon,
  message: Send,
} as const satisfies Record<DeliverableFormat, unknown>;

const FORMAT_LABEL: Record<DeliverableFormat, string> = {
  rapport: "Rapport",
  code: "Code",
  document: "Document",
  visuel: "Visuel",
  message: "Message",
};

export function DeliverableRow({ deliverable }: { deliverable: Deliverable }) {
  const Icon = FORMAT_ICON[deliverable.format];
  const project = projectsById[deliverable.projectId];

  const body = (
    <>
      <Icon
        aria-hidden
        size={15}
        strokeWidth={1.5}
        className="mt-0.5 shrink-0 text-muted"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[0.8125rem] leading-snug text-ivory">
          {deliverable.title}
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[0.6875rem] text-muted">
          <span className="font-mono tracking-[0.06em] uppercase">
            {FORMAT_LABEL[deliverable.format]}
          </span>
          <span className="text-line-strong">·</span>
          <span>{project?.name}</span>
          <span className="text-line-strong">·</span>
          <span className="font-mono">{deliverable.sizeLabel}</span>
        </p>
        <SourceTag source={deliverable.source} className="mt-1" />
      </div>
      <span className="shrink-0 font-mono text-[0.625rem] whitespace-nowrap text-muted">
        {formatRelative(deliverable.producedAt)}
      </span>
    </>
  );

  return (
    <li>
      {deliverable.missionId ? (
        <Link
          href={`/missions/${deliverable.missionId}`}
          className="-mx-3 flex gap-3 rounded-sm px-3 py-3 transition-colors hover:bg-raised/60"
        >
          {body}
        </Link>
      ) : (
        <div className="flex gap-3 py-3">{body}</div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Historique                                                          */
/* ------------------------------------------------------------------ */

const HISTORY_LABEL: Record<HistoryEntry["kind"], string> = {
  mission: "Mission",
  decision: "Décision",
  execution: "Exécution",
};

export function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const project = projectsById[entry.projectId];

  return (
    <li>
      <Link
        href={entry.href}
        className="-mx-3 flex gap-3 rounded-sm px-3 py-3 transition-colors hover:bg-raised/60"
      >
        <StatusRail tone={entry.tone} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[0.8125rem] leading-snug text-ivory">
            {entry.title}
          </p>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">
            {entry.detail}
          </p>
          <p className="mt-1.5 font-mono text-[0.625rem] tracking-[0.06em] text-muted uppercase">
            {HISTORY_LABEL[entry.kind]}
            <span className="mx-1.5 text-line-strong">·</span>
            {project?.name}
            <span className="mx-1.5 text-line-strong">·</span>
            {entry.meta}
          </p>
        </div>
        <span className="shrink-0 font-mono text-[0.625rem] whitespace-nowrap text-muted tabular-nums">
          {formatStamp(entry.at)}
        </span>
      </Link>
    </li>
  );
}

/** Durée en monospace, alignée sur les chiffres. */
export function Duration({ minutes }: { minutes: number }) {
  return (
    <span className="font-mono text-xs text-ivory tabular-nums">
      {formatDuration(minutes)}
    </span>
  );
}
