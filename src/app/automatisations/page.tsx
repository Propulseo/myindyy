"use client";

import { useMemo } from "react";
import { AutomationRow } from "@/components/automation/AutomationRow";
import { PageHeading, Section } from "@/components/primitives/Layout";
import { ScreenState } from "@/components/shell/ScreenState";
import { useCockpit } from "@/lib/cockpit";
import { plural } from "@/lib/format";
import { visibleAutomations } from "@/lib/selectors";
import type { Automation } from "@/types/domain";

export default function AutomationsPage() {
  const { viewer, data } = useCockpit();
  const automations = useMemo(() => visibleAutomations(data, viewer), [data, viewer]);

  const noisy = automations.filter((item) => item.health !== "saine");
  const quiet = automations.filter((item) => item.health === "saine");

  return (
    <div className="space-y-8">
      <PageHeading
        title="Automatisations"
        lede="Les missions qui reviennent d'elles-mêmes. Une automatisation saine reste silencieuse : elle ne remonte sur Aujourd'hui que si elle échoue, détecte quelque chose, demande une décision, ou sort de sa durée ou de son budget habituels."
      />

      <ScreenState
        isEmpty={automations.length === 0}
        loadingLabel="Chargement des automatisations"
        emptyTitle="Aucune automatisation."
        emptyMessage="Rien ne tourne en récurrence sur les projets qui vous sont affectés."
      >
        <div className="space-y-8">
          {noisy.length > 0 ? (
            <Section
              id="a-regarder"
              title="À regarder"
              count={noisy.length}
            >
              <AutomationList automations={noisy} />
            </Section>
          ) : null}

          <Section
            id="silencieuses"
            title="Silencieuses"
            count={quiet.length}
            action={
              <span className="font-mono text-[0.6875rem] text-muted">
                {plural(
                  quiet.reduce((total, item) => total + item.runCount, 0),
                  "exécution",
                )}{" "}
                sans remarque
              </span>
            }
          >
            <AutomationList automations={quiet} />
          </Section>
        </div>
      </ScreenState>
    </div>
  );
}

function AutomationList({ automations }: { automations: Automation[] }) {
  return (
    <div>
      {automations.map((automation) => (
        <AutomationRow key={automation.id} automation={automation} />
      ))}
    </div>
  );
}
