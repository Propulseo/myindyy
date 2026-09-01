"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";

interface OverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Phrase lue par les lecteurs d'écran et affichée sous le titre. */
  description: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Ruban de contexte affiché au-dessus du titre. */
  eyebrow?: ReactNode;
  className?: string;
  /** Permet de désigner l'élément qui reçoit le focus à l'ouverture. */
  onOpenAutoFocus?: (event: Event) => void;
}

const BACKDROP =
  "fixed inset-0 z-40 bg-obsidian/80 backdrop-blur-[2px] " +
  "data-[state=open]:animate-fade-in";

/**
 * Panneau latéral sur grand écran, feuille glissée depuis le bas sur mobile.
 * Radix apporte le piège de focus, la touche Échap et la restitution du focus.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  eyebrow,
  children,
  footer,
  className,
  onOpenAutoFocus,
}: OverlayProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={BACKDROP} />
        <Dialog.Content
          onOpenAutoFocus={onOpenAutoFocus}
          className={cn(
            "fixed z-50 flex flex-col border-line bg-surface",
            "inset-x-0 bottom-0 max-h-[88dvh] rounded-t-lg border-t",
            "sm:inset-y-0 sm:right-0 sm:left-auto sm:max-h-none sm:w-[min(30rem,100vw)]",
            "sm:rounded-none sm:rounded-l-lg sm:border-t-0 sm:border-l",
            "data-[state=open]:animate-slide-up sm:data-[state=open]:animate-slide-left",
            className,
          )}
        >
          <OverlayHeader
            title={title}
            description={description}
            eyebrow={eyebrow}
          />
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
            {children}
          </div>
          {footer ? (
            <div className="border-t border-line bg-obsidian/40 px-5 py-4 sm:px-6">
              {footer}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Boîte centrée, pour les décisions qui doivent interrompre la lecture. */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  eyebrow,
  children,
  footer,
  className,
}: OverlayProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={BACKDROP} />
        <Dialog.Content
          className={cn(
            "fixed z-50 flex flex-col border-line bg-surface",
            "inset-x-0 bottom-0 max-h-[92dvh] rounded-t-lg border-t",
            "sm:inset-0 sm:m-auto sm:h-fit sm:max-h-[88dvh] sm:w-[min(38rem,calc(100vw-3rem))]",
            "sm:rounded-lg sm:border",
            "data-[state=open]:animate-slide-up sm:data-[state=open]:animate-rise",
            className,
          )}
        >
          <OverlayHeader title={title} description={description} eyebrow={eyebrow} />
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
            {children}
          </div>
          {footer ? (
            <div className="border-t border-line bg-obsidian/40 px-5 py-4 sm:px-6">
              {footer}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function OverlayHeader({
  title,
  description,
  eyebrow,
}: Pick<OverlayProps, "title" | "description" | "eyebrow">) {
  return (
    <div className="flex items-start gap-4 border-b border-line px-5 py-4 sm:px-6">
      <div className="min-w-0 flex-1">
        {eyebrow ? <div className="mb-1.5">{eyebrow}</div> : null}
        <Dialog.Title className="font-display text-xl leading-tight text-ivory">
          {title}
        </Dialog.Title>
        <Dialog.Description className="mt-1 text-sm text-muted">
          {description}
        </Dialog.Description>
      </div>
      <Dialog.Close
        className="-mr-1 -mt-1 rounded-sm p-1.5 text-muted transition-colors hover:bg-raised hover:text-ivory"
        aria-label="Fermer"
      >
        <X aria-hidden size={16} strokeWidth={1.75} />
      </Dialog.Close>
    </div>
  );
}
