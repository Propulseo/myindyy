import { expect, test } from "@playwright/test";

/**
 * Le défaut d'origine : « Refuser » annulait la mission sans rien annoncer.
 * Ce parcours rejoue exactement le geste signalé pendant l'audit.
 */
test.describe("M-248 · refuser un déploiement en production", () => {
  test("passe par le panneau sensible, sans mot à saisir", async ({ page }) => {
    await page.goto("/missions/m-248");

    const entete = page.locator("#contenu header").first();
    await expect(entete.getByText("Attend une validation")).toBeVisible();

    await page.getByRole("button", { name: "Examiner et refuser" }).click();

    const panneau = page.getByRole("dialog");
    await expect(
      panneau.getByRole("heading", { name: /^Refuser : déployer la landing/ }),
    ).toBeVisible();

    // Tout est annoncé avant le geste.
    await expect(panneau.getByText("Conséquence")).toBeVisible();
    await expect(panneau.getByText("La mission n'est pas annulée")).toBeVisible();
    await expect(panneau.getByText("Confirmé par Étienne Guimbard")).toBeVisible();

    // Un refus n'écrit rien à l'extérieur : aucun champ à saisir.
    await expect(panneau.getByRole("textbox")).toHaveCount(0);
    await expect(panneau.getByText(/pour confirmer/)).toHaveCount(0);
  });

  test("laisse la mission en attente, jamais annulée", async ({ page }) => {
    await page.goto("/missions/m-248");
    await page.getByRole("button", { name: "Examiner et refuser" }).click();

    const panneau = page.getByRole("dialog");
    await panneau.getByRole("button", { name: "Refuser", exact: true }).click();
    await expect(panneau).toBeHidden();

    const entete = page.locator("#contenu header").first();
    await expect(entete.getByText("En attente")).toBeVisible();
    await expect(entete.getByText("Annulée")).toHaveCount(0);

    // « Reprendre » n'existe que pour une mission en attente.
    await expect(page.getByRole("button", { name: "Reprendre" })).toBeVisible();

    // Les étapes et le décompte des livrables sont conservés.
    await expect(page.getByText("5 / 6")).toBeVisible();

    // Et la décision refusée ne redemande plus de réponse.
    await expect(
      page.getByRole("button", { name: "Examiner et approuver" }),
    ).toHaveCount(0);
  });

  test("l'annulation d'une mission reste une action séparée", async ({ page }) => {
    await page.goto("/missions/m-248");

    await page.getByRole("button", { name: "Annuler", exact: true }).click();

    const panneau = page.getByRole("dialog");
    await expect(
      panneau.getByRole("heading", { name: /^Annuler la mission/ }),
    ).toBeVisible();
    await expect(panneau.getByText("L'exécution s'arrête immédiatement")).toBeVisible();
  });
});
