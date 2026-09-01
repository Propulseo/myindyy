"use client";

import { useMemo, useState } from "react";
import { SearchInput, SelectInput } from "@/components/primitives/Form";
import { PageHeading, Section } from "@/components/primitives/Layout";
import { DeliverableRow } from "@/components/data/Rows";
import { ScreenState } from "@/components/shell/ScreenState";
import { useCockpit } from "@/lib/cockpit";
import { formatDay, plural } from "@/lib/format";
import { visibleDeliverables, visibleProjects } from "@/lib/selectors";
import type { Deliverable, DeliverableFormat } from "@/types/domain";

const ANY = "tous";

const FORMATS: { value: DeliverableFormat; label: string }[] = [
  { value: "rapport", label: "Rapports" },
  { value: "code", label: "Code" },
  { value: "document", label: "Documents" },
  { value: "visuel", label: "Visuels" },
  { value: "message", label: "Messages" },
];

export default function DeliverablesPage() {
  const { viewer, data, hasError } = useCockpit();
  const deliverables = useMemo(() => visibleDeliverables(data, viewer), [data, viewer]);
  const projects = useMemo(() => visibleProjects(data, viewer), [data, viewer]);

  const [query, setQuery] = useState("");
  const [project, setProject] = useState(ANY);
  const [format, setFormat] = useState(ANY);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return deliverables.filter((item) => {
      if (project !== ANY && item.projectId !== project) return false;
      if (format !== ANY && item.format !== format) return false;
      if (!needle) return true;
      return item.title.toLowerCase().includes(needle);
    });
  }, [deliverables, query, project, format]);

  const days = useMemo(() => groupByDay(filtered), [filtered]);
  const hasFilters = query.trim() !== "" || project !== ANY || format !== ANY;

  return (
    <div className="space-y-8">
      <PageHeading
        title="Livrables"
        lede="Ce que les missions ont réellement produit. Chaque livrable renvoie à la mission qui l'a fait naître et au système où il vit."
      />

      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <div className="sm:max-w-xs sm:flex-1">
          <label htmlFor="livrable-search" className="sr-only">
            Rechercher un livrable
          </label>
          <SearchInput
            id="livrable-search"
            value={query}
            placeholder="Rechercher un livrable"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="grid flex-1 grid-cols-2 gap-2.5 sm:max-w-md">
          <div>
            <label htmlFor="livrable-projet" className="sr-only">
              Projet
            </label>
            <SelectInput
              id="livrable-projet"
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
          <div>
            <label htmlFor="livrable-format" className="sr-only">
              Format
            </label>
            <SelectInput
              id="livrable-format"
              className="h-9 text-[0.8125rem]"
              value={format}
              onChange={(event) => setFormat(event.target.value)}
            >
              <option value={ANY}>Tous les formats</option>
              {FORMATS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </SelectInput>
          </div>
        </div>
      </div>

      <p className="font-mono text-[0.6875rem] text-muted" role="status" aria-live="polite">
        {hasError ? "résultats indisponibles" : plural(filtered.length, "livrable")}
      </p>

      <ScreenState
        isEmpty={filtered.length === 0}
        loadingLabel="Chargement des livrables"
        emptyTitle={
          hasFilters ? "Aucun livrable ne correspond." : "Aucun livrable pour l'instant."
        }
        emptyMessage={
          hasFilters
            ? "Retirez un filtre pour élargir la recherche."
            : "Les livrables apparaissent dès qu'une mission produit un rapport, un document ou du code."
        }
      >
        <div className="space-y-8">
          {days.map(([day, items]) => (
            <Section key={day} title={day} count={items.length}>
              <ul className="divide-y divide-line">
                {items.map((deliverable) => (
                  <DeliverableRow key={deliverable.id} deliverable={deliverable} />
                ))}
              </ul>
            </Section>
          ))}
        </div>
      </ScreenState>
    </div>
  );
}

function groupByDay(items: Deliverable[]): [string, Deliverable[]][] {
  const map = new Map<string, Deliverable[]>();
  for (const item of items) {
    const day = formatDay(item.producedAt);
    const bucket = map.get(day);
    if (bucket) bucket.push(item);
    else map.set(day, [item]);
  }
  return [...map.entries()];
}
