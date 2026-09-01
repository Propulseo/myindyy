"use client";

import { Button } from "@/components/primitives/Button";
import { StateBlock } from "@/components/primitives/Layout";

export default function ErrorBoundary({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="pt-10">
      <StateBlock
        kind="erreur"
        title="Cet écran n'a pas pu s'afficher."
        message="Une erreur s'est produite pendant le rendu. Rien n'a été envoyé à l'extérieur, aucune mission n'a été modifiée."
        action={
          <Button variant="quiet" size="sm" onClick={reset}>
            Réessayer
          </Button>
        }
      />
    </div>
  );
}
