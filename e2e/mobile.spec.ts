import { expect, test } from "@playwright/test";
import { taskRow } from "./helpers";

const TITRE = "Relire le contrat d'hébergement";

/**
 * 390 × 667 : l'écran le plus court du prototype. C'est là que la barre de
 * navigation basse et les feuilles se disputent la place.
 */
test.describe("petit mobile · feuille de capture", () => {
  test("le corps défile et l'action principale reste visible et cliquable", async ({
    page,
  }) => {
    await page.goto("/");

    const capture = page.getByRole("button", { name: "Capturer une tâche" }).first();
    await capture.click();

    const feuille = page.getByRole("dialog");
    await expect(
      feuille.getByRole("heading", { name: "Capturer une tâche" }),
    ).toBeVisible();

    // Le corps de la feuille est bien une zone de défilement, et il déborde.
    const defilable = await feuille.evaluate((panneau) =>
      Array.from(panneau.querySelectorAll("*")).some((noeud) => {
        const style = getComputedStyle(noeud);
        return (
          /(auto|scroll)/.test(style.overflowY) &&
          noeud.scrollHeight > noeud.clientHeight + 1
        );
      }),
    );
    expect(defilable).toBe(true);

    // Le bouton principal vit dans le pied fixe : il reste dans la fenêtre.
    const valider = feuille.getByRole("button", { name: "Capturer", exact: true });
    await expect(valider).toBeInViewport();

    // Le dernier champ du formulaire est atteignable en faisant défiler.
    const note = feuille.getByLabel("Note");
    await note.scrollIntoViewIfNeeded();
    await expect(note).toBeInViewport();
    await expect(valider).toBeInViewport();

    // Et le bouton reçoit vraiment le clic : la barre du bas ne le recouvre pas.
    // Playwright vérifie lui-même que l'élément est atteignable avant de cliquer.
    await feuille.getByLabel("Titre", { exact: true }).fill(TITRE);
    await valider.click();
    await expect(feuille).toBeHidden();

    await expect(taskRow(page, TITRE)).toHaveCount(1);
  });

  test("la barre de navigation basse ne recouvre pas les actions de la journée", async ({
    page,
  }) => {
    await page.goto("/");

    // Le bouton de capture est loin dans la page : Playwright l'amène à l'écran
    // et refuse de cliquer s'il est recouvert.
    const capture = page.getByRole("button", { name: "Capturer une tâche" }).first();
    await capture.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();

    const actions = page.locator("#taches li").first().getByRole("button");
    await actions.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu).toBeInViewport();
  });
});

test.describe("petit mobile · refus d'une décision", () => {
  test("le panneau reste lisible et « Refuser » reste atteignable", async ({ page }) => {
    await page.goto("/missions/m-248");
    await page.getByRole("button", { name: "Examiner et refuser" }).click();

    const panneau = page.getByRole("dialog");
    const refuser = panneau.getByRole("button", { name: "Refuser", exact: true });
    await expect(refuser).toBeInViewport();
    await expect(panneau.getByRole("textbox")).toHaveCount(0);

    await refuser.click();
    await expect(page.locator("#contenu header").first().getByText("En attente")).toBeVisible();
  });
});
