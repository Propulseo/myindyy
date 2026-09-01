"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/primitives/Button";
import { LoadingSection, StateBlock } from "@/components/primitives/Layout";
import { useCockpit } from "@/lib/cockpit";

/**
 * Les trois états d'une section : chargement, erreur, vide.
 * Ils sont dessinés une seule fois et réutilisés partout, et se déclenchent depuis
 * Réglages › Démonstration pour pouvoir être présentés.
 */
export function ScreenState({
  isEmpty,
  loadingLabel,
  emptyTitle,
  emptyMessage,
  emptyAction,
  children,
}: {
  isEmpty: boolean;
  loadingLabel: string;
  emptyTitle: string;
  emptyMessage: string;
  emptyAction?: { label: string; href: string } | ReactNode;
  children: ReactNode;
}) {
  const { isLoading, hasError, setDisplay } = useCockpit();

  if (hasError) {
    return (
      <StateBlock
        kind="erreur"
        title="Les sources n'ont pas répondu"
        message="Indy n'a pas pu joindre Hermes ni l'ERP. Les données affichées seraient incomplètes, elles ne sont donc pas affichées."
        action={
          <Button variant="quiet" size="sm" onClick={() => setDisplay("normal")}>
            Réessayer
          </Button>
        }
      />
    );
  }

  if (isLoading) {
    return <LoadingSection label={loadingLabel} />;
  }

  if (isEmpty) {
    return (
      <StateBlock
        kind="vide"
        title={emptyTitle}
        message={emptyMessage}
        action={emptyAction}
      />
    );
  }

  return <>{children}</>;
}
