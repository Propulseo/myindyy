import { expect, test } from '@playwright/test';

const backendOrigin = process.env.INDY_E2E_BACKEND_ORIGIN ?? 'http://127.0.0.1:17692';

test.beforeEach(async ({ request }) => {
  const response = await request.post('/__e2e/reset');
  expect(response.ok()).toBeTruthy();
});

test('the trusted proxy strips spoofed Indy headers while the backend rejects direct and hostile traffic', async ({ request }) => {
  const throughProxy = await request.get('/api/tasks', {
    headers: {
      'X-Indy-User': 'lucas',
      'X-Indy-Proxy-Secret': 'client-supplied-value-must-be-stripped',
    },
  });
  const hostileOrigin = await request.post('/api/tasks', {
    headers: {
      Origin: 'https://hostile.example.test',
      'Sec-Fetch-Site': 'same-origin',
    },
    data: { description: 'must not exist' },
  });
  const direct = await request.get(`${backendOrigin}/api/tasks`);

  expect(throughProxy.status()).toBe(200);
  expect(hostileOrigin.status()).toBe(403);
  expect(direct.status()).toBe(401);
});

test('runtime failure is visible and disables mission launch', async ({ page, request }) => {
  await expect((await request.post('/__e2e/runtime', { data: { authState: 'missing' } })).ok()).toBeTruthy();

  await page.goto('/tasks/new');

  await expect(page.getByText('Codex OAuth non connecté')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Créer la mission' })).toBeDisabled();
});

test('Etienne creates, observes, resumes, corrects, retries, and recovers a durable Codex mission', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByText('Codex OAuth connecté')).toBeVisible();
  await page.getByRole('link', { name: 'Nouvelle mission' }).click();
  await page.getByRole('textbox').fill('Inspecter le dépôt de test');
  await page.getByLabel('Modèle Codex').selectOption('gpt-5.6-sol');
  await page.getByLabel('Effort de raisonnement').selectOption('high');
  await page.getByRole('button', { name: 'Créer la mission' }).click();

  await expect(page.getByLabel('Timeline d’exécution').getByText('terminal', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Tentative 1')).toBeVisible();
  await expect(page.getByText('Terminée', { exact: true })).toBeVisible();

  const workerState = await (await request.get('/__e2e/state')).json() as {
    chats: Array<{ model: string; reasoningEffort: string; cwd: string }>;
    configuredWorkspace: string;
  };
  expect(workerState.chats[0]).toMatchObject({
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    cwd: workerState.configuredWorkspace,
  });

  await page.getByRole('button', { name: 'Ajouter une instruction' }).click();
  await page.getByLabel('Instruction à ajouter').fill('Attendre ma correction');
  await page.getByRole('button', { name: 'Envoyer l’instruction' }).click();
  const attempt2 = page.getByLabel('Timeline d’exécution')
    .getByRole('heading', { name: 'Tentative 2' })
    .locator('..');
  await expect(attempt2).toBeVisible();
  await expect(attempt2.getByText('En cours', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Interrompre et corriger' }).click();
  await page.getByLabel('Instruction de correction').fill('Lecture seule');
  await page.getByRole('button', { name: 'Envoyer la correction' }).click();
  await expect(page.getByText('Tentative 3')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Correction envoyée');

  await page.reload();
  await expect(page.getByText('Lecture seule', { exact: true })).toBeVisible();
  await expect(page.getByText('Tentative 3')).toBeVisible();

  const restart = await request.post('/__e2e/restart');
  expect(restart.ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByText('Lecture seule', { exact: true })).toBeVisible();
  await expect(page.getByText('Tentative 3')).toBeVisible();
  await expect(page.getByLabel('Timeline d’exécution').getByText('terminal', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Relancer' }).click();
  await expect(page.getByText('Tentative 4')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Mission relancée');

  await page.reload();
  await expect(page.getByText('Tentative 4')).toBeVisible();
  await expect(page.getByLabel('Timeline d’exécution').getByText('terminal', { exact: true }).first()).toBeVisible();
});
