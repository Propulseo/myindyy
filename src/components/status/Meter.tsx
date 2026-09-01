import { cn } from "@/components/primitives/cn";
import { formatDuration, formatEur, ratio } from "@/lib/format";
import { toneClasses, type Tone } from "@/lib/status";
import type { Provenance } from "@/types/domain";
import { sourceMeta } from "@/lib/status";

function meterTone(value: number): Tone {
  if (value >= 1) return "danger";
  if (value >= 0.85) return "attention";
  return "active";
}

/**
 * Jauge d'un budget ou d'une durée. Deux pixels de haut : elle informe sans décorer.
 * La valeur chiffrée reste en monospace pour ne pas trembler quand elle change.
 */
export function Meter({
  label,
  value,
  cap,
  kind,
  className,
}: {
  label: string;
  value: number;
  cap: number;
  kind: "budget" | "duree";
  className?: string;
}) {
  const filled = ratio(value, cap);
  const tone = meterTone(filled);
  const readable =
    kind === "budget"
      ? `${formatEur(value)} sur ${formatEur(cap)}`
      : `${formatDuration(value)} sur ${formatDuration(cap)}`;

  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="label-mono">{label}</span>
        <span
          className={cn(
            "font-mono text-xs tabular-nums",
            filled >= 0.85 ? toneClasses[tone].text : "text-ivory",
          )}
        >
          {kind === "budget" ? formatEur(value) : formatDuration(value)}
          <span className="text-muted">
            {" / "}
            {kind === "budget" ? formatEur(cap) : formatDuration(cap)}
          </span>
        </span>
      </div>
      <div
        className="mt-1.5 h-0.5 w-full overflow-hidden rounded-full bg-line"
        role="meter"
        aria-valuenow={Math.round(filled * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} : ${readable}`}
      >
        <div
          className={cn("h-full rounded-full", toneClasses[tone].mark)}
          style={{ width: `${Math.max(2, filled * 100)}%` }}
        />
      </div>
    </div>
  );
}

/** Avancement d'une mission : « 18 pages sur 24 ». */
export function Progress({
  done,
  total,
  unit,
  className,
}: {
  done: number;
  total: number;
  unit: string;
  className?: string;
}) {
  const filled = ratio(done, total);
  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="label-mono">Avancement</span>
        <span className="font-mono text-xs text-ivory tabular-nums">
          {done}
          <span className="text-muted"> / {total}</span>
          <span className="ml-1.5 text-muted">{unit}</span>
        </span>
      </div>
      <div
        className="mt-1.5 h-0.5 w-full overflow-hidden rounded-full bg-line"
        role="progressbar"
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={`Avancement : ${done} ${unit} sur ${total}`}
      >
        <div
          className="h-full rounded-full bg-indy"
          style={{ width: `${Math.max(2, filled * 100)}%` }}
        />
      </div>
    </div>
  );
}

/**
 * D'où vient cette information. Discret, monospace, jamais mis en avant —
 * mais toujours présent, parce qu'Indy n'est la source de vérité de rien.
 */
export function SourceTag({
  source,
  className,
}: {
  source: Provenance;
  className?: string;
}) {
  const meta = sourceMeta[source.system];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-[0.6875rem] text-muted",
        className,
      )}
    >
      <span aria-hidden className="size-1 rounded-full bg-muted/70" />
      <span className="truncate">{source.reference}</span>
      <span className="sr-only">— source : {meta.label}, {meta.role}</span>
    </span>
  );
}
