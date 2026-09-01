"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/primitives/Button";
import { KeyValue, PageHeading, Section, StateBlock } from "@/components/primitives/Layout";
import { Meter } from "@/components/status/Meter";
import { MissionRow } from "@/components/mission/MissionRow";
import { AutomationRow } from "@/components/automation/AutomationRow";
import { DeliverableRow, TaskRow } from "@/components/data/Rows";
import { useShellActions } from "@/components/shell/AppShell";
import { peopleById } from "@/fixtures";
import { useCockpit } from "@/lib/cockpit";
import { formatEur, formatRelative, plural } from "@/lib/format";
import {
  projectSpend,
  visibleAutomations,
  visibleDeliverables,
  visibleMissions,
  visibleProjects,
  visibleTasks,
} from "@/lib/selectors";
import { sourceMeta } from "@/lib/status";

export function ProjectDetail({ projectId }: { projectId: string }) {
  const { viewer, data } = useCockpit();
  const { openNewMission } = useShellActions();

  const project = useMemo(
    () => visibleProjects(data, viewer).find((item) => item.id === projectId),
    [data, viewer, projectId],
  );

  const missions = useMemo(
    () =>
      visibleMissions(data, viewer).filter((item) => item.projectId === projectId),
    [data, viewer, projectId],
  );
  const tasks = useMemo(
    () => visibleTasks(data, viewer).filter((item) => item.projectId === projectId),
    [data, viewer, projectId],
  );
  const deliverables = useMemo(
    () =>
      visibleDeliverables(data, viewer)
        .filter((item) => item.projectId === projectId)
        .slice(0, 6),
    [data, viewer, projectId],
  );
  const automations = useMemo(
    () =>
      visibleAutomations(data, viewer).filter((item) => item.projectId === projectId),
    [data, viewer, projectId],
  );

  if (!project) {
    return (
      <div className="space-y-6">
        <Back />
        <StateBlock
          kind="restreint"
          title="Ce projet ne vous est pas accessible."
          message="Il ne fait pas partie des projets qui vous sont affectés dans l'ERP."
          action={{ label: "Retour aux projets", href: "/projets" }}
        />
      </div>
    );
  }

  const active = missions.filter(
    (mission) =>
      mission.status === "en_cours" ||
      mission.status === "en_attente" ||
      mission.status === "attente_validation" ||
      mission.status === "bloquee",
  );
  const members = project.memberIds.map((id) => peopleById[id]).filter(Boolean);
  const spend = projectSpend(data, project.id);

  return (
    <div className="space-y-8">
      <Back />

      <PageHeading
        title={project.name}
        lede={project.summary}
        aside={
          <Button variant="quiet" size="sm" onClick={() => openNewMission(project.id)}>
            Nouvelle mission
          </Button>
        }
      />

      <dl className="grid gap-4 border-y border-line py-4 sm:grid-cols-2 lg:grid-cols-4">
        <KeyValue label="Nature">
          {project.kind === "client"
            ? "Projet client"
            : project.kind === "produit"
              ? "Produit"
              : "Interne"}{" "}
          · {project.domain === "technique" ? "technique" : "commercial"}
        </KeyValue>
        <KeyValue label="Responsable">{peopleById[project.ownerId]?.name}</KeyValue>
        <KeyValue label="Membres affectés">
          <span className="flex flex-wrap gap-x-2 gap-y-1">
            {members.map((member) => (
              <span key={member.id} className="text-sm">
                {member.name}
                <span className="ml-1 font-mono text-[0.625rem] text-muted">
                  {member.role.toLowerCase()}
                </span>
              </span>
            ))}
          </span>
        </KeyValue>
        <KeyValue label="Consommé par les missions">
          <span className="font-mono text-[0.8125rem]">{formatEur(spend)}</span>
        </KeyValue>
      </dl>

      <div className="grid gap-8 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-8">
          <Section id="missions-actives" title="Missions actives" count={active.length}>
            {active.length === 0 ? (
              <StateBlock
                kind="vide"
                title="Rien ne tourne sur ce projet."
                message="Aucune mission en cours, en file, bloquée ou en attente de validation."
                action={
                  <Button
                    variant="quiet"
                    size="sm"
                    onClick={() => openNewMission(project.id)}
                  >
                    Nouvelle mission
                  </Button>
                }
              />
            ) : (
              <ul className="divide-y divide-line">
                {active.map((mission) => (
                  <MissionRow key={mission.id} mission={mission} />
                ))}
              </ul>
            )}
          </Section>

          <Section
            id="taches-projet"
            title="Tâches Obsidian partagées"
            count={tasks.length}
          >
            {tasks.length === 0 ? (
              <p className="py-3 text-xs text-muted">
                Aucune tâche partagée n&apos;est ouverte sur ce projet aujourd&apos;hui.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {tasks.map((task) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </ul>
            )}
          </Section>

          <Section id="automatisations-projet" title="Automatisations" count={automations.length}>
            {automations.length === 0 ? (
              <p className="py-3 text-xs text-muted">
                Aucune récurrence n&apos;est configurée sur ce projet.
              </p>
            ) : (
              <div>
                {automations.map((automation) => (
                  <AutomationRow key={automation.id} automation={automation} />
                ))}
              </div>
            )}
          </Section>
        </div>

        <div className="space-y-7">
          <div className="rounded-md border border-line bg-surface/60 p-4">
            <Meter
              label="Budget agent du projet"
              kind="budget"
              value={project.budgetSpentEur}
              cap={project.budgetCapEur}
            />
            <p className="mt-3 text-xs leading-relaxed text-muted">
              Plafond mensuel défini dans l&apos;ERP. Au-delà, les missions du projet
              s&apos;arrêtent tant que le propriétaire n&apos;a pas autorisé de dépassement.
            </p>
          </div>

          <Section id="livrables-projet" title="Livrables récents" count={deliverables.length}>
            {deliverables.length === 0 ? (
              <p className="py-3 text-xs text-muted">Aucun livrable pour l&apos;instant.</p>
            ) : (
              <ul className="divide-y divide-line">
                {deliverables.map((deliverable) => (
                  <DeliverableRow key={deliverable.id} deliverable={deliverable} />
                ))}
              </ul>
            )}
          </Section>

        </div>
      </div>

      <Section
        id="sources-projet"
        title="Sources connectées"
        count={project.connectedSources.length}
        action={
          <span className="font-mono text-[0.625rem] text-muted">
            synchronisé {formatRelative(project.source.syncedAt)}
            <span className="mx-1.5 text-line-strong">·</span>
            {plural(missions.length, "mission")} au total
          </span>
        }
      >
        <ul className="grid gap-x-8 sm:grid-cols-2 lg:grid-cols-3">
          {project.connectedSources.map((system) => (
            <li
              key={system}
              className="flex items-baseline gap-3 border-b border-line py-2.5"
            >
              <span className="w-20 shrink-0 font-mono text-[0.6875rem] text-ivory">
                {sourceMeta[system].label}
              </span>
              <span className="min-w-0 flex-1 text-xs text-muted">
                {sourceMeta[system].role}
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function Back() {
  return (
    <Link
      href="/projets"
      className="inline-flex items-center gap-1.5 font-mono text-[0.6875rem] text-muted transition-colors hover:text-ivory"
    >
      <ArrowLeft aria-hidden size={13} strokeWidth={1.75} />
      Projets
    </Link>
  );
}
