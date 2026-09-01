"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/primitives/Button";
import { PageHeading, Section } from "@/components/primitives/Layout";
import { MissionRow } from "@/components/mission/MissionRow";
import { TaskRow } from "@/components/data/Rows";
import { AttentionRow } from "@/components/today/AttentionRow";
import { TaskActions } from "@/components/today/TaskActions";
import { TaskPanel } from "@/components/today/TaskPanel";
import { ScreenState } from "@/components/shell/ScreenState";
import { useShellActions } from "@/components/shell/AppShell";
import { can } from "@/lib/access";
import { useCockpit } from "@/lib/cockpit";
import { DEMO_DAY_LABEL, DEMO_TIME_LABEL, plural } from "@/lib/format";
import type { ObsidianTask } from "@/types/domain";
import {
  attentionItems,
  isStalled,
  recentlyFinished,
  visibleTasks,
  workingMissions,
} from "@/lib/selectors";

export default function TodayPage() {
  const { viewer, data, hasError } = useCockpit();
  const { openNewMission } = useShellActions();

  // Le panneau sert aussi bien à capturer qu'à trier : sans tâche, c'est une capture.
  const [taskPanel, setTaskPanel] = useState<{
    open: boolean;
    task?: ObsidianTask;
  }>({ open: false });

  const attention = useMemo(() => attentionItems(data, viewer), [data, viewer]);
  const working = useMemo(() => workingMissions(data, viewer), [data, viewer]);
  const tasks = useMemo(() => visibleTasks(data, viewer), [data, viewer]);
  const finished = useMemo(() => recentlyFinished(data, viewer), [data, viewer]);

  // « En cours » regroupe aussi ce qui attend son tour ou ne bouge plus. La phrase de
  // tête, elle, ne compte que ce qui travaille réellement — même définition que le Pouls,
  // sinon l'en-tête annonce une activité que la bande contredit.
  const reallyWorking = working.filter(
    (mission) => mission.status === "en_cours" && !isStalled(mission),
  ).length;

  const canCapture = can(viewer, "tasks.manage");

  return (
    <div className="space-y-9">
      <PageHeading
        title="Aujourd'hui"
        lede={
          hasError
            ? "Les sources n'ont pas répondu. Le cockpit préfère ne rien montrer plutôt qu'une vue partielle."
            : buildLede(attention.length, reallyWorking)
        }
        aside={
          <p className="hidden font-mono text-[0.6875rem] text-muted sm:block">
            {DEMO_DAY_LABEL}
            <span className="mx-1.5 text-line-strong">·</span>
            {DEMO_TIME_LABEL}
          </p>
        }
      />

      <Section id="a-traiter" title="À traiter" count={attention.length}>
        <ScreenState
          isEmpty={attention.length === 0}
          loadingLabel="Chargement de ce qui demande votre attention"
          emptyTitle="Rien ne demande votre attention."
          emptyMessage="Aucune décision en attente, aucun blocage, aucune limite atteinte. Vous pouvez regarder ce qui travaille, ou lancer autre chose."
          emptyAction={
            <Button variant="quiet" size="sm" onClick={() => openNewMission()}>
              Nouvelle mission
            </Button>
          }
        >
          <ul className="divide-y divide-line">
            {attention.map((item) => (
              <AttentionRow key={item.id} item={item} />
            ))}
          </ul>
        </ScreenState>
      </Section>

      <Section
        id="en-cours"
        title="En cours"
        count={working.length}
        action={
          <Link
            href="/missions"
            className="font-mono text-[0.6875rem] text-muted transition-colors hover:text-ivory"
          >
            Toutes les missions
          </Link>
        }
      >
        <ScreenState
          isEmpty={working.length === 0}
          loadingLabel="Chargement des missions en cours"
          emptyTitle="Rien ne tourne."
          emptyMessage="Aucune mission n'est en cours ni en file d'attente sur vos projets."
        >
          <ul className="divide-y divide-line">
            {working.map((mission) => (
              <MissionRow key={mission.id} mission={mission} />
            ))}
          </ul>
        </ScreenState>
      </Section>

      <div className="grid gap-9 lg:grid-cols-2">
        <Section
          id="taches"
          title="Tâches Obsidian du jour"
          count={tasks.length}
          action={
            canCapture ? (
              <Button
                variant="quiet"
                size="sm"
                onClick={() => setTaskPanel({ open: true })}
              >
                <Plus aria-hidden size={13} strokeWidth={2} />
                Capturer une tâche
              </Button>
            ) : null
          }
        >
          <ScreenState
            isEmpty={tasks.length === 0}
            loadingLabel="Chargement des tâches du jour"
            emptyTitle="Aucune tâche pour aujourd'hui."
            emptyMessage="Rien n'est daté d'aujourd'hui dans les notes des projets que vous suivez."
            emptyAction={
              canCapture ? (
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => setTaskPanel({ open: true })}
                >
                  Capturer une tâche
                </Button>
              ) : undefined
            }
          >
            <ul className="divide-y divide-line">
              {tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  actions={
                    <TaskActions
                      task={task}
                      onTriage={(item) => setTaskPanel({ open: true, task: item })}
                    />
                  }
                />
              ))}
            </ul>
          </ScreenState>
          <p className="mt-3 text-xs leading-relaxed text-muted">
            Obsidian reste la source de vérité. Indy n&apos;écrit pas dans le coffre :
            il transmet une commande à Hermes, qui l&apos;applique.
          </p>
        </Section>

        <Section id="termine" title="Terminé récemment" count={finished.length}>
          <ScreenState
            isEmpty={finished.length === 0}
            loadingLabel="Chargement de ce qui vient de se terminer"
            emptyTitle="Rien ne s'est terminé récemment."
            emptyMessage="Les missions closes depuis plus de trente heures se trouvent dans l'historique."
            emptyAction={{ label: "Ouvrir l'historique", href: "/historique" }}
          >
            <ul className="divide-y divide-line">
              {finished.map((mission) => (
                <MissionRow key={mission.id} mission={mission} />
              ))}
            </ul>
          </ScreenState>
        </Section>
      </div>

      <TaskPanel
        open={taskPanel.open}
        task={taskPanel.task}
        onOpenChange={(open) =>
          setTaskPanel((state) => (open ? { ...state, open } : { open: false }))
        }
      />
    </div>
  );
}

/** Une phrase qui répond aux deux premières questions avant même de lire les listes. */
function buildLede(attentionCount: number, workingCount: number): string {
  const left =
    attentionCount === 0
      ? "Rien ne demande votre attention"
      : `${plural(attentionCount, "point demande", "points demandent")} votre attention`;
  const right =
    workingCount === 0
      ? "rien ne travaille en ce moment."
      : `${plural(workingCount, "mission travaille", "missions travaillent")} en ce moment.`;
  return `${left}, ${right}`;
}
