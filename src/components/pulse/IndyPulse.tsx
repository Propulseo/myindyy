"use client";

import * as Popover from "@radix-ui/react-popover";
import Link from "next/link";
import { useId } from "react";
import { cn } from "@/components/primitives/cn";
import { formatRelative, plural } from "@/lib/format";
import type { PulseSnapshot } from "@/lib/selectors";
import {
  PULSE_BASELINE,
  PULSE_GRID_STEP,
  PULSE_HEIGHT,
  PULSE_WIDTH,
  buildPulseMarks,
} from "./geometry";

/**
 * Le Pouls Indy.
 *
 * Une bande de temps réelle : les douze dernières heures, bord droit = maintenant.
 * Traits bleus = missions actives, losanges ambre = décisions en attente,
 * encoches rouges = incidents. Le mouvement est lent et se coupe entièrement
 * sous `prefers-reduced-motion` — toute l'information tient dans la position
 * et la forme des marques.
 */
export function IndyPulse({
  snapshot,
  className,
}: {
  snapshot: PulseSnapshot;
  className?: string;
}) {
  const readout = `${snapshot.active} · ${snapshot.decisions} · ${snapshot.incidents}`;
  const spoken = `Pouls Indy : ${plural(snapshot.active, "mission active", "missions actives")}, ${plural(
    snapshot.decisions,
    "décision en attente",
    "décisions en attente",
  )}, ${plural(snapshot.incidents, "incident")}.`;

  return (
    <Popover.Root>
      <Popover.Trigger
        className={cn(
          "group flex items-center gap-3 rounded-sm border border-transparent px-2 py-1",
          "transition-colors hover:border-line hover:bg-surface",
          className,
        )}
        aria-label={spoken}
      >
        <PulseTape snapshot={snapshot} />
        <span className="hidden font-mono text-[0.6875rem] whitespace-nowrap text-muted lg:inline">
          <span className="text-indy">{snapshot.active}</span> actives
          <span className="mx-1.5 text-line-strong">·</span>
          <span className="text-attention">{snapshot.decisions}</span> décisions
          <span className="mx-1.5 text-line-strong">·</span>
          <span className={snapshot.incidents > 0 ? "text-danger" : "text-muted"}>
            {snapshot.incidents}
          </span>{" "}
          {snapshot.incidents > 1 ? "incidents" : "incident"}
        </span>
        <span
          aria-hidden
          className="font-mono text-[0.6875rem] whitespace-nowrap text-muted tabular-nums lg:hidden"
        >
          {readout}
        </span>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          sideOffset={10}
          collisionPadding={12}
          className={cn(
            "z-50 w-[min(20rem,calc(100vw-1.5rem))] rounded-md border border-line bg-surface p-1",
            "data-[state=open]:animate-rise",
          )}
        >
          <p className="px-3 pt-2.5 pb-1 label-mono">Pouls · douze dernières heures</p>
          <ul className="p-1">
            <PulseLine
              count={snapshot.active}
              tone="text-indy"
              label="missions actives"
              empty="Aucune mission en cours"
              href="/missions?statut=en_cours"
            />
            <PulseLine
              count={snapshot.decisions}
              tone="text-attention"
              label="décisions en attente"
              empty="Aucune décision en attente"
              href="/missions?statut=attente_validation"
            />
            <PulseLine
              count={snapshot.incidents}
              tone="text-danger"
              label="incidents ou blocages"
              empty="Aucun incident"
              href="/missions?statut=bloquee"
            />
          </ul>
          {snapshot.syncedAt ? (
            <p className="border-t border-line px-3 py-2 font-mono text-[0.625rem] text-muted">
              Dernière synchronisation {formatRelative(snapshot.syncedAt)}
            </p>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function PulseLine({
  count,
  tone,
  label,
  empty,
  href,
}: {
  count: number;
  tone: string;
  label: string;
  empty: string;
  href: string;
}) {
  return (
    <li>
      <Link
        href={href}
        className="flex items-baseline gap-3 rounded-sm px-2 py-2 transition-colors hover:bg-raised"
      >
        <span className={cn("font-mono text-base tabular-nums", count > 0 ? tone : "text-muted")}>
          {String(count).padStart(2, "0")}
        </span>
        <span className="text-[0.8125rem] text-ivory">
          {count > 0 ? label : empty}
        </span>
      </Link>
    </li>
  );
}

function PulseTape({ snapshot }: { snapshot: PulseSnapshot }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const sweepId = `pulse-sweep-${uid}`;
  const maskId = `pulse-mask-${uid}`;
  const marks = buildPulseMarks(snapshot.events);

  const gridTicks = Array.from({ length: 14 }, (_, index) => index * PULSE_GRID_STEP);

  return (
    <svg
      viewBox={`0 0 ${PULSE_WIDTH} ${PULSE_HEIGHT}`}
      width={PULSE_WIDTH}
      height={PULSE_HEIGHT}
      role="img"
      aria-hidden
      className="h-[28px] w-[132px] shrink-0 overflow-visible sm:w-[216px]"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={sweepId} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="var(--color-indy)" stopOpacity="0" />
          <stop offset="50%" stopColor="var(--color-indy)" stopOpacity="0.16" />
          <stop offset="100%" stopColor="var(--color-indy)" stopOpacity="0" />
        </linearGradient>
        <clipPath id={maskId}>
          <rect x="0" y="0" width={PULSE_WIDTH} height={PULSE_HEIGHT} />
        </clipPath>
      </defs>

      <g clipPath={`url(#${maskId})`}>
        {/* Trame horaire : elle dérive lentement vers la gauche. */}
        <g className="indy-pulse-drift">
          {gridTicks.map((x) => (
            <line
              key={x}
              x1={x}
              x2={x}
              y1={PULSE_BASELINE - 3}
              y2={PULSE_BASELINE + 4}
              stroke="var(--color-line-strong)"
              strokeWidth="1"
            />
          ))}
        </g>

        {/* Ligne de base. */}
        <line
          x1="0"
          x2={PULSE_WIDTH}
          y1={PULSE_BASELINE}
          y2={PULSE_BASELINE}
          stroke="var(--color-line-strong)"
          strokeWidth="1"
        />

        {/* Lueur qui balaie la bande. */}
        <rect
          className="indy-pulse-sweep"
          x="-96"
          y="0"
          width="96"
          height={PULSE_HEIGHT}
          fill={`url(#${sweepId})`}
        />

        {marks.map((mark) => {
          if (mark.kind === "active") {
            return (
              <line
                key={mark.id}
                x1={mark.x}
                x2={mark.x}
                y1={PULSE_BASELINE}
                y2={PULSE_BASELINE - mark.height}
                stroke="var(--color-indy)"
                strokeWidth="1.75"
                strokeLinecap="round"
              />
            );
          }
          if (mark.kind === "decision") {
            return (
              <rect
                key={mark.id}
                x={mark.x - 2.6}
                y={PULSE_BASELINE - 2.6}
                width="5.2"
                height="5.2"
                fill="var(--color-attention)"
                transform={`rotate(45 ${mark.x} ${PULSE_BASELINE})`}
              />
            );
          }
          return (
            <line
              key={mark.id}
              x1={mark.x}
              x2={mark.x}
              y1="3"
              y2={PULSE_HEIGHT - 3}
              stroke="var(--color-danger)"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          );
        })}
      </g>

      {/* L'instant présent, à l'extrême droite. */}
      <circle
        className="indy-pulse-now"
        cx={PULSE_WIDTH - 1.5}
        cy={PULSE_BASELINE}
        r="2.4"
        fill="var(--color-ivory)"
      />
    </svg>
  );
}
