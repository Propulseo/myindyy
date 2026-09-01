"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { Check, Lock } from "lucide-react";
import { Button } from "@/components/primitives/Button";
import { cn } from "@/components/primitives/cn";
import {
  Field,
  Segmented,
  SelectInput,
  TextArea,
} from "@/components/primitives/Form";
import { Sheet } from "@/components/primitives/Overlay";
import { StateBlock } from "@/components/primitives/Layout";
import { missionTemplates } from "@/fixtures";
import { can } from "@/lib/access";
import { useCockpit } from "@/lib/cockpit";
import { formatDuration, plural } from "@/lib/format";
import { visibleProjects } from "@/lib/selectors";
import { autonomyMeta, effortMeta } from "@/lib/status";
import type { AutonomyLevel, EffortLevel } from "@/types/domain";

const DURATION_CHOICES = [30, 60, 90, 180, 240, 300, 480];
const ATTEMPT_CHOICES = [1, 2, 3, 5];

export function NewMissionPanel({
  open,
  onOpenChange,
  initialProjectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialProjectId?: string;
}) {
  const router = useRouter();
  const { viewer, data, createMission } = useCockpit();
  const objectiveRef = useRef<HTMLTextAreaElement>(null);

  const projects = useMemo(() => visibleProjects(data, viewer), [data, viewer]);
  const allowed = can(viewer, "missions.create");

  const [objective, setObjective] = useState("");
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id ?? "");
  const [templateId, setTemplateId] = useState("");
  const [duration, setDuration] = useState(180);
  const [attempts, setAttempts] = useState(2);
  const [effort, setEffort] = useState<EffortLevel>("standard");
  const [autonomy, setAutonomy] = useState<AutonomyLevel>("encadree");

  // Réinitialise le formulaire à chaque ouverture, en tenant compte du projet d'origine.
  // Ajustement pendant le rendu plutôt que dans un effet : pas de rendu en cascade.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setObjective("");
      setTemplateId("");
      setDuration(180);
      setAttempts(2);
      setEffort("standard");
      setAutonomy("encadree");
      setProjectId(initialProjectId ?? projects[0]?.id ?? "");
    }
  }

  function applyTemplate(id: string) {
    setTemplateId(id);
    const template = missionTemplates.find((item) => item.id === id);
    if (!template) return;
    setObjective(template.objective);
    setDuration(template.defaultDurationMin);
    setAttempts(template.defaultAttempts);
    setEffort(template.defaultEffort);
    setAutonomy(template.defaultAutonomy);
  }

  function launch() {
    if (!objective.trim() || !projectId) return;
    const id = createMission({
      objective: objective.trim(),
      projectId,
      templateId: templateId || null,
      durationMin: duration,
      maxAttempts: attempts,
      effort,
      autonomy,
    });
    onOpenChange(false);
    router.push(`/missions/${id}`);
  }

  const ready = objective.trim().length > 3 && projectId !== "";

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Nouvelle mission"
      description="Décrivez l'objectif. Indy prépare l'exécution et s'arrête aux limites que vous posez."
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        objectiveRef.current?.focus();
      }}
      footer={
        allowed ? (
          <div className="flex items-center justify-between gap-3">
            <p className="font-mono text-[0.625rem] text-muted">
              Démarre en file d&apos;attente
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Annuler
              </Button>
              <Button variant="primary" onClick={launch} disabled={!ready}>
                Lancer la mission
              </Button>
            </div>
          </div>
        ) : null
      }
    >
      {!allowed ? (
        <StateBlock
          kind="restreint"
          title="Lancement non autorisé"
          message="Votre rôle ne permet pas de créer une mission. Demandez au propriétaire du projet de la lancer."
        />
      ) : (
        <div className="space-y-6">
          <Field
            label="Objectif"
            hint="Une phrase suffit. C'est ce que la mission doit avoir produit à la fin."
          >
            {(props) => (
              <TextArea
                {...props}
                ref={objectiveRef}
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
                placeholder="Auditer les pages publiques et proposer un plan de correction"
              />
            )}
          </Field>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Projet">
              {(props) => (
                <SelectInput
                  {...props}
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </SelectInput>
              )}
            </Field>

            <Field
              label="Modèle"
              optional
              hint="Pré-remplit les garde-fous et l'autonomie."
            >
              {(props) => (
                <SelectInput
                  {...props}
                  value={templateId}
                  onChange={(event) => applyTemplate(event.target.value)}
                >
                  <option value="">Aucun modèle</option>
                  {missionTemplates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </SelectInput>
              )}
            </Field>

            <Field
              label="Durée maximale"
              hint="À la limite, la mission rend la main avec ce qu'elle a produit."
            >
              {(props) => (
                <SelectInput
                  {...props}
                  value={String(duration)}
                  onChange={(event) => setDuration(Number(event.target.value))}
                >
                  {DURATION_CHOICES.map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {formatDuration(minutes)}
                    </option>
                  ))}
                </SelectInput>
              )}
            </Field>

            <Field
              label="Tentatives autorisées"
              hint="Nombre de reprises après une étape en échec."
            >
              {(props) => (
                <SelectInput
                  {...props}
                  value={String(attempts)}
                  onChange={(event) => setAttempts(Number(event.target.value))}
                >
                  {ATTEMPT_CHOICES.map((count) => (
                    <option key={count} value={count}>
                      {plural(count, "tentative")}
                    </option>
                  ))}
                </SelectInput>
              )}
            </Field>
          </div>

          <div className="space-y-2">
            <p className="text-[0.8125rem] font-medium text-ivory">
              Niveau d&apos;effort
            </p>
            <Segmented
              ariaLabel="Niveau d'effort"
              value={effort}
              onValueChange={setEffort}
              options={(["leger", "standard", "approfondi"] as const).map((level) => ({
                value: level,
                label: effortMeta[level].label,
                hint: effortMeta[level].hint,
              }))}
            />
          </div>

          <div className="space-y-2">
            <p className="text-[0.8125rem] font-medium text-ivory">
              Niveau d&apos;autonomie
            </p>
            <Segmented
              ariaLabel="Niveau d'autonomie"
              value={autonomy}
              onValueChange={setAutonomy}
              options={(["supervisee", "encadree", "autonome"] as const).map((level) => ({
                value: level,
                label: autonomyMeta[level].label,
                hint: autonomyMeta[level].hint,
              }))}
            />
          </div>

          <PermissionSummary duration={duration} attempts={attempts} />
        </div>
      )}
    </Sheet>
  );
}

/** Résumé des garde-fous et des permissions, affiché avant le lancement. */
function PermissionSummary({
  duration,
  attempts,
}: {
  duration: number;
  attempts: number;
}) {
  const { viewer } = useCockpit();

  const rows: { label: string; value: string; allowed: boolean }[] = [
    {
      label: "Arrêt automatique",
      value: `${formatDuration(duration)} ou ${plural(attempts, "tentative")}, au premier atteint`,
      allowed: true,
    },
    {
      label: "Exécutants en parallèle",
      value: "1 au lancement, visible ensuite dans les garde-fous de la mission",
      allowed: true,
    },
    {
      label: "Déploiement en production",
      value: can(viewer, "deploy.production")
        ? "Demandera votre confirmation"
        : "Indisponible pour votre rôle",
      allowed: can(viewer, "deploy.production"),
    },
    {
      label: "Communication externe",
      value: can(viewer, "comms.external.send")
        ? "Demandera votre approbation avant envoi"
        : "Indisponible pour votre rôle",
      allowed: can(viewer, "comms.external.send"),
    },
    {
      label: "Prolongation",
      value: can(viewer, "limits.override")
        ? "Vous pourrez repousser la limite au cas par cas"
        : "Devra être autorisée par le propriétaire",
      allowed: can(viewer, "limits.override"),
    },
  ];

  return (
    <div className="rounded-md border border-line bg-obsidian/60 p-4">
      <p className="label-mono">Avant de lancer</p>
      <ul className="mt-3 space-y-2.5">
        {rows.map((row) => (
          <li key={row.label} className="flex items-start gap-2.5">
            {row.allowed ? (
              <Check
                aria-hidden
                size={13}
                strokeWidth={2}
                className="mt-1 shrink-0 text-ok"
              />
            ) : (
              <Lock
                aria-hidden
                size={12}
                strokeWidth={1.75}
                className="mt-1 shrink-0 text-muted"
              />
            )}
            <span className="min-w-0 text-xs leading-relaxed">
              <span className="text-ivory">{row.label}</span>
              <span className={cn("ml-1.5", row.allowed ? "text-muted" : "text-muted/80")}>
                — {row.value}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
