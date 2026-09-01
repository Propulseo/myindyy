import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "./cn";
import { buttonClasses } from "./Button";

/**
 * En-tête de section : un filet, un titre en capitales monospace, un compteur.
 * C'est le seul « chrome » autorisé autour d'une liste — pas de carte.
 */
export function Section({
  title,
  count,
  action,
  children,
  className,
  id,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn("min-w-0", className)} aria-labelledby={id ? `${id}-title` : undefined}>
      <div className="flex items-center gap-3 border-b border-line pb-2">
        <h2
          id={id ? `${id}-title` : undefined}
          className="label-mono text-ivory/80"
        >
          {title}
        </h2>
        {typeof count === "number" ? (
          <span className="font-mono text-[0.6875rem] text-muted tabular-nums">
            {String(count).padStart(2, "0")}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">{action}</div>
      </div>
      <div className="mt-1">{children}</div>
    </section>
  );
}

/** Titre de page. La serif nomme, la sans explique. */
export function PageHeading({
  title,
  lede,
  aside,
}: {
  title: string;
  lede?: string;
  aside?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-display text-[1.75rem] leading-tight text-ivory sm:text-[2.125rem]">
          {title}
        </h1>
        {lede ? (
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{lede}</p>
        ) : null}
      </div>
      {aside ? <div className="flex items-center gap-2">{aside}</div> : null}
    </div>
  );
}

export type StateKind = "vide" | "erreur" | "restreint";

/**
 * États vide, erreur et accès restreint. Une phrase en serif, une explication,
 * au plus une action. Jamais d'illustration.
 */
export function StateBlock({
  kind,
  title,
  message,
  action,
}: {
  kind: StateKind;
  title: string;
  message: string;
  action?: { label: string; href: string } | ReactNode;
}) {
  const accent =
    kind === "erreur"
      ? "border-danger/30 bg-danger/5"
      : kind === "restreint"
        ? "border-line bg-surface/50"
        : "border-line bg-transparent";

  return (
    <div
      className={cn("rounded-md border border-dashed px-5 py-8 text-center", accent)}
      role={kind === "erreur" ? "alert" : undefined}
    >
      <p className="font-display text-lg text-ivory">{title}</p>
      <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted">
        {message}
      </p>
      {action ? (
        <div className="mt-4 flex justify-center">
          {isLinkAction(action) ? (
            <Link href={action.href} className={buttonClasses("quiet", "sm")}>
              {action.label}
            </Link>
          ) : (
            action
          )}
        </div>
      ) : null}
    </div>
  );
}

function isLinkAction(value: unknown): value is { label: string; href: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "href" in value &&
    "label" in value
  );
}

/** Lignes fantômes pendant le chargement. Statiques sous prefers-reduced-motion. */
export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <ul className="divide-y divide-line" aria-hidden>
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} className="flex items-center gap-4 py-3.5">
          <span className="h-6 w-0.5 shrink-0 bg-line-strong" />
          <span className="flex-1 space-y-2">
            <span
              className="block h-3 rounded-xs bg-line-strong/70 motion-safe:animate-breathe"
              style={{ width: `${58 + ((index * 13) % 30)}%` }}
            />
            <span
              className="block h-2.5 rounded-xs bg-line/80 motion-safe:animate-breathe"
              style={{ width: `${34 + ((index * 17) % 28)}%` }}
            />
          </span>
          <span className="hidden h-2.5 w-16 rounded-xs bg-line/80 sm:block" />
        </li>
      ))}
    </ul>
  );
}

export function LoadingSection({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      <SkeletonRows />
    </div>
  );
}

/** Couple libellé / valeur, aligné, utilisé dans les panneaux de détail. */
export function KeyValue({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="label-mono">{label}</dt>
      <dd className="mt-1 text-sm break-words text-ivory">{children}</dd>
    </div>
  );
}
