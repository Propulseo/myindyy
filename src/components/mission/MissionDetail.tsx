"use client";

import * as Tabs from "@radix-ui/react-tabs";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Ban,
  CornerDownLeft,
  Pause,
  Play,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/primitives/Button";
import { cn } from "@/components/primitives/cn";
import { TextArea } from "@/components/primitives/Form";
import { KeyValue, Section, StateBlock } from "@/components/primitives/Layout";
import { Meter, Progress, Readout, SourceTag } from "@/components/status/Meter";
import { StatusMark, StatusPill } from "@/components/status/StatusMark";
import { DeliverableRow } from "@/components/data/Rows";
import { useSensitiveAction } from "@/components/decision/SensitiveAction";
import { peopleById, projectsById } from "@/fixtures";
import { can } from "@/lib/access";
import { useCockpit } from "@/lib/cockpit";
import { formatDayTime, formatDuration, formatRelative, formatStamp, minutesSince } from "@/lib/format";
import {
  STALE_AFTER_MIN,
  activeAgentCount,
  isStalled,
  visibleDeliverables,
  visibleMissions,
} from "@/lib/selectors";
import {
  agentStateMeta,
  autonomyMeta,
  decisionKindMeta,
  effortMeta,
  missionStatusMeta,
  stepStateMeta,
  toneClasses,
} from "@/lib/status";
import type { Decision, Mission } from "@/types/domain";

export function MissionDetail({ missionId }: { missionId: string }) {
  const { viewer, data, controlMission, sendInstruction } = useCockpit();

  const mission = useMemo(
    () => visibleMissions(data, viewer).find((item) => item.id === missionId),
    [data, viewer, missionId],
  );

  if (!mission) {
    return (
      <div className="space-y-6">
        <BackLink />
        <StateBlock
          kind="restreint"
          title="Cette mission ne vous est pas accessible."
          message="Elle appartient à un projet qui ne vous est pas affecté, ou elle n'existe pas. Demandez au propriétaire du projet de vous y ajouter."
          action={{ label: "Retour aux missions", href: "/missions" }}
        />
      </div>
    );
  }

  return (
    <MissionScreen
      mission={mission}
      onControl={controlMission}
      onInstruction={sendInstruction}
    />
  );
}

function MissionScreen({
  mission,
  onControl,
  onInstruction,
}: {
  mission: Mission;
  onControl: (
    id: string,
    action: "suspendre" | "reprendre" | "relancer" | "annuler",
  ) => void;
  onInstruction: (id: string, text: string) => void;
}) {
  const { viewer, data, resolveDecision } = useCockpit();
  const sensitive = useSensitiveAction();

  const meta = missionStatusMeta[mission.status];
  const project = projectsById[mission.projectId];
  const owner = peopleById[mission.ownerId];
  const running = mission.status === "en_cours";

  const decisions = useMemo(
    () => data.decisions.filter((item) => item.missionId === mission.id),
    [data.decisions, mission.id],
  );
  const pending = decisions.filter((item) => item.state === "en_attente");

  const deliverables = useMemo(
    () =>
      visibleDeliverables(data, viewer).filter(
        (item) => item.missionId === mission.id,
      ),
    [data, viewer, mission.id],
  );

  const canControl = can(viewer, "missions.control");
  const canCancel = can(viewer, "missions.cancel");
  const closed =
    mission.status === "terminee" ||
    mission.status === "echouee" ||
    mission.status === "annulee";

  function askCancel() {
    sensitive.request({
      kind: "annulation_mission",
      action: `Annuler la mission « ${mission.title} »`,
      target: `${mission.reference} · ${mission.progress.done}/${mission.progress.total} ${mission.progress.unit} faites`,
      projectId: mission.projectId,
      environment: "Exécution en cours sur le serveur",
      revision: mission.summary,
      consequence:
        "L'exécution s'arrête immédiatement. Les étapes déjà faites et leurs livrables sont conservés, la mission ne reprendra pas d'elle-même.",
      requiredCapability: "missions.cancel",
      confirmLabel: "Annuler la mission",
      onConfirm: () => onControl(mission.id, "annuler"),
    });
  }

  return (
    <div className="space-y-8">
      <BackLink />

      <header className="space-y-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="font-mono text-[0.6875rem] text-muted">
            {mission.reference}
          </span>
          <StatusPill meta={meta} live={running} />
          {mission.automationId ? (
            <Link
              href={`/automatisations#${mission.automationId}`}
              className="font-mono text-[0.6875rem] text-muted transition-colors hover:text-ivory"
            >
              issue d&apos;une automatisation
            </Link>
          ) : null}
        </div>

        <div>
          <h1 className="font-display text-[1.75rem] leading-tight text-ivory sm:text-[2.125rem]">
            {mission.title}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
            {mission.summary}
          </p>
        </div>

        <dl className="grid gap-4 border-y border-line py-4 sm:grid-cols-2 lg:grid-cols-4">
          <KeyValue label="Projet">
            <Link href={`/projets/${mission.projectId}`} className="hover:text-indy">
              {project?.name}
            </Link>
          </KeyValue>
          <KeyValue label="Responsable">{owner?.name}</KeyValue>
          <KeyValue label="Autonomie">{autonomyMeta[mission.autonomy].label}</KeyValue>
          <KeyValue label="Niveau d'effort">{effortMeta[mission.effort].label}</KeyValue>
          {mission.dueAt ? (
            <KeyValue label="Échéance">
              <span className="font-mono text-[0.8125rem]">
                {formatDayTime(mission.dueAt)}
              </span>
            </KeyValue>
          ) : null}
          <KeyValue label="Dernière synchronisation">
            <span className="font-mono text-[0.8125rem]">
              {formatDayTime(mission.source.syncedAt)}
            </span>
          </KeyValue>
        </dl>

        <MissionActions
          mission={mission}
          closed={closed}
          canControl={canControl}
          canCancel={canCancel}
          onControl={onControl}
          onCancel={askCancel}
        />
      </header>

      {pending.map((decision) => (
        <DecisionCallout
          key={decision.id}
          decision={decision}
          onApprove={() =>
            sensitive.request({
              kind: decision.kind,
              action: decision.title,
              target: decision.target,
              projectId: decision.projectId,
              environment: decision.environment,
              revision: decision.revision,
              consequence: decision.consequence,
              requiredCapability: decision.requiredCapability,
              typeToConfirm:
                decision.kind === "deploiement_production" ? "déployer" : undefined,
              onConfirm: () => resolveDecision(decision.id, true),
            })
          }
          onRefuse={() => resolveDecision(decision.id, false)}
        />
      ))}

      <Tabs.Root defaultValue="apercu">
        <Tabs.List
          aria-label="Sections de la mission"
          className="flex gap-1 overflow-x-auto border-b border-line"
        >
          {[
            ["apercu", "Vue d'ensemble"],
            ["activite", "Activité"],
            ["livrables", "Livrables"],
            ["diagnostic", "Diagnostic"],
          ].map(([value, label]) => (
            <Tabs.Trigger
              key={value}
              value={value}
              className={cn(
                "-mb-px border-b-2 px-3 py-2.5 text-[0.8125rem] whitespace-nowrap transition-colors",
                "border-transparent text-muted hover:text-ivory",
                "data-[state=active]:border-indy data-[state=active]:text-ivory",
              )}
            >
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value="apercu" className="pt-7 outline-none">
          <Overview mission={mission} deliverables={deliverables.length} />
        </Tabs.Content>

        <Tabs.Content value="activite" className="pt-7 outline-none">
          <Activity mission={mission} onInstruction={onInstruction} closed={closed} />
        </Tabs.Content>

        <Tabs.Content value="livrables" className="pt-7 outline-none">
          <Section title="Livrables" count={deliverables.length}>
            {deliverables.length === 0 ? (
              <StateBlock
                kind="vide"
                title="Aucun livrable pour l'instant."
                message="Les livrables apparaissent au fur et à mesure que les étapes produisent quelque chose."
              />
            ) : (
              <ul className="divide-y divide-line">
                {deliverables.map((deliverable) => (
                  <DeliverableRow key={deliverable.id} deliverable={deliverable} />
                ))}
              </ul>
            )}
          </Section>
        </Tabs.Content>

        <Tabs.Content value="diagnostic" className="pt-7 outline-none">
          <Diagnostics mission={mission} />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/missions"
      className="inline-flex items-center gap-1.5 font-mono text-[0.6875rem] text-muted transition-colors hover:text-ivory"
    >
      <ArrowLeft aria-hidden size={13} strokeWidth={1.75} />
      Missions
    </Link>
  );
}

function MissionActions({
  mission,
  closed,
  canControl,
  canCancel,
  onControl,
  onCancel,
}: {
  mission: Mission;
  closed: boolean;
  canControl: boolean;
  canCancel: boolean;
  onControl: (
    id: string,
    action: "suspendre" | "reprendre" | "relancer" | "annuler",
  ) => void;
  onCancel: () => void;
}) {
  const showSuspend = mission.status === "en_cours";
  const showResume = mission.status === "en_attente";
  const showRelaunch = closed;

  if (!canControl && !canCancel) {
    return (
      <p className="text-xs text-muted">
        Votre rôle permet de suivre cette mission, pas de la piloter.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {canControl && showSuspend ? (
        <Button size="sm" onClick={() => onControl(mission.id, "suspendre")}>
          <Pause aria-hidden size={13} strokeWidth={1.75} />
          Suspendre
        </Button>
      ) : null}
      {canControl && showResume ? (
        <Button size="sm" onClick={() => onControl(mission.id, "reprendre")}>
          <Play aria-hidden size={13} strokeWidth={1.75} />
          Reprendre
        </Button>
      ) : null}
      {canControl && showRelaunch ? (
        <Button size="sm" onClick={() => onControl(mission.id, "relancer")}>
          <RotateCcw aria-hidden size={13} strokeWidth={1.75} />
          Relancer
        </Button>
      ) : null}
      {canCancel && !closed ? (
        <Button size="sm" variant="danger" onClick={onCancel}>
          <Ban aria-hidden size={13} strokeWidth={1.75} />
          Annuler
        </Button>
      ) : null}
    </div>
  );
}

function DecisionCallout({
  decision,
  onApprove,
  onRefuse,
}: {
  decision: Decision;
  onApprove: () => void;
  onRefuse: () => void;
}) {
  const { viewer } = useCockpit();
  const meta = decisionKindMeta[decision.kind];
  const allowed = can(viewer, decision.requiredCapability);

  return (
    <section
      aria-label={`Décision en attente : ${decision.title}`}
      className={cn(
        "relative overflow-hidden rounded-md border border-line bg-surface px-4 py-4 sm:px-5",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-0.5",
          toneClasses[meta.tone].mark,
        )}
      />
      <p className={cn("label-mono", toneClasses[meta.tone].text)}>
        {meta.label} · en attente
      </p>
      <h2 className="mt-1.5 font-display text-lg leading-tight text-ivory">
        {decision.title}
      </h2>

      <dl className="mt-4 grid gap-3.5 sm:grid-cols-2">
        <KeyValue label="Cible">
          <span className="font-mono text-[0.8125rem]">{decision.target}</span>
        </KeyValue>
        <KeyValue label="Environnement">
          <span className="font-mono text-[0.8125rem]">{decision.environment}</span>
        </KeyValue>
      </dl>

      <p className="mt-3.5 text-[0.8125rem] leading-relaxed text-ivory/90">
        {decision.consequence}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {allowed ? (
          <>
            <Button variant="primary" size="sm" onClick={onApprove}>
              Examiner et approuver
            </Button>
            <Button variant="ghost" size="sm" onClick={onRefuse}>
              Refuser
            </Button>
          </>
        ) : (
          <p className="text-xs text-muted">
            Votre rôle ne permet pas de répondre à cette décision. Elle attend le rôle
            qui en a la charge.
          </p>
        )}
        <span className="ml-auto font-mono text-[0.625rem] text-muted">
          demandée {formatRelative(decision.requestedAt)}
        </span>
      </div>

      <SourceTag source={decision.source} className="mt-3" />
    </section>
  );
}

function Overview({
  mission,
  deliverables,
}: {
  mission: Mission;
  deliverables: number;
}) {
  const activeAgents = activeAgentCount(mission);
  const stalled = isStalled(mission);
  const idleMin = minutesSince(mission.lastActivityAt);

  return (
    <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr]">
      <div className="space-y-8">
        <Section title="Étapes" count={mission.steps.length}>
          <ol className="divide-y divide-line">
            {mission.steps.map((step) => {
              const meta = stepStateMeta[step.state];
              return (
                <li key={step.id} className="flex items-start gap-3 py-3">
                  <StatusMark
                    shape={meta.shape}
                    tone={meta.tone}
                    live={step.state === "current"}
                    className="mt-0.5 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        "text-[0.8125rem] leading-snug",
                        step.state === "todo" || step.state === "skipped"
                          ? "text-muted"
                          : "text-ivory",
                      )}
                    >
                      {step.label}
                    </p>
                    {step.detail ? (
                      <p className="mt-1 text-xs leading-relaxed text-muted">
                        {step.detail}
                      </p>
                    ) : null}
                  </div>
                  <span className="shrink-0 font-mono text-[0.625rem] whitespace-nowrap text-muted tabular-nums">
                    {step.durationMin ? `${step.durationMin} min` : meta.label}
                  </span>
                </li>
              );
            })}
          </ol>
          <SourceTag source={mission.source} className="mt-3" />
        </Section>

        <Section title="Agents impliqués" count={mission.agents.length}>
          {mission.agents.length === 0 ? (
            <p className="py-3 text-xs text-muted">
              Aucun exécutant n&apos;a encore été affecté : la mission attend son tour.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {mission.agents.map((agent) => {
                const state = agentStateMeta[agent.state];
                return (
                  <li key={agent.id} className="flex items-start gap-3 py-2.5">
                    <StatusMark
                      shape={state.shape}
                      tone={state.tone}
                      live={agent.state === "actif"}
                      className="mt-0.5 shrink-0"
                    />
                    <span className="min-w-0 flex-1 text-[0.8125rem] text-ivory">
                      {agent.role}
                      <span className="ml-2 font-mono text-[0.625rem] text-muted">
                        {state.label.toLowerCase()}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[0.625rem] whitespace-nowrap text-muted">
                      {agent.stepIds.length} étape
                      {agent.stepIds.length > 1 ? "s" : ""}
                      <span className="mx-1.5 text-line-strong">·</span>
                      {agent.attempts} tent.
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>

      <div className="space-y-6">
        <div className="space-y-5 rounded-md border border-line bg-surface/60 p-4">
          <p className="label-mono">Garde-fous</p>
          <Progress
            done={mission.progress.done}
            total={mission.progress.total}
            unit={mission.progress.unit}
          />
          <Meter
            label="Durée"
            kind="duree"
            value={mission.duration.elapsedMin}
            cap={mission.duration.capMin}
          />
          <Meter
            label="Tentative"
            kind="tentatives"
            value={mission.attempts.current}
            cap={mission.attempts.max}
          />
          <Readout
            label="Agents actifs"
            value={`${activeAgents} / ${mission.agents.length}`}
            hint={`${mission.parallelAgents} en parallèle au maximum`}
          />
          <Readout
            label="Dernière activité"
            value={formatRelative(mission.lastActivityAt)}
            tone={stalled ? "danger" : undefined}
            hint={
              stalled
                ? `sans signe de vie depuis ${formatDuration(idleMin)}`
                : undefined
            }
          />
        </div>

        <div className="rounded-md border border-line p-4">
          <p className="label-mono">Livrables</p>
          <p className="mt-1 font-mono text-2xl text-ivory tabular-nums">
            {String(deliverables).padStart(2, "0")}
          </p>
          <p className="mt-1 text-xs text-muted">
            Consultables dans l&apos;onglet Livrables.
          </p>
        </div>

        <div className="rounded-md border border-line p-4">
          <p className="label-mono">Sources</p>
          <ul className="mt-2.5 space-y-2">
            <li>
              <SourceTag source={mission.source} />
            </li>
            {[
              ...new Map(
                mission.activity.map((event) => [
                  event.source.reference,
                  event.source,
                ]),
              ).values(),
            ]
              .slice(0, 4)
              .map((source) => (
                <li key={source.reference}>
                  <SourceTag source={source} />
                </li>
              ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function Activity({
  mission,
  onInstruction,
  closed,
}: {
  mission: Mission;
  onInstruction: (id: string, text: string) => void;
  closed: boolean;
}) {
  const { viewer } = useCockpit();
  const [text, setText] = useState("");
  const canInstruct = can(viewer, "missions.control") && !closed;

  function submit() {
    const value = text.trim();
    if (!value) return;
    onInstruction(mission.id, value);
    setText("");
  }

  return (
    <div className="space-y-7">
      {canInstruct ? (
        <div className="rounded-md border border-line bg-surface/60 p-4">
          <label
            htmlFor="instruction"
            className="text-[0.8125rem] font-medium text-ivory"
          >
            Donner une instruction
          </label>
          <p className="mt-1 text-xs text-muted">
            Elle rejoint la mission en cours. Ce n&apos;est pas une conversation :
            l&apos;instruction est datée et rattachée à l&apos;exécution.
          </p>
          <TextArea
            id="instruction"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="Ne touche pas aux tables d'audit, arrête-toi avant l'import final."
            className="mt-3 min-h-20"
          />
          <div className="mt-2.5 flex items-center justify-between gap-3">
            <p className="font-mono text-[0.625rem] text-muted">
              Ctrl + Entrée pour transmettre
            </p>
            <Button
              variant="primary"
              size="sm"
              onClick={submit}
              disabled={text.trim().length === 0}
            >
              <CornerDownLeft aria-hidden size={13} strokeWidth={1.75} />
              Transmettre
            </Button>
          </div>
        </div>
      ) : null}

      <Section title="Activité récente" count={mission.activity.length}>
        <ol className="divide-y divide-line">
          {mission.activity.map((event) => (
            <li key={event.id} className="flex gap-3 py-3">
              <span className="w-14 shrink-0 pt-0.5 font-mono text-[0.625rem] text-muted tabular-nums">
                {formatStamp(event.at)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[0.8125rem] leading-relaxed text-ivory">
                  {event.message}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-mono text-[0.625rem] tracking-[0.06em] text-muted uppercase">
                    {event.actor}
                  </span>
                  <SourceTag source={event.source} />
                </p>
              </div>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}

function Diagnostics({ mission }: { mission: Mission }) {
  const LEVEL_TONE = {
    info: "text-muted",
    warn: "text-attention",
    error: "text-danger",
  } as const;

  return (
    <div className="space-y-6">
      <p className="max-w-2xl text-sm leading-relaxed text-muted">
        Le détail technique vit ici, et nulle part ailleurs : identifiants d&apos;exécution,
        profils, garde-fous déclenchés, mesures brutes. Le reste du cockpit en est
        volontairement débarrassé. Une mission en cours est signalée comme inactive
        au-delà de {STALE_AFTER_MIN} minutes sans le moindre évènement.
      </p>

      <Section title="Journal d'exécution" count={mission.diagnostics.length}>
        <ul className="divide-y divide-line">
          {mission.diagnostics.map((line, index) => (
            <li key={`${line.at}-${index}`} className="flex gap-3 py-2.5">
              <span className="w-24 shrink-0 font-mono text-[0.625rem] text-muted tabular-nums">
                {formatStamp(line.at)}
              </span>
              <span
                className={cn(
                  "w-14 shrink-0 font-mono text-[0.625rem] uppercase",
                  LEVEL_TONE[line.level],
                )}
              >
                {line.level}
              </span>
              <span className="min-w-0 flex-1 font-mono text-[0.6875rem] leading-relaxed break-words text-ivory/85">
                <span className="text-muted">{line.scope}</span> {line.message}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Exécutants" count={mission.agents.length}>
        <ul className="divide-y divide-line">
          {mission.agents.map((agent) => (
            <li key={agent.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5">
              <span className="text-[0.8125rem] text-ivory">{agent.role}</span>
              <span className="font-mono text-[0.6875rem] text-muted">{agent.model}</span>
              <span className="ml-auto font-mono text-[0.6875rem] text-muted tabular-nums">
                state={agent.state} attempts={agent.attempts}
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
