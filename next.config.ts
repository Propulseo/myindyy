import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Le prototype ne dépend d'aucun service : rien à configurer côté serveur.
  // On désactive seulement les artefacts qui polluent les captures et le dépôt.
  devIndicators: false,
  agentRules: false,
};

export default nextConfig;
