import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/components/primitives/cn";
import { StatusMark, StatusPill, StatusRail } from "@/components/status/StatusMark";
import { SourceTag } from "@/components/status/Meter";
import { projectsById } from "@/fixtures";
import { formatDuration, formatRelative, formatStamp, plural } from "@/lib/format";
import { automationHealthMeta, runOutcomeMeta } from "@/lib/status";
import type { Automation } from "@/types/domain";

/**
 * Une automatisation tient sur une ligne : nom, cadence, état de santé, compteur.
 * L'historique des exécutions est replié — c'était le principal bruit de l'ancien
 * écran « Crons », où chaque récurrence occupait une carte entière.
 */
export function AutomationRow({ automation }: { automation: Automation }) {
  const health = automationHealthMeta[automation.health];
  const project = projectsById[automation.projectId];

  return (
    <details id={automation.id} className="group border-b border-line last:border-b-0">
      <summary
        className={cn(
          "-mx-3 flex cursor-pointer list-none gap-3 rounded-sm px-3 py-3.5 transition-colors",
          "hover:bg-raised/60 [&::-webkit-details-marker]:hidden",
        )}
      >
        <StatusRail tone={health.tone} />

        <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-4">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm leading-snug text-ivory">{automation.name}</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted">{automation.purpose}</p>
            <p className="mt-1.5 font-mono text-[0.625rem] text-muted">
              {automation.cadenceLabel}
              <span className="mx-1.5 text-line-strong">·</span>
              {plural(automation.runCount, "exécution")}
              <span className="mx-1.5 text-line-strong">·</span>
              dernière {formatRelative(automation.lastRunAt)}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-3 sm:flex-col sm:items-end sm:gap-1.5">
            <StatusPill meta={health} />
            <span className="font-mono text-[0.625rem] whitespace-nowrap text-muted">
              {project?.name}
            </span>
          </div>
        </div>

        <ChevronRight
          aria-hidden
          size={15}
          strokeWidth={1.6}
          className="mt-0.5 shrink-0 self-center text-line-strong transition-transform group-open:rotate-90"
        />
      </summary>

      <div className="pb-4 pl-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 font-mono text-[0.625rem] text-muted">
          <span>
            Durée habituelle{" "}
            <span className="text-ivory">
              {formatDuration(automation.typicalDurationMin)}
            </span>
          </span>
          <span>
            Tentatives habituelles{" "}
            <span className="text-ivory">{automation.typicalAttempts}</span>
          </span>
          <SourceTag source={automation.source} />
        </div>

        <ul className="mt-2 divide-y divide-line/70">
          {automation.runs.map((run) => {
            const outcome = runOutcomeMeta[run.outcome];
            return (
              <li key={run.id} className="flex items-start gap-3 py-2">
                <StatusMark
                  shape={outcome.shape}
                  tone={outcome.tone}
                  className="mt-0.5 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-ivory/90">
                    {run.note ?? outcome.label}
                  </p>
                  <p className="mt-0.5 font-mono text-[0.625rem] text-muted tabular-nums">
                    {formatStamp(run.at)}
                    <span className="mx-1.5 text-line-strong">·</span>
                    <span
                      className={
                        run.durationMin > automation.typicalDurationMin * 1.5
                          ? "text-attention"
                          : undefined
                      }
                    >
                      {formatDuration(run.durationMin)}
                    </span>
                    <span className="mx-1.5 text-line-strong">·</span>
                    <span
                      className={
                        run.attempts > automation.typicalAttempts
                          ? "text-attention"
                          : undefined
                      }
                    >
                      {plural(run.attempts, "tentative")}
                    </span>
                  </p>
                </div>
                {run.missionId ? (
                  <Link
                    href={`/missions/${run.missionId}`}
                    className="shrink-0 font-mono text-[0.625rem] text-indy hover:underline"
                  >
                    Voir la mission
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </details>
  );
}
