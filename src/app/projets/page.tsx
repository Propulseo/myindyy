"use client";

import Link from "next/link";
import { useMemo } from "react";
import { PageHeading, Section } from "@/components/primitives/Layout";
import { AgentActivitySummary } from "@/components/project/AgentActivity";
import { ScreenState } from "@/components/shell/ScreenState";
import { useCockpit } from "@/lib/cockpit";
import { plural } from "@/lib/format";
import {
  projectAgentActivity,
  visibleMissions,
  visibleProjects,
} from "@/lib/selectors";
import type { Dataset } from "@/lib/selectors";
import type { Project } from "@/types/domain";

const DOMAIN_LABEL = {
  technique: "Technique",
  commercial: "Commercial",
} as const;

const KIND_LABEL = {
  interne: "Interne",
  produit: "Produit",
  client: "Client",
} as const;

export default function ProjectsPage() {
  const { viewer, data } = useCockpit();
  const projects = useMemo(() => visibleProjects(data, viewer), [data, viewer]);
  const missions = useMemo(() => visibleMissions(data, viewer), [data, viewer]);

  const technical = projects.filter((project) => project.domain === "technique");
  const commercial = projects.filter((project) => project.domain === "commercial");

  function activeCount(projectId: string) {
    return missions.filter(
      (mission) =>
        mission.projectId === projectId &&
        (mission.status === "en_cours" ||
          mission.status === "en_attente" ||
          mission.status === "attente_validation"),
    ).length;
  }

  return (
    <div className="space-y-8">
      <PageHeading
        title="Projets"
        lede={`${plural(projects.length, "projet")} vous ${projects.length > 1 ? "sont affectés" : "est affecté"}. Un projet non affecté n'apparaît nulle part, pas même en grisé.`}
      />

      <ScreenState
        isEmpty={projects.length === 0}
        loadingLabel="Chargement des projets"
        emptyTitle="Aucun projet ne vous est affecté."
        emptyMessage="Demandez au propriétaire d'un projet de vous ajouter à ses membres dans l'ERP."
      >
        <div className="space-y-8">
          {technical.length > 0 ? (
            <Section id="techniques" title="Projets techniques" count={technical.length}>
              <ul className="divide-y divide-line">
                {technical.map((project) => (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    active={activeCount(project.id)}
                    data={data}
                  />
                ))}
              </ul>
            </Section>
          ) : null}

          {commercial.length > 0 ? (
            <Section id="commerciaux" title="Projets commerciaux" count={commercial.length}>
              <ul className="divide-y divide-line">
                {commercial.map((project) => (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    active={activeCount(project.id)}
                    data={data}
                  />
                ))}
              </ul>
            </Section>
          ) : null}
        </div>
      </ScreenState>
    </div>
  );
}

function ProjectRow({
  project,
  active,
  data,
}: {
  project: Project;
  active: number;
  data: Dataset;
}) {
  const activity = projectAgentActivity(data, project.id);
  return (
    <li>
      <Link
        href={`/projets/${project.id}`}
        className="group -mx-3 flex flex-col gap-3 rounded-sm px-3 py-4 transition-colors hover:bg-raised/60 sm:flex-row sm:items-start sm:gap-6"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <h3 className="font-display text-lg leading-tight text-ivory">
              {project.name}
            </h3>
            <span className="font-mono text-[0.625rem] tracking-[0.08em] text-muted uppercase">
              {KIND_LABEL[project.kind]} · {DOMAIN_LABEL[project.domain]}
            </span>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">{project.summary}</p>
          <p className="mt-2 font-mono text-[0.625rem] text-muted">
            {active > 0
              ? plural(active, "mission active", "missions actives")
              : "aucune mission active"}
            <span className="mx-1.5 text-line-strong">·</span>
            {plural(project.memberIds.length, "membre")}
          </p>
        </div>

        <div className="w-full shrink-0 sm:w-52">
          <AgentActivitySummary activity={activity} />
        </div>
      </Link>
    </li>
  );
}
