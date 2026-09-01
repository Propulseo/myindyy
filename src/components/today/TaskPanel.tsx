"use client";

import { useMemo, useRef, useState } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/primitives/Button";
import {
  Field,
  SelectInput,
  TextArea,
  TextInput,
} from "@/components/primitives/Form";
import { StateBlock } from "@/components/primitives/Layout";
import { Sheet } from "@/components/primitives/Overlay";
import { SourceTag } from "@/components/status/Meter";
import { DEMO_NOW_ISO, inHours, peopleById } from "@/fixtures";
import {
  authorizeTaskCommand,
  can,
  capabilityDenial,
  projectMemberIds,
  taskDenial,
  taskDenialMessage,
} from "@/lib/access";
import { useCockpit } from "@/lib/cockpit";
import { isoFromLocalInput, localInputFromIso } from "@/lib/format";
import { visibleProjects } from "@/lib/selectors";
import { taskCommandMeta } from "@/lib/status";
import type { ObsidianTask, PersonId } from "@/types/domain";

/** Valeur d'origine d'une tâche personnelle dans le champ « Projet ». */
const PERSONAL = "";

/**
 * Capturer une tâche, ou trier une tâche existante.
 *
 * Le panneau dit ce qu'il fait : il compose une commande `todo.capture` ou
 * `todo.triage` et la transmet à Hermes. Obsidian reste la source de vérité,
 * Indy ne touche jamais au coffre directement.
 */
export function TaskPanel({
  open,
  onOpenChange,
  task,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Absent : on capture une nouvelle tâche. Présent : on trie celle-ci. */
  task?: ObsidianTask;
}) {
  const { viewer, data, captureTask, triageTask } = useCockpit();
  const titleRef = useRef<HTMLInputElement>(null);

  const projects = useMemo(() => visibleProjects(data, viewer), [data, viewer]);
  const seesPersonal = can(viewer, "tasks.personal.view");
  const command = task ? "todo.triage" : "todo.capture";

  // Ouvrir le panneau demande déjà d'avoir la main sur ce qu'on vient trier, ou
  // un endroit où déposer ce qu'on vient capturer.
  const allowed = task
    ? authorizeTaskCommand(viewer, "todo.triage", { task }).allowed
    : can(viewer, "tasks.manage") && (projects.length > 0 || seesPersonal);
  const denial = task
    ? taskDenial(viewer, task)
    : can(viewer, "tasks.manage")
      ? "Aucun projet ne vous est affecté : il n'y a nulle part où déposer la tâche."
      : capabilityDenial["tasks.manage"];

  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState<string>(PERSONAL);
  const [ownerId, setOwnerId] = useState<PersonId>(viewer.id);
  const [due, setDue] = useState("");
  const [note, setNote] = useState("");

  // Le formulaire se recale à chaque ouverture, et à chaque tâche différente.
  // Ajustement pendant le rendu plutôt que dans un effet : pas de rendu en cascade.
  const signature = `${open}:${task?.id ?? "nouvelle"}`;
  const [lastSignature, setLastSignature] = useState(signature);
  if (signature !== lastSignature) {
    setLastSignature(signature);
    if (open) {
      setTitle(task?.title ?? "");
      setProjectId(task?.projectId ?? (projects[0]?.id ?? PERSONAL));
      setOwnerId(task?.ownerId ?? viewer.id);
      setDue(localInputFromIso(task?.dueAt ?? inHours(2)));
      setNote(task?.note ?? "");
    }
  }

  const dueAt = isoFromLocalInput(due);

  /** Qui peut porter la tâche : les membres du projet, ou le propriétaire seul. */
  const owners = useMemo(() => {
    if (!projectId) return [viewer];
    const list = projectMemberIds(projectId).map((id) => peopleById[id]);
    return list.length > 0 ? list : [viewer];
  }, [projectId, viewer]);

  const ownerValue = owners.some((person) => person.id === ownerId)
    ? ownerId
    : (owners[0]?.id ?? viewer.id);

  // Le même jugement que le réducteur, sur la destination réellement choisie :
  // le bouton ne propose jamais une commande qui serait refusée derrière.
  const verdict = authorizeTaskCommand(viewer, command, {
    task,
    target: { projectId: projectId || undefined, ownerId: ownerValue },
  });
  const ready = title.trim().length > 2 && dueAt !== undefined && verdict.allowed;

  function submit() {
    if (!ready || !dueAt) return;
    const draft = {
      title: title.trim(),
      projectId: projectId || undefined,
      ownerId: ownerValue,
      dueAt,
      note: note.trim() || undefined,
    };
    if (task) triageTask(task, draft);
    else captureTask(draft);
    onOpenChange(false);
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={task ? "Trier la tâche" : "Capturer une tâche"}
      description={
        task
          ? "Corrigez le projet, le responsable, l'échéance ou la note. Indy transmet la correction à Hermes."
          : "Une phrase, un endroit où la ranger. Indy transmet la capture à Hermes, qui écrit dans Obsidian."
      }
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        titleRef.current?.focus();
      }}
      footer={
        allowed ? (
          <div className="flex items-center justify-between gap-3">
            <p className="font-mono text-[0.625rem] text-muted">{command}</p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Ne rien faire
              </Button>
              <Button variant="primary" onClick={submit} disabled={!ready}>
                {task ? "Enregistrer" : "Capturer"}
              </Button>
            </div>
          </div>
        ) : null
      }
    >
      {!allowed ? (
        <StateBlock
          kind="restreint"
          title="Action indisponible"
          message={denial ?? capabilityDenial["tasks.manage"]}
        />
      ) : (
        <div className="space-y-6">
          <Field
            label="Titre"
            hint="Ce que la tâche demande, en une phrase."
          >
            {(props) => (
              <TextInput
                {...props}
                ref={titleRef}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Rappeler les quatre demandes prioritaires"
              />
            )}
          </Field>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Projet"
              hint={
                seesPersonal
                  ? "« Personnel » range la tâche hors projet : vous seul la voyez."
                  : "Seuls vos projets affectés apparaissent ici."
              }
            >
              {(props) => (
                <SelectInput
                  {...props}
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                >
                  {seesPersonal ? (
                    <option value={PERSONAL}>Personnel</option>
                  ) : null}
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </SelectInput>
              )}
            </Field>

            <Field label="Responsable" hint="Qui porte la tâche.">
              {(props) => (
                <SelectInput
                  {...props}
                  value={ownerValue}
                  onChange={(event) => setOwnerId(event.target.value as PersonId)}
                >
                  {owners.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
                </SelectInput>
              )}
            </Field>

            <Field label="Échéance" hint="Date et heure attendues.">
              {(props) => (
                <TextInput
                  {...props}
                  type="datetime-local"
                  value={due}
                  onChange={(event) => setDue(event.target.value)}
                  className="font-mono"
                />
              )}
            </Field>
          </div>

          {verdict.allowed ? null : (
            <p className="flex items-start gap-2.5 rounded-sm border border-attention/30 bg-attention/12 px-3.5 py-3 text-xs leading-relaxed text-ivory">
              <Lock aria-hidden size={12} strokeWidth={1.75} className="mt-0.5 shrink-0" />
              {taskDenialMessage[verdict.reason ?? "project"]}
            </p>
          )}

          <Field label="Note" optional hint="Le contexte qui manquerait au titre.">
            {(props) => (
              <TextArea
                {...props}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Bloque la migration M-244."
                className="min-h-20"
              />
            )}
          </Field>

          <div className="rounded-md border border-line bg-obsidian/60 p-4">
            <p className="label-mono">Ce qui part</p>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              Commande{" "}
              <span className="font-mono text-ivory">
                {taskCommandMeta[command].label}
              </span>{" "}
              transmise à Hermes. {taskCommandMeta[command].hint} Obsidian reste la
              source de vérité : Indy n&apos;écrit pas dans le coffre.
            </p>
            <SourceTag
              source={{
                system: "hermes",
                reference: `Hermes · ${command} → Obsidian`,
                syncedAt: task?.source.syncedAt ?? DEMO_NOW_ISO,
              }}
              className="mt-2.5"
            />
            <p className="mt-2.5 text-xs leading-relaxed text-muted">
              Dans ce prototype, la commande n&apos;est pas envoyée : elle est simulée
              pour la durée de la session.
            </p>
          </div>
        </div>
      )}
    </Sheet>
  );
}
