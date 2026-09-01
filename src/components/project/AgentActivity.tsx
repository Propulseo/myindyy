import { cn } from "@/components/primitives/cn";
import { Readout } from "@/components/status/Meter";
import { formatDuration, formatPercent, plural } from "@/lib/format";
import { toneClasses } from "@/lib/status";
import type { AgentActivity } from "@/types/domain";

/** Le taux de réussite est le seul chiffre qui mérite une jauge sur cet écran. */
function SuccessBar({ rate }: { rate: number | null }) {
  if (rate === null) return null;
  const tone = rate >= 0.8 ? "success" : rate >= 0.5 ? "attention" : "danger";
  return (
    <div className="mt-1.5 h-0.5 w-full overflow-hidden rounded-full bg-line">
      <div
        className={cn("h-full rounded-full", toneClasses[tone].mark)}
        style={{ width: `${Math.max(2, rate * 100)}%` }}
      />
    </div>
  );
}

/**
 * Ce que les agents ont réellement fait sur un projet.
 *
 * Aucun coût : Codex tourne sur l'abonnement de l'utilisateur. Ce qui se mesure ici,
 * c'est le volume, la fiabilité, le temps et la charge humaine que le projet demande.
 */
export function AgentActivityPanel({
  activity,
  className,
}: {
  activity: AgentActivity;
  className?: string;
}) {
  return (
    <div className={cn("rounded-md border border-line bg-surface/60 p-4", className)}>
      <p className="label-mono">Activité des agents</p>

      {/* Pas de <dl> : `Readout` n'est pas une paire dt/dd, et un <dl> qui n'en contient
          pas est invalide — un lecteur d'écran annoncerait une liste de définitions vide. */}
      <div className="mt-3 space-y-3">
        <Readout label="Missions" value={String(activity.missionCount)} />

        <div>
          <Readout
            label="Taux de réussite"
            value={formatPercent(activity.successRate)}
            tone={
              activity.successRate === null
                ? undefined
                : activity.successRate >= 0.8
                  ? "success"
                  : activity.successRate >= 0.5
                    ? "attention"
                    : "danger"
            }
            hint={
              activity.closedCount === 0
                ? "aucune mission close"
                : `sur ${plural(activity.closedCount, "mission close", "missions closes")}`
            }
          />
          <SuccessBar rate={activity.successRate} />
        </div>

        <Readout
          label="Durée médiane"
          value={
            activity.medianDurationMin === null
              ? "—"
              : formatDuration(activity.medianDurationMin)
          }
        />

        <Readout
          label="Interventions humaines"
          value={String(activity.humanInterventions)}
          hint="instructions, décisions tranchées, annulations"
        />

        <Readout
          label="Missions bloquées"
          value={String(activity.blockedMissions)}
          tone={activity.blockedMissions > 0 ? "danger" : undefined}
        />
      </div>
    </div>
  );
}

/** Version d'une ligne, pour la liste des projets. */
export function AgentActivitySummary({
  activity,
  className,
}: {
  activity: AgentActivity;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      {/* Libellé sur sa propre ligne : sur une colonne étroite, le mettre en regard
          de la valeur le fait passer sur deux lignes et percuter le chiffre. */}
      <p className="label-mono">Activité des agents</p>
      <p className="mt-1 font-mono text-xs text-ivory tabular-nums">
        {formatPercent(activity.successRate)}
        <span className="text-muted"> réussies</span>
      </p>
      <SuccessBar rate={activity.successRate} />
      <p className="mt-1.5 font-mono text-[0.625rem] leading-relaxed text-muted">
        {plural(activity.missionCount, "mission")}
        <span className="mx-1.5 text-line-strong">·</span>
        {activity.medianDurationMin === null
          ? "durée médiane —"
          : `${formatDuration(activity.medianDurationMin)} en médiane`}
      </p>
      {/* Sur sa propre ligne : accroché à la précédente, le séparateur se retrouvait
          seul en tête de ligne au moindre repli. */}
      {activity.blockedMissions > 0 ? (
        <p className="font-mono text-[0.625rem] text-danger">
          {plural(activity.blockedMissions, "bloquée", "bloquées")}
        </p>
      ) : null}
    </div>
  );
}
