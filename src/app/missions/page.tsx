"use client";

import { Suspense, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/primitives/Button";
import { SearchInput, SelectInput } from "@/components/primitives/Form";
import { LoadingSection, PageHeading, Section } from "@/components/primitives/Layout";
import { MissionRow } from "@/components/mission/MissionRow";
import { ScreenState } from "@/components/shell/ScreenState";
import { useShellActions } from "@/components/shell/AppShell";
import { peopleById } from "@/fixtures";
import { useCockpit } from "@/lib/cockpit";
import { plural } from "@/lib/format";
import { visibleAutomations, visibleMissions, visibleProjects } from "@/lib/selectors";
import { missionStatusMeta, missionStatusOrder } from "@/lib/status";
import type { Mission, MissionStatus } from "@/types/domain";

const ANY = "tous";

/** Trois groupes seulement. Pas de tableau Kanban : une liste qui se lit de haut en bas. */
const GROUPS: { key: string; title: string; statuses: MissionStatus[] }[] = [
  {
    key: "attention",
    title: "Demandent une attention",
    statuses: ["attente_validation", "bloquee", "echouee"],
  },
  { key: "en-cours", title: "En cours", statuses: ["en_cours", "en_attente"] },
  { key: "termine", title: "Terminées", statuses: ["terminee", "annulee"] },
];

export default function MissionsPage() {
  return (
    <Suspense fallback={<LoadingSection label="Chargement des missions" />}>
      <MissionsScreen />
    </Suspense>
  );
}

function MissionsScreen() {
  const searchParams = useSearchParams();
  const { viewer, data, hasError } = useCockpit();
  const { openNewMission } = useShellActions();

  const missions = useMemo(() => visibleMissions(data, viewer), [data, viewer]);
  const projects = useMemo(() => visibleProjects(data, viewer), [data, viewer]);
  const automations = useMemo(() => visibleAutomations(data, viewer), [data, viewer]);

  const owners = useMemo(() => {
    const ids = new Set(missions.map((mission) => mission.ownerId));
    return [...ids].map((id) => peopleById[id]).filter(Boolean);
  }, [missions]);

  const urlStatus = searchParams.get("statut") ?? ANY;

  const [query, setQuery] = useState("");
  const [project, setProject] = useState(ANY);
  const [status, setStatus] = useState(urlStatus);
  const [owner, setOwner] = useState(ANY);
  const [automation, setAutomation] = useState(ANY);

  // Le Pouls renvoie vers une vue déjà filtrée : on suit ce que dit l'adresse,
  // en ajustant l'état pendant le rendu plutôt que dans un effet.
  const [lastUrlStatus, setLastUrlStatus] = useState(urlStatus);
  if (urlStatus !== lastUrlStatus) {
    setLastUrlStatus(urlStatus);
    setStatus(urlStatus);
  }

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return missions.filter((mission) => {
      if (project !== ANY && mission.projectId !== project) return false;
      if (status !== ANY && mission.status !== status) return false;
      if (owner !== ANY && mission.ownerId !== owner) return false;
      if (automation === "aucune" && mission.automationId) return false;
      if (
        automation !== ANY &&
        automation !== "aucune" &&
        mission.automationId !== automation
      ) {
        return false;
      }
      if (!needle) return true;
      return (
        mission.title.toLowerCase().includes(needle) ||
        mission.summary.toLowerCase().includes(needle) ||
        mission.reference.toLowerCase().includes(needle)
      );
    });
  }, [missions, query, project, status, owner, automation]);

  const grouped = useMemo(
    () =>
      GROUPS.map((group) => ({
        ...group,
        missions: sortForGroup(
          filtered.filter((mission) => group.statuses.includes(mission.status)),
        ),
      })),
    [filtered],
  );

  const active = [project, status, owner, automation].filter((value) => value !== ANY);
  const hasFilters = active.length > 0 || query.trim() !== "";

  function reset() {
    setQuery("");
    setProject(ANY);
    setStatus(ANY);
    setOwner(ANY);
    setAutomation(ANY);
  }

  return (
    <div className="space-y-8">
      <PageHeading
        title="Missions"
        lede={
          hasError
            ? "Les sources n'ont pas répondu. La liste n'est pas affichée tant que les données sont incomplètes."
            : `${plural(missions.length, "mission")} sur vos projets. Ce qui demande une attention est remonté en premier.`
        }
        aside={
          <Button variant="quiet" size="sm" onClick={() => openNewMission()}>
            Nouvelle mission
          </Button>
        }
      />

      <div className="space-y-3">
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
          <div className="sm:max-w-xs sm:flex-1">
            <label htmlFor="mission-search" className="sr-only">
              Rechercher une mission
            </label>
            <SearchInput
              id="mission-search"
              value={query}
              placeholder="Rechercher un titre, un résumé, une référence"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="grid flex-1 grid-cols-2 gap-2.5 sm:grid-cols-4">
            <Filter label="Projet" value={project} onChange={setProject}>
              <option value={ANY}>Tous les projets</option>
              {projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Filter>
            <Filter label="Statut" value={status} onChange={setStatus}>
              <option value={ANY}>Tous les statuts</option>
              {missionStatusOrder.map((key) => (
                <option key={key} value={key}>
                  {missionStatusMeta[key].label}
                </option>
              ))}
            </Filter>
            <Filter label="Responsable" value={owner} onChange={setOwner}>
              <option value={ANY}>Tous les responsables</option>
              {owners.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Filter>
            <Filter label="Automatisation" value={automation} onChange={setAutomation}>
              <option value={ANY}>Toutes origines</option>
              <option value="aucune">Lancées à la main</option>
              {automations.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Filter>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <p
            className="font-mono text-[0.6875rem] text-muted"
            role="status"
            aria-live="polite"
          >
            {hasError
              ? "résultats indisponibles"
              : plural(filtered.length, "mission trouvée", "missions trouvées")}
          </p>
          {hasFilters ? (
            <button
              type="button"
              onClick={reset}
              className="font-mono text-[0.6875rem] text-indy transition-colors hover:text-ivory"
            >
              Effacer les filtres
            </button>
          ) : null}
        </div>
      </div>

      <ScreenState
        isEmpty={filtered.length === 0}
        loadingLabel="Chargement des missions"
        emptyTitle={
          hasFilters ? "Aucune mission ne correspond." : "Aucune mission pour l'instant."
        }
        emptyMessage={
          hasFilters
            ? "Élargissez la recherche ou retirez un filtre pour voir davantage de résultats."
            : "Rien n'a encore été lancé sur les projets qui vous sont affectés."
        }
        emptyAction={
          hasFilters ? (
            <Button variant="quiet" size="sm" onClick={reset}>
              Effacer les filtres
            </Button>
          ) : (
            <Button variant="quiet" size="sm" onClick={() => openNewMission()}>
              Nouvelle mission
            </Button>
          )
        }
      >
        <div className="space-y-8">
          {grouped
            .filter((group) => group.missions.length > 0)
            .map((group) => (
              <Section key={group.key} id={group.key} title={group.title} count={group.missions.length}>
                <ul className="divide-y divide-line">
                  {group.missions.map((mission) => (
                    <MissionRow key={mission.id} mission={mission} />
                  ))}
                </ul>
              </Section>
            ))}
        </div>
      </ScreenState>
    </div>
  );
}

function Filter({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="sr-only" htmlFor={`filtre-${label}`}>
        {label}
      </label>
      <SelectInput
        id={`filtre-${label}`}
        className="h-9 text-[0.8125rem]"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </SelectInput>
    </div>
  );
}

function sortForGroup(missions: Mission[]): Mission[] {
  return [...missions].sort((a, b) => {
    const order =
      missionStatusOrder.indexOf(a.status) - missionStatusOrder.indexOf(b.status);
    if (order !== 0) return order;
    return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
  });
}
