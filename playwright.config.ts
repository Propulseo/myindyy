import { defineConfig } from "@playwright/test";

/**
 * Parcours d'interface, joués sur le build de production.
 *
 * `pnpm test:e2e` suffit depuis un clone propre : Playwright construit puis sert
 * l'application lui-même, et attend qu'elle réponde avant de commencer. Un serveur
 * déjà lancé sur le même port est réutilisé tel quel.
 *
 * Les tests visent des rôles, des libellés et des états accessibles. Aucune
 * coordonnée fixe, aucune attente arbitraire : Playwright attend l'élément.
 */
const PORT = Number(process.env.INDY_E2E_PORT ?? 3210);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : [["list"]],
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    browserName: "chromium",
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
    // Les données de démonstration sont figées ; le mouvement ne doit pas jouer.
    contextOptions: { reducedMotion: "reduce" },
    trace: "retain-on-failure",
  },

  projects: [
    {
      name: "desktop-1440x900",
      use: { viewport: { width: 1440, height: 900 } },
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      // Le petit mobile : c'est là que la barre de navigation basse et les
      // feuilles se disputent la place.
      name: "mobile-390x667",
      use: { viewport: { width: 390, height: 667 }, hasTouch: true },
      testMatch: /mobile\.spec\.ts/,
    },
  ],

  webServer: {
    command: "pnpm build && pnpm start",
    env: { PORT: String(PORT) },
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
