import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { StatusMark, StatusRail } from "@/components/status/StatusMark";
import { projectsById } from "@/fixtures";
import { formatRelative } from "@/lib/format";
import type { AttentionItem } from "@/lib/selectors";
import type { Shape } from "@/lib/status";

const SHAPE_BY_KIND: Record<AttentionItem["kind"], Shape> = {
  decision: "diamond",
  blocage: "bar",
  echec: "cross",
  echeance: "diamond",
  inactivite: "ring",
  limite: "bar",
  automatisation: "diamond",
};

const KIND_LABEL: Record<AttentionItem["kind"], string> = {
  decision: "Décision",
  blocage: "Blocage",
  echec: "Échec",
  echeance: "Échéance",
  inactivite: "Inactivité",
  limite: "Garde-fou",
  automatisation: "Signalement",
};

/**
 * Une ligne de « À traiter ». Elle dit ce qui est en jeu et ce qui se passera,
 * puis mène directement à l'endroit où l'on répond. Pas de bouton d'action ici :
 * la décision se prend sur la mission, avec tout son contexte sous les yeux.
 */
export function AttentionRow({ item }: { item: AttentionItem }) {
  const project = projectsById[item.projectId];

  return (
    <li>
      <Link
        href={item.href}
        className="group -mx-3 flex gap-3 rounded-sm px-3 py-3.5 transition-colors hover:bg-raised/60"
      >
        <StatusRail tone={item.tone} />

        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <StatusMark
              shape={SHAPE_BY_KIND[item.kind]}
              tone={item.tone}
              className="mt-1 shrink-0"
            />
            <h3 className="min-w-0 flex-1 text-sm leading-snug text-ivory">
              {item.headline}
            </h3>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted">{item.detail}</p>
          <p className="mt-1.5 font-mono text-[0.625rem] tracking-[0.06em] text-muted uppercase">
            {KIND_LABEL[item.kind]}
            <span className="mx-1.5 text-line-strong">·</span>
            {project?.name}
            <span className="mx-1.5 text-line-strong">·</span>
            {formatRelative(item.at)}
          </p>
        </div>

        <ChevronRight
          aria-hidden
          size={15}
          strokeWidth={1.6}
          className="mt-0.5 shrink-0 self-center text-line-strong transition-colors group-hover:text-muted"
        />
      </Link>
    </li>
  );
}
