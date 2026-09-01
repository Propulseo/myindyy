import { expect, test } from "@playwright/test";
import { captureTask, chooseRole, taskRow } from "./helpers";

const TITRE = "Vérifier le renouvellement du certificat TLS";

test.describe("tâches Obsidian · capture puis annulation", () => {
  test("une tâche annulée reste affichée avec le statut « Annulée »", async ({
    page,
  }) => {
    await page.goto("/");
    await captureTask(page, TITRE, "Propul'SEO");

    const ligne = taskRow(page, TITRE);
    await expect(ligne).toHaveCount(1);
    await expect(ligne.getByText("À faire")).toBeVisible();
    await expect(ligne.getByText("Propul'SEO")).toBeVisible();

    await ligne.getByRole("button", { name: /Actions sur la tâche/ }).click();
    await page.getByRole("menuitem", { name: /Annuler la tâche/ }).click();

    // Le panneau annonce ce qui va réellement se passer.
    const panneau = page.getByRole("dialog");
    await expect(panneau.getByText("n'est pas supprimée")).toBeVisible();
    await expect(panneau.getByText("reste affichée dans les tâches du jour")).toBeVisible();
    await panneau
      .getByRole("button", { name: "Annuler la tâche", exact: true })
      .click();
    await expect(panneau).toBeHidden();

    // Ce que le panneau annonçait est ce que l'écran fait.
    await expect(ligne).toHaveCount(1);
    await expect(ligne.getByText("Annulée")).toBeVisible();
    // Le titre, le projet et le responsable sont conservés tels quels.
    await expect(ligne).toContainText(TITRE);
    await expect(ligne).toContainText("Propul'SEO");
    await expect(ligne).toContainText("Étienne Guimbard");
  });

  test("le menu propose les trois commandes, nommées", async ({ page }) => {
    await page.goto("/");
    await captureTask(page, TITRE, "Propul'SEO");

    await taskRow(page, TITRE)
      .getByRole("button", { name: /Actions sur la tâche/ })
      .click();

    await expect(page.getByRole("menuitem", { name: /todo\.complete/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /todo\.triage/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /todo\.cancel/ })).toBeVisible();
  });
});

test.describe("tâches Obsidian · périmètre des rôles", () => {
  for (const role of ["Lucas Marchand", "Lyes Benali"]) {
    test(`${role} ne voit aucune tâche personnelle`, async ({ page }) => {
      await page.goto("/");
      await chooseRole(page, role);

      const taches = page.locator("#taches");
      // La section n'est pas vide : le test ne passe pas par accident.
      await expect(taches.locator("li")).not.toHaveCount(0);

      await expect(taches.getByText("Personnel", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Rendez-vous comptable")).toHaveCount(0);
      await expect(page.getByText("Renouveler l'assurance professionnelle")).toHaveCount(
        0,
      );
      await expect(
        page.getByText("Répondre à la proposition de partenariat"),
      ).toHaveCount(0);

      // Un projet non affecté n'apparaît nulle part non plus.
      await expect(page.getByText("DocAgora")).toHaveCount(0);
    });
  }

  test("Étienne voit ses tâches personnelles", async ({ page }) => {
    await page.goto("/");

    const taches = page.locator("#taches");
    await expect(taches.getByText("Personnel", { exact: true }).first()).toBeVisible();
    await expect(taches).toContainText("Rendez-vous comptable à 17 h");
  });
});
