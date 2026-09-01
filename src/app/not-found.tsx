import { StateBlock } from "@/components/primitives/Layout";

export const metadata = {
  title: "Page introuvable",
};

export default function NotFound() {
  return (
    <div className="pt-10">
      <StateBlock
        kind="vide"
        title="Cette page n'existe pas."
        message="Le cockpit tient en sept écrans. Celui-ci n'en fait pas partie."
        action={{ label: "Retour à Aujourd'hui", href: "/" }}
      />
    </div>
  );
}
