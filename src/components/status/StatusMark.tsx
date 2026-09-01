import { cn } from "@/components/primitives/cn";
import { toneClasses, type Shape, type StatusMeta, type Tone } from "@/lib/status";

/**
 * La pastille d'état. Chaque état a sa forme : un daltonien lit l'écran sans la couleur.
 * Toujours accompagnée d'un libellé écrit, jamais seule.
 */
export function StatusMark({
  shape,
  tone,
  live = false,
  className,
}: {
  shape: Shape;
  tone: Tone;
  /** Ajoute une pulsation lente pour signaler que quelque chose tourne. */
  live?: boolean;
  className?: string;
}) {
  const color = toneClasses[tone].text;

  const inner = (() => {
    switch (shape) {
      case "filled":
        return <span className="block size-2 rounded-full bg-current" />;
      case "ring":
        return (
          <span className="block size-2 rounded-full border-[1.5px] border-current" />
        );
      case "diamond":
        return <span className="block size-[7px] rotate-45 bg-current" />;
      case "bar":
        return <span className="block h-2.5 w-[3px] bg-current" />;
      case "cross":
        return (
          <svg viewBox="0 0 10 10" className="block size-2.5" aria-hidden>
            <path
              d="M1.5 1.5 8.5 8.5M8.5 1.5 1.5 8.5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        );
      case "dash":
        return <span className="block h-[1.5px] w-2.5 bg-current" />;
    }
  })();

  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-3 shrink-0 items-center justify-center",
        color,
        className,
      )}
    >
      {live ? (
        <span className="absolute inline-flex size-2 rounded-full bg-current opacity-40 motion-safe:animate-halo" />
      ) : null}
      {inner}
    </span>
  );
}

/** Pastille + libellé. Format compact, utilisé en tête de ligne et dans les en-têtes. */
export function StatusPill({
  meta,
  live = false,
  className,
}: {
  meta: StatusMeta;
  live?: boolean;
  className?: string;
}) {
  const tone = toneClasses[meta.tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-xs border px-1.5 py-0.5",
        "font-mono text-[0.625rem] tracking-[0.08em] uppercase",
        tone.chip,
        tone.border,
        tone.text,
        className,
      )}
    >
      <StatusMark shape={meta.shape} tone={meta.tone} live={live} className="size-2.5" />
      {meta.label}
    </span>
  );
}

/** Rail vertical coloré en tête de ligne : c'est lui qui remplace la carte. */
export function StatusRail({ tone }: { tone: Tone }) {
  return (
    <span
      aria-hidden
      className={cn("w-0.5 shrink-0 self-stretch rounded-full", toneClasses[tone].mark)}
    />
  );
}
