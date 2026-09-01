"use client";

import { Check, Lock, Minus } from "lucide-react";
import { Segmented } from "@/components/primitives/Form";
import { PageHeading, Section, StateBlock } from "@/components/primitives/Layout";
import { cn } from "@/components/primitives/cn";
import { codexPlanUsage, people } from "@/fixtures";
import { can } from "@/lib/access";
import { useCockpit, type DisplayState } from "@/lib/cockpit";
import { sourceMeta } from "@/lib/status";
import type { Capability, SourceSystem } from "@/types/domain";

const CAPABILITY_ROWS: { capability: Capability; label: string }[] = [
  { capability: "missions.create", label: "Lancer une mission" },
  { capability: "missions.control", label: "Suspendre, reprendre, relancer" },
  { capability: "missions.cancel", label: "Annuler une mission" },
  { capability: "missions.approve", label: "Répondre à une décision" },
  { capability: "deploy.production", label: "Déployer en production" },
  { capability: "comms.external.send", label: "Publier ou envoyer à l'extérieur" },
  { capability: "limits.override", label: "Prolonger une mission au-delà de ses limites" },
  { capability: "secrets.view", label: "Voir les identifiants des sources" },
  {
    capability: "tasks.manage",
    label: "Capturer, trier, terminer ou annuler une tâche",
  },
  { capability: "tasks.personal.view", label: "Voir les tâches personnelles" },
  { capability: "projects.viewAll", label: "Voir tous les projets" },
];

const CONNECTED: { system: SourceSystem; account: string; state: string }[] = [
  { system: "obsidian", account: "coffre principal", state: "Synchronisé" },
  { system: "erp", account: "espace Propul'SEO", state: "Synchronisé" },
  { system: "crm", account: "espace Propul'SEO", state: "Synchronisé" },
  { system: "hermes", account: "serveur d'exécution", state: "Connecté" },
  { system: "github", account: "organisation Propulseo", state: "Connecté" },
  { system: "coolify", account: "serveur de déploiement", state: "Connecté" },
];

const DISPLAY_OPTIONS: { value: DisplayState; label: string; hint: string }[] = [
  { value: "normal", label: "Normal", hint: "Les données de démonstration" },
  { value: "chargement", label: "Chargement", hint: "Lignes fantômes" },
  { value: "vide", label: "Vide", hint: "Aucune donnée" },
  { value: "erreur", label: "Erreur", hint: "Sources injoignables" },
];

export default function SettingsPage() {
  const { viewer, display, setDisplay } = useCockpit();
  const seesSecrets = can(viewer, "secrets.view");

  return (
    <div className="space-y-9">
      <PageHeading
        title="Réglages"
        lede="Ce prototype ne se connecte à rien. Les réglages décrivent ce que le cockpit contrôlera, et servent à présenter les états de l'interface."
      />

      <Section id="demonstration" title="Démonstration">
        <div className="space-y-5 py-4">
          <div>
            <p className="text-[0.8125rem] font-medium text-ivory">
              État d&apos;affichage
            </p>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">
              Applique un état à « Aujourd&apos;hui », « Missions », « Livrables » et
              « Historique », pour montrer les écrans de chargement, de vide et
              d&apos;erreur sans avoir à provoquer une panne.
            </p>
            <div className="mt-3 max-w-2xl">
              <Segmented
                ariaLabel="État d'affichage de démonstration"
                columns={4}
                value={display}
                onValueChange={setDisplay}
                options={DISPLAY_OPTIONS}
              />
            </div>
          </div>

          <div className="rounded-md border border-line bg-surface/60 p-4">
            <p className="label-mono">Rôle affiché</p>
            <p className="mt-1.5 text-sm text-ivory">
              {viewer.name} — {viewer.role}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              {viewer.roleSummary} Le sélecteur se trouve en haut à droite, marqué
              « démonstration ».
            </p>
          </div>
        </div>
      </Section>

      <Section id="permissions" title="Ce que chaque rôle peut faire">
        <p className="max-w-2xl pt-3 text-xs leading-relaxed text-muted">
          Une permission cochée s&apos;applique dans le périmètre du rôle : un projet
          non affecté n&apos;apparaît nulle part, et les tâches partagées d&apos;un tel
          projet restent hors de portée. Les tâches personnelles n&apos;appartiennent
          qu&apos;à leur propriétaire.
        </p>
        <div className="overflow-x-auto py-2">
          <table className="w-full min-w-[34rem] border-collapse text-left">
            <caption className="sr-only">
              Permissions comparées des trois rôles de démonstration
            </caption>
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className="label-mono py-2.5 pr-4 font-normal">
                  Permission
                </th>
                {people.map((person) => (
                  <th
                    key={person.id}
                    scope="col"
                    className="px-3 py-2.5 text-center font-normal"
                  >
                    <span className="block text-[0.8125rem] text-ivory">
                      {person.name.split(" ")[0]}
                    </span>
                    <span className="label-mono">{person.role}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CAPABILITY_ROWS.map((row) => (
                <tr key={row.capability} className="border-b border-line/70">
                  <th
                    scope="row"
                    className="py-2.5 pr-4 text-[0.8125rem] font-normal text-ivory"
                  >
                    {row.label}
                  </th>
                  {people.map((person) => {
                    const allowed = can(person, row.capability);
                    return (
                      <td key={person.id} className="px-3 py-2.5 text-center">
                        {allowed ? (
                          <>
                            <Check
                              aria-hidden
                              size={14}
                              strokeWidth={2}
                              className="mx-auto text-ok"
                            />
                            <span className="sr-only">Autorisé</span>
                          </>
                        ) : (
                          <>
                            <Minus
                              aria-hidden
                              size={14}
                              strokeWidth={2}
                              className="mx-auto text-line-strong"
                            />
                            <span className="sr-only">Non autorisé</span>
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="sources" title="Sources connectées" count={CONNECTED.length}>
        <ul className="divide-y divide-line">
          {CONNECTED.map((entry) => (
            <li
              key={entry.system}
              className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3"
            >
              <span className="w-24 shrink-0 text-[0.8125rem] text-ivory">
                {sourceMeta[entry.system].label}
              </span>
              <span className="min-w-0 flex-1 text-xs text-muted">
                {sourceMeta[entry.system].role} · {entry.account}
              </span>
              <span className="font-mono text-[0.625rem] tracking-[0.06em] text-ok uppercase">
                {entry.state}
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-5">
          {seesSecrets ? (
            <div className="rounded-md border border-line bg-surface/60 p-4">
              <p className="label-mono">Identifiants</p>
              <ul className="mt-2.5 space-y-2">
                {CONNECTED.map((entry) => (
                  <li key={entry.system} className="flex items-center gap-3">
                    <span className="w-24 shrink-0 font-mono text-[0.6875rem] text-muted">
                      {entry.system}
                    </span>
                    <span
                      aria-label="Valeur masquée"
                      className="font-mono text-[0.6875rem] tracking-[0.2em] text-line-strong"
                    >
                      ••••••••••••••••
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs leading-relaxed text-muted">
                Prototype : aucune valeur réelle n&apos;est stockée ni affichée. Les
                identifiants resteront côté serveur, jamais dans le navigateur.
              </p>
            </div>
          ) : (
            <StateBlock
              kind="restreint"
              title="Identifiants masqués"
              message="Les identifiants des sources connectées ne sont visibles que du propriétaire. Vous voyez l'état de chaque connexion, pas ses secrets."
            />
          )}
        </div>
      </Section>

      <Section id="forfait" title="Utilisation du forfait Codex">
        <div className="space-y-4 py-4">
          <p className="max-w-2xl text-sm leading-relaxed text-muted">
            Codex tourne derrière Indy sur l&apos;abonnement ChatGPT de
            l&apos;utilisateur. Le cockpit ne compte donc aucun coût par mission : ce
            qu&apos;il encadre, ce sont la durée, les tentatives, les agents en
            parallèle et l&apos;effort.
          </p>

          {codexPlanUsage ? (
            <div className="rounded-md border border-line bg-surface/60 p-4">
              <p className="label-mono">Consommation globale</p>
              <p className="mt-1.5 font-mono text-2xl text-ivory tabular-nums">
                {codexPlanUsage.label}
              </p>
              <p className="mt-2 text-xs text-muted">
                Fourni par {sourceMeta[codexPlanUsage.source.system].label}, sans
                retraitement.
              </p>
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-line px-5 py-6">
              <p className="font-display text-lg text-ivory">
                Donnée non fournie par la source.
              </p>
              <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">
                Ni Hermes ni Codex n&apos;exposent aujourd&apos;hui la part de forfait
                consommée. Indy laisse donc cet emplacement vide plutôt que de
                l&apos;estimer : un chiffre inventé serait pire qu&apos;une absence de
                chiffre. Le jour où la source la publiera, elle s&apos;affichera ici
                telle quelle.
              </p>
            </div>
          )}
        </div>
      </Section>

      <Section id="identite" title="Identité visuelle">
        <div className="grid gap-6 py-4 lg:grid-cols-2">
          <div>
            <p className="label-mono">Typographies</p>
            <dl className="mt-3 space-y-3">
              <TypeRow
                role="Titres"
                family="Fraunces"
                sample="Aujourd'hui"
                className="font-display text-xl"
              />
              <TypeRow
                role="Interface"
                family="Hanken Grotesk"
                sample="Mission bloquée : migration Supabase"
                className="text-sm"
              />
              <TypeRow
                role="Données"
                family="JetBrains Mono"
                sample="2 h 48 · tentative 1/2 · M-248"
                className="font-mono text-xs"
              />
            </dl>
            <p className="mt-3 text-xs leading-relaxed text-muted">
              Les trois familles sont sous SIL Open Font License 1.1 et auto-hébergées
              au build.
            </p>
          </div>

          <div>
            <p className="label-mono">Palette</p>
            <ul className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {[
                ["Obsidian", "#0B0C10", "bg-obsidian"],
                ["Surface", "#13151B", "bg-surface"],
                ["Surface active", "#1A1D25", "bg-raised"],
                ["Indy", "#7895F8", "bg-indy"],
                ["Ivoire", "#EEEAE2", "bg-ivory"],
                ["Sourdine", "#858B9C", "bg-muted"],
                ["Succès", "#5FD39B", "bg-ok"],
                ["Attention", "#E8B45F", "bg-attention"],
                ["Échec", "#F4796B", "bg-danger"],
                ["Attente", "#B49BF0", "bg-waiting"],
              ].map(([name, hex, swatch]) => (
                <li key={hex} className="flex items-center gap-2.5">
                  <span
                    aria-hidden
                    className={cn(
                      "size-6 shrink-0 rounded-xs border border-line-strong",
                      swatch,
                    )}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-xs text-ivory">{name}</span>
                    <span className="block font-mono text-[0.625rem] text-muted">
                      {hex}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <Section id="limites" title="Limites du prototype">
        <ul className="space-y-2.5 py-4">
          {[
            "Aucun backend, aucune base de données, aucun appel réseau vers les systèmes réels.",
            "Aucun coût affiché : Codex tourne sur l'abonnement de l'utilisateur, et le cockpit n'estime rien. Aucun budget financier n'existe dans le modèle métier ni à l'écran.",
            "Les données sont fictives et figées à une journée de démonstration.",
            "Les actions modifient l'écran, elles ne déclenchent rien à l'extérieur.",
            "Les commandes de tâches — todo.capture, todo.triage, todo.complete, todo.cancel — sont simulées : rien n'est transmis à Hermes, rien n'est écrit dans Obsidian.",
            "Le sélecteur de rôle simule un point de vue, ce n'est pas une authentification.",
          ].map((line) => (
            <li key={line} className="flex items-start gap-2.5">
              <Lock
                aria-hidden
                size={12}
                strokeWidth={1.75}
                className="mt-1 shrink-0 text-muted"
              />
              <span className="text-xs leading-relaxed text-muted">{line}</span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function TypeRow({
  role,
  family,
  sample,
  className,
}: {
  role: string;
  family: string;
  sample: string;
  className: string;
}) {
  return (
    <div className="border-b border-line pb-3 last:border-b-0">
      <dt className="flex items-baseline gap-2">
        <span className="label-mono">{role}</span>
        <span className="font-mono text-[0.625rem] text-muted">{family}</span>
      </dt>
      <dd className={cn("mt-1 text-ivory", className)}>{sample}</dd>
    </div>
  );
}
