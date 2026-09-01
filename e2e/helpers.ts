import { expect, type Page } from "@playwright/test";

/**
 * Change le rôle de démonstration en passant par le sélecteur, comme un humain.
 *
 * On ne préremplit pas le stockage local : le but est justement de vérifier que le
 * cockpit change de point de vue quand on utilise le contrôle prévu pour ça.
 */
export async function chooseRole(page: Page, name: string): Promise<void> {
  await page
    .getByRole("button", { name: /Changer de rôle de démonstration/ })
    .click();
  await page.getByRole("menuitem", { name: new RegExp(name) }).click();
  await expect(
    page.getByRole("button", { name: new RegExp(`Rôle actuel : ${name}`) }),
  ).toBeVisible();
}

/** La ligne de tâche qui porte ce titre, dans « Tâches Obsidian du jour ». */
export function taskRow(page: Page, title: string) {
  return page.locator("#taches li").filter({ hasText: title });
}

/** Ouvre le panneau de capture et remplit le minimum pour qu'il soit valide. */
export async function captureTask(
  page: Page,
  title: string,
  projectLabel: string,
): Promise<void> {
  await page.getByRole("button", { name: "Capturer une tâche" }).first().click();

  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: "Capturer une tâche" })).toBeVisible();
  await sheet.getByLabel("Titre", { exact: true }).fill(title);
  await sheet.getByLabel("Projet", { exact: true }).selectOption({ label: projectLabel });
  await sheet.getByRole("button", { name: "Capturer", exact: true }).click();

  await expect(sheet).toBeHidden();
}
