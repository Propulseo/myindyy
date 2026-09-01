"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Lock, ShieldAlert } from "lucide-react";
import { Button } from "@/components/primitives/Button";
import { cn } from "@/components/primitives/cn";
import { Field, TextInput } from "@/components/primitives/Form";
import { Modal } from "@/components/primitives/Overlay";
import { KeyValue } from "@/components/primitives/Layout";
import { useCockpit } from "@/lib/cockpit";
import { can, capabilityDenial } from "@/lib/access";
import { projectsById } from "@/fixtures";
import { decisionKindMeta, toneClasses } from "@/lib/status";
import type { Capability, DecisionKind } from "@/types/domain";

/**
 * Description complète d'une action sensible. Tout ce qui est ici s'affiche à l'écran
 * avant confirmation : on ne demande jamais « Êtes-vous sûr ? ».
 */
export interface SensitiveActionRequest {
  kind: DecisionKind;
  /** L'action, à l'infinitif. */
  action: string;
  /** La cible exacte : un domaine, une liste de destinataires, un dépôt. */
  target: string;
  projectId: string;
  environment: string;
  /** La révision de code, ou l'extrait du contenu qui partira. */
  revision: string;
  /** Ce qui se produit une fois confirmé, et si c'est réversible. */
  consequence: string;
  requiredCapability: Capability;
  confirmLabel?: string;
  /** Mot à saisir pour confirmer. Réservé aux actions irréversibles. */
  typeToConfirm?: string;
  onConfirm: () => void;
}

interface SensitiveActionValue {
  request: (input: SensitiveActionRequest) => void;
}

const SensitiveActionContext = createContext<SensitiveActionValue | null>(null);

export function useSensitiveAction(): SensitiveActionValue {
  const value = useContext(SensitiveActionContext);
  if (!value) throw new Error("useSensitiveAction hors de SensitiveActionProvider.");
  return value;
}

/**
 * Un seul panneau de confirmation pour tout le cockpit : déploiement, publication,
 * communication externe, annulation de mission, prolongation au-delà des garde-fous.
 */
export function SensitiveActionProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<SensitiveActionRequest | null>(null);

  const request = useCallback((input: SensitiveActionRequest) => {
    setPending(input);
  }, []);

  const value = useMemo(() => ({ request }), [request]);

  return (
    <SensitiveActionContext.Provider value={value}>
      {children}
      <SensitiveActionPanel
        request={pending}
        onClose={() => setPending(null)}
      />
    </SensitiveActionContext.Provider>
  );
}

function SensitiveActionPanel({
  request,
  onClose,
}: {
  request: SensitiveActionRequest | null;
  onClose: () => void;
}) {
  const { viewer } = useCockpit();
  const [typed, setTyped] = useState("");

  const open = request !== null;
  const meta = request ? decisionKindMeta[request.kind] : null;
  const allowed = request ? can(viewer, request.requiredCapability) : false;
  const project = request ? projectsById[request.projectId] : undefined;
  const needsTyping = Boolean(request?.typeToConfirm);
  const typingSatisfied =
    !needsTyping || typed.trim() === request?.typeToConfirm?.trim();

  function handleOpenChange(next: boolean) {
    if (!next) {
      setTyped("");
      onClose();
    }
  }

  function confirm() {
    if (!request || !allowed || !typingSatisfied) return;
    request.onConfirm();
    setTyped("");
    onClose();
  }

  return (
    <Modal
      open={open}
      onOpenChange={handleOpenChange}
      title={request?.action ?? ""}
      description={
        allowed
          ? "Vérifiez chaque ligne avant de confirmer. Cette action sort d'Indy."
          : "Cette action existe, mais votre rôle ne permet pas de la confirmer."
      }
      eyebrow={
        meta ? (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-xs border px-1.5 py-0.5",
              "font-mono text-[0.625rem] tracking-[0.08em] uppercase",
              toneClasses[meta.tone].chip,
              toneClasses[meta.tone].border,
              toneClasses[meta.tone].text,
            )}
          >
            <ShieldAlert aria-hidden size={11} strokeWidth={2} />
            {meta.label}
          </span>
        ) : null
      }
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => handleOpenChange(false)}>
            {allowed ? "Ne rien faire" : "Fermer"}
          </Button>
          {allowed ? (
            <Button
              variant={meta?.tone === "danger" ? "danger" : "primary"}
              onClick={confirm}
              disabled={!typingSatisfied}
            >
              {request?.confirmLabel ?? meta?.confirmLabel ?? "Confirmer"}
            </Button>
          ) : null}
        </div>
      }
    >
      {request ? (
        <div className="space-y-5">
          {!allowed ? (
            <p className="flex items-start gap-2.5 rounded-sm border border-line bg-raised px-3.5 py-3 text-[0.8125rem] leading-relaxed text-muted">
              <Lock aria-hidden size={14} strokeWidth={1.75} className="mt-0.5 shrink-0" />
              {capabilityDenial[request.requiredCapability]}
            </p>
          ) : null}

          <dl className="grid gap-4 sm:grid-cols-2">
            <KeyValue label="Action">{request.action}</KeyValue>
            <KeyValue label="Cible">
              <span className="font-mono text-[0.8125rem]">{request.target}</span>
            </KeyValue>
            <KeyValue label="Projet">{project?.name ?? request.projectId}</KeyValue>
            <KeyValue label="Environnement">
              <span className="font-mono text-[0.8125rem]">{request.environment}</span>
            </KeyValue>
          </dl>

          <div>
            <p className="label-mono">Révision ou contenu</p>
            <p className="mt-1.5 rounded-sm border border-line bg-obsidian px-3.5 py-3 font-mono text-xs leading-relaxed break-words text-ivory">
              {request.revision}
            </p>
          </div>

          <div
            className={cn(
              "rounded-sm border px-3.5 py-3",
              toneClasses[meta?.tone ?? "attention"].border,
              toneClasses[meta?.tone ?? "attention"].chip,
            )}
          >
            <p className="label-mono">Conséquence</p>
            <p className="mt-1 text-[0.8125rem] leading-relaxed text-ivory">
              {request.consequence}
            </p>
          </div>

          <div className="flex items-center gap-2.5 border-t border-line pt-4">
            <span
              aria-hidden
              className="grid size-6 shrink-0 place-items-center rounded-xs bg-indy/15 font-mono text-[0.625rem] text-indy"
            >
              {viewer.initials}
            </span>
            <p className="text-xs text-muted">
              Confirmé par{" "}
              <span className="text-ivory">{viewer.name}</span>, {viewer.role.toLowerCase()}.
            </p>
          </div>

          {allowed && needsTyping ? (
            <Field
              label={`Saisissez « ${request.typeToConfirm} » pour confirmer`}
              hint="Cette action est irréversible sans intervention manuelle."
            >
              {(props) => (
                <TextInput
                  {...props}
                  value={typed}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setTyped(event.target.value)}
                  className="font-mono"
                />
              )}
            </Field>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
