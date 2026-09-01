import Link from "next/link";
import { cn } from "@/components/primitives/cn";
import { StatusMark, StatusPill, StatusRail } from "@/components/status/StatusMark";
import { peopleById, projectsById } from "@/fixtures";
import { formatDuration, formatEur, formatRelative, ratio } from "@/lib/format";
import { missionStatusMeta } from "@/lib/status";
import type { Mission } from "@/types/domain";

/**
 * L'unité de base du cockpit : une ligne, pas une carte.
 *
 * Rail de statut à gauche, titre, ligne de contexte, et à droite les mesures en
 * monospace. Quinze lignes se lisent d'un coup d'œil ; quinze cartes, non.
 */
export function MissionRow({ mission }: { mission: Mission }) {
  const meta = missionStatusMeta[mission.status];
  const project = projectsById[mission.projectId];
  const owner = peopleById[mission.ownerId];
  const running = mission.status === "en_cours";
  const budgetRatio = ratio(mission.budget.spentEur, mission.budget.capEur);
  const tight = budgetRatio >= 0.85;

  return (
    <li>
      <Link
        href={`/missions/${mission.id}`}
        className={cn(
          "group -mx-3 flex gap-3 rounded-sm px-3 py-3 transition-colors",
          "hover:bg-raised/60",
        )}
      >
        <StatusRail tone={meta.tone} />

        <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-start sm:gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <StatusMark
                shape={meta.shape}
                tone={meta.tone}
                live={running}
                className="translate-y-0.5 sm:hidden"
              />
              <h3 className="truncate text-sm leading-snug text-ivory">
                {mission.title}
              </h3>
            </div>
            <p className="mt-1 truncate text-xs text-muted">
              <span className="text-muted">{project?.name}</span>
              <span className="mx-1.5 text-line-strong">·</span>
              {owner?.name}
              <span className="mx-1.5 text-line-strong">·</span>
              <span className="font-mono">
                {mission.progress.done}/{mission.progress.total} {mission.progress.unit}
              </span>
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-3 sm:flex-col sm:items-end sm:gap-1.5">
            <StatusPill meta={meta} live={running} className="hidden sm:inline-flex" />
            <span className="font-mono text-[0.6875rem] whitespace-nowrap text-muted tabular-nums">
              <span className="text-ivory/80">
                {formatDuration(mission.duration.elapsedMin)}
              </span>
              <span className="mx-1.5 text-line-strong">·</span>
              <span className={tight ? "text-attention" : "text-ivory/80"}>
                {formatEur(mission.budget.spentEur)}
              </span>
              <span className="mx-1.5 hidden text-line-strong sm:inline">·</span>
              <span className="hidden sm:inline">
                {formatRelative(mission.lastActivityAt)}
              </span>
            </span>
            <StatusPill meta={meta} live={running} className="sm:hidden" />
          </div>
        </div>
      </Link>
    </li>
  );
}

/** Liste de missions. Le nombre d'éléments est annoncé aux lecteurs d'écran. */
export function MissionList({
  missions,
  label,
}: {
  missions: Mission[];
  label: string;
}) {
  return (
    <ul className="divide-y divide-line" aria-label={`${label} : ${missions.length}`}>
      {missions.map((mission) => (
        <MissionRow key={mission.id} mission={mission} />
      ))}
    </ul>
  );
}
