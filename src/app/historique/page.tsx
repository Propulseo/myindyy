"use client";

import { useMemo, useState } from "react";
import { SelectInput } from "@/components/primitives/Form";
import { PageHeading, Section } from "@/components/primitives/Layout";
import { HistoryRow } from "@/components/data/Rows";
import { ScreenState } from "@/components/shell/ScreenState";
import { useCockpit } from "@/lib/cockpit";
import { formatDay, plural } from "@/lib/format";
import { historyEntries, visibleProjects, type HistoryEntry } from "@/lib/selectors";

const ANY = "tous";

const KINDS = [
  { value: "mission", label: "Missions closes" },
  { value: "decision", label: "Décisions prises" },
  { value: "execution", label: "Exécutions notables" },
];

export default function HistoryPage() {
  const { viewer, data, hasError } = useCockpit();
  const entries = useMemo(() => historyEntries(data, viewer), [data, viewer]);
  const projects = useMemo(() => visibleProjects(data, viewer), [data, viewer]);

  const [kind, setKind] = useState(ANY);
  const [project, setProject] = useState(ANY);

  const filtered = useMemo(
    () =>
      entries.filter((entry) => {
        if (kind !== ANY && entry.kind !== kind) return false;
        if (project !== ANY && entry.projectId !== project) return false;
        return true;
      }),
    [entries, kind, project],
  );

  const days = useMemo(() => groupByDay(filtered), [filtered]);

  return (
    <div className="space-y-8">
      <PageHeading
        title="Historique"
        lede="Ce qui s'est passé, dans l'ordre. Les missions closes, les décisions prises et les exécutions qui sont sorties de l'ordinaire — les exécutions sans remarque n'y figurent pas."
      />

      <div className="grid max-w-md grid-cols-2 gap-2.5">
        <div>
          <label htmlFor="hist-type" className="sr-only">
            Type d&apos;entrée
          </label>
          <SelectInput
            id="hist-type"
            className="h-9 text-[0.8125rem]"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            <option value={ANY}>Tout l&apos;historique</option>
            {KINDS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </SelectInput>
        </div>
        <div>
          <label htmlFor="hist-projet" className="sr-only">
            Projet
          </label>
          <SelectInput
            id="hist-projet"
            className="h-9 text-[0.8125rem]"
            value={project}
            onChange={(event) => setProject(event.target.value)}
          >
            <option value={ANY}>Tous les projets</option>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </SelectInput>
        </div>
      </div>

      <p className="font-mono text-[0.6875rem] text-muted" role="status" aria-live="polite">
        {hasError ? "résultats indisponibles" : plural(filtered.length, "entrée")}
      </p>

      <ScreenState
        isEmpty={filtered.length === 0}
        loadingLabel="Chargement de l'historique"
        emptyTitle="Rien dans l'historique."
        emptyMessage="Aucune mission close, aucune décision prise et aucune exécution notable sur la période et les projets sélectionnés."
      >
        <div className="space-y-8">
          {days.map(([day, items]) => (
            <Section key={day} title={day} count={items.length}>
              <ul className="divide-y divide-line">
                {items.map((entry) => (
                  <HistoryRow key={entry.id} entry={entry} />
                ))}
              </ul>
            </Section>
          ))}
        </div>
      </ScreenState>
    </div>
  );
}

function groupByDay(entries: HistoryEntry[]): [string, HistoryEntry[]][] {
  const map = new Map<string, HistoryEntry[]>();
  for (const entry of entries) {
    const day = formatDay(entry.at);
    const bucket = map.get(day);
    if (bucket) bucket.push(entry);
    else map.set(day, [entry]);
  }
  return [...map.entries()];
}
