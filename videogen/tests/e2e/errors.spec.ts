// Erreurs : mauvaise clé, offre déjà louée, OOM, nœud manquant, annulation, coffre (phrase fausse,
// verrouillage, effacement), reprise d'une instance arrêtée, rappel avant fermeture.
import { test, expect } from '@playwright/test';
import { enterKeys, rentAndWaitReady, generate, resetMocks, mockState, MOCK, PASS, VAST_KEY } from './helpers.ts';

test.beforeEach(async () => {
  await resetMocks();
});

test('clés invalides : résultat du test affiché', async ({ page }) => {
  await page.goto('/');
  await page.fill('#vast-key', 'mauvaise-cle-0000000000');
  await page.getByTestId('test-vast').click();
  await expect(page.getByTestId('vast-test')).toHaveText('Clé refusée par Vast (401)');
  await page.fill('#hf-token', 'hf_mauvais0000000000');
  await page.getByTestId('test-hf').click();
  await expect(page.getByTestId('hf-test')).toHaveText('Token refusé par Hugging Face (401)');
  // Le Journal contient l'erreur HTTP, mais jamais la clé
  await page.getByTestId('save-keys').click();
  await expect(page.locator('[role=alert]')).toContainText('phrase de passe');
});

test('offre déjà louée, OOM, nœud manquant, annulation', async ({ page }) => {
  await enterKeys(page);
  await page.getByTestId('start').click();
  await page.getByTestId('offer-666').click();
  await page.getByTestId('dialog-ok').click();
  await expect(page.locator('.toast-error')).toContainText('vient d’être louée');
  expect((await mockState()).instances).toHaveLength(0);

  await rentAndWaitReady(page, 503);

  await generate(page, 'a cat #oom');
  await expect(page.getByTestId('gen-error')).toHaveText('Mémoire GPU insuffisante (OOM)');

  await page.getByTestId('prompt').fill('a cat #missing');
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('gen-error')).toHaveText('Nœud manquant sur le serveur');

  await page.getByTestId('prompt').fill('a very long render #slow');
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('gen-bar')).toBeVisible();
  await expect.poll(async () => page.getByTestId('gen-bar').evaluate((b: HTMLProgressElement) => b.value)).toBeGreaterThan(0);
  await page.getByTestId('cancel').click();
  await page.getByTestId('dialog-ok').click();
  await expect(page.getByTestId('gen-error')).toHaveText('Génération annulée');

  // I2V sans image : refus côté interface
  await page.getByTestId('model-select').selectOption('ltx25-i2v');
  await page.getByTestId('prompt').fill('pan right');
  await page.getByTestId('generate').click();
  await expect(page.locator('.toast-error', { hasText: 'image de début' })).toBeVisible();

  // Journal : erreurs lisibles + code HTTP
  await page.getByTestId('tab-journal').click();
  await expect(page.getByTestId('journal-list')).toContainText('HTTP 410');
  await expect(page.getByTestId('journal-list')).toContainText('Mémoire GPU insuffisante');
  await expect(page.getByTestId('journal-list')).toContainText('HTTP 400');
});

test('coffre : phrase fausse, déverrouillage, verrouillage, tout effacer', async ({ page }) => {
  await enterKeys(page);
  // Le coffre stocké est chiffré : aucune clé lisible dans localStorage
  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  expect(stored).not.toContain(VAST_KEY);
  expect(stored).toContain('PBKDF2-SHA256');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Déverrouiller' })).toBeVisible();
  await page.fill('#unlock-pass', 'pas la bonne');
  await page.getByTestId('unlock').click();
  await expect(page.locator('[role=alert]')).toHaveText('Phrase de passe incorrecte.');
  await page.fill('#unlock-pass', PASS);
  await page.getByTestId('unlock').click();
  await expect(page.getByTestId('phase')).toBeVisible();

  await page.getByTestId('lock').click();
  await expect(page.getByRole('heading', { name: 'Déverrouiller' })).toBeVisible();
  await page.getByRole('button', { name: /Tout effacer/ }).click();
  await page.getByTestId('dialog-ok').click();
  await expect(page.getByRole('heading', { name: 'Clés' })).toBeVisible();
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('videogen.')))).toHaveLength(0);
});

test('« ne pas mémoriser » : rien dans localStorage', async ({ page }) => {
  await enterKeys(page, { remember: false });
  expect(await page.evaluate(() => localStorage.getItem('videogen.vault.v1'))).toBeNull();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Clés' })).toBeVisible();
});

test('reprise d’une instance arrêtée existante + rappel avant fermeture', async ({ page }) => {
  // Le jeton ComfyUI est relu depuis les variables d'environnement de l'instance (autre appareil).
  const token = 'Zk3vQx9_reprise_jeton_ComfyUI_0123456789abcd';
  await fetch(`${MOCK}/__mock/seed-stopped`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  await enterKeys(page);
  await expect(page.getByTestId('phase')).toHaveText('Arrêtée');
  await page.getByTestId('start').click();
  await page.getByTestId('dialog-ok').click();
  await expect(page.getByTestId('phase')).toHaveText('Prête', { timeout: 60_000 });
  expect((await mockState()).creates).toHaveLength(0);
  await expect(page.getByTestId('cost-banner')).toBeVisible();
  const text = await page.locator('body').innerText();
  expect(text).not.toContain(token);

  let sawBeforeUnload = false;
  page.on('dialog', async (d) => {
    if (d.type() === 'beforeunload') sawBeforeUnload = true;
    await d.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => sawBeforeUnload).toBe(true);
});
