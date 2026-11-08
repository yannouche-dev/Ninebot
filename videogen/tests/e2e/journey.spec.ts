// Parcours complet : clés → location → démarrage → génération → prolongation → assemblage → arrêt →
// redémarrage → destruction, avec vérification qu'aucun secret ne fuit (instance, Journal).
import { test, expect } from '@playwright/test';
import { enterKeys, rentAndWaitReady, generate, resetMocks, mockState, VAST_KEY, HF_TOKEN } from './helpers.ts';

test.beforeEach(async () => {
  await resetMocks();
});

test('parcours complet sur mobile', async ({ page }) => {
  await enterKeys(page);

  // --- Démarrer : liste d'offres, RTX PRO 6000 d'abord, confirmation du prix
  await page.getByTestId('start').click();
  const offers = page.getByTestId('offers').locator('button.offer');
  await expect(offers.first()).toBeVisible();
  const names = await offers.locator('.offer-gpu').allTextContents();
  expect(names[0]).toContain('RTX PRO 6000');
  expect(names.at(-1)).toContain('RTX 5090');
  expect(names.join(' ')).not.toContain('4090');
  await page.getByTestId('offer-502').click();
  await expect(page.getByTestId('confirm-price')).toHaveText('1,204 $/h');
  await page.getByTestId('dialog-ok').click();

  // --- Étapes visibles jusqu'à « Prêt »
  await expect(page.locator('[data-step="rented"]')).toHaveClass(/step-done/);
  await expect(page.locator('[data-step="tunnel"]')).toHaveClass(/step-done/, { timeout: 60_000 });
  await expect(page.locator('[data-step="models"]')).toHaveClass(/step-(running|done)/);
  await expect(page.getByTestId('phase')).toHaveText('Prête', { timeout: 60_000 });
  await expect(page.locator('[data-step="ready"]')).toHaveClass(/step-done/);
  await expect(page.getByTestId('cost-banner')).toContainText('Instance allumée');

  // --- Ce qui a été transmis à Vast : jamais la clé principale, amorce courte, env attendu
  const st = await mockState();
  const create = st.creates[0];
  expect(create.offerId).toBe(502);
  expect(JSON.stringify(create.body)).not.toContain(VAST_KEY);
  expect(create.body.onstart.length).toBeLessThan(4048);
  expect(create.body.onstart).toContain('sha256sum -c');
  expect(create.body.env.ALLOWED_ORIGIN).toBe('http://127.0.0.1:4173');
  expect(create.body.env.HF_TOKEN).toBe(HF_TOKEN);
  expect(create.body.env.COMFY_ACCESS_TOKEN.length).toBeGreaterThanOrEqual(43);
  expect(create.body.env.MODELS).toBe('ltx25');
  expect(create.body.label).toBe('videogen');
  expect(create.body.runtype).toBe('ssh');

  // --- Modèles : Wan et Hunyuan absents du serveur → grisés
  await page.getByTestId('tab-generate').click();
  const select = page.getByTestId('model-select');
  const optDisabled = (v: string) => select.locator(`option[value="${v}"]`).evaluate((o: HTMLOptionElement) => o.disabled);
  await expect.poll(() => optDisabled('wan22-t2v')).toBe(true);
  expect(await optDisabled('hy15-i2v')).toBe(true);
  expect(await optDisabled('ltx25-t2v')).toBe(false);
  await expect(select.locator('option[value="wan22-t2v"]')).toContainText('absent du serveur');
  // Seules les options supportées : LTX distillé → pas de steps/CFG
  await expect(page.locator('#steps')).toHaveCount(0);
  await expect(page.locator('#enhancePrompt')).toHaveCount(1);
  await page.getByTestId('ratio-9:16').click();
  await expect(page.getByTestId('size')).toHaveText('704 × 1280');
  await page.getByTestId('ratio-16:9').click();
  await expect(page.getByTestId('size')).toHaveText('1280 × 704');

  // --- Génération T2V
  await generate(page, 'A red fox runs through fresh snow at dawn, cinematic tracking shot');
  await expect(page.getByTestId('gen-progress')).toBeVisible();
  await expect(page.getByTestId('result-video')).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => page.getByTestId('result-video').evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(0);
  const src = await page.getByTestId('result-video').getAttribute('src');
  expect(src).toMatch(/^blob:/);

  // --- Prolonger : dernière image extraite → LTX-2.5 I2V pré-rempli
  await page.getByTestId('extend').click();
  await expect(select).toHaveValue('ltx25-i2v');
  await expect(page.locator('.img-preview img')).toBeVisible();
  await expect(page.getByTestId('prompt')).toHaveValue(/red fox/);
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('result-video')).toBeVisible({ timeout: 60_000 });

  // --- Fichiers supprimés sur l'instance après récupération (sorties + image envoyée)
  const after = await mockState();
  expect(after.comfy!.views).toHaveLength(2);
  const deleted = after.comfy!.deletions.map((d) => d.filename);
  for (const v of after.comfy!.views) expect(deleted).toContain(v);
  expect(deleted.some((f) => /^vg_.+\.png$/.test(f))).toBe(true);

  // --- Galerie, timeline, assemblage ffmpeg.wasm
  await page.getByTestId('tab-gallery').click();
  await expect(page.getByTestId('gallery-grid').locator('.tile')).toHaveCount(2);
  await expect(page.getByTestId('timeline').locator('li')).toHaveCount(2);
  await page.getByTestId('down-v1').click();
  await expect(page.getByTestId('timeline').locator('li').first()).toHaveAttribute('data-testid', 'tl-v2');
  await page.getByTestId('up-v1').click();
  await page.getByTestId('assemble').click();
  await expect(page.getByTestId('item-detail')).toContainText('Assemblage de la timeline', { timeout: 120_000 });
  const duration = await page.getByTestId('item-detail').locator('video').evaluate(
    (v: HTMLVideoElement) => new Promise<number>((r) => (v.readyState >= 1 ? r(v.duration) : v.addEventListener('loadedmetadata', () => r(v.duration)))),
  );
  expect(duration).toBeGreaterThan(3.5);

  // --- Journal : aucun secret en clair, formes masquées présentes, bouton Copier
  await page.getByTestId('tab-journal').click();
  await page.getByTestId('copy-journal').click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const comfyToken = create.body.env.COMFY_ACCESS_TOKEN;
  for (const secret of [VAST_KEY, HF_TOKEN, comfyToken]) expect(copied).not.toContain(secret);
  expect(copied).toContain('Instance prête');
  expect(copied).toMatch(/HTTP 200/);
  const pageText = await page.locator('body').innerText();
  for (const secret of [VAST_KEY, HF_TOKEN, comfyToken]) expect(pageText).not.toContain(secret);

  // --- Arrêter (disque gardé)
  await page.getByTestId('tab-instance').click();
  await page.getByTestId('stop').click();
  await page.getByTestId('dialog-ok').click();
  await expect(page.getByTestId('phase')).toHaveText('Arrêtée', { timeout: 30_000 });
  await expect(page.getByTestId('cost-banner')).toBeHidden();
  expect((await mockState()).instances[0].actual_status).toBe('stopped');

  // --- Redémarrer l'instance arrêtée (même instance, modèles déjà présents)
  await page.getByTestId('start').click();
  await expect(page.getByRole('heading', { name: /Redémarrer l’instance/ })).toBeVisible();
  await page.getByTestId('dialog-ok').click();
  await expect(page.getByTestId('phase')).toHaveText('Prête', { timeout: 60_000 });
  expect((await mockState()).creates).toHaveLength(1);

  // --- Détruire (avec confirmation)
  await page.getByTestId('destroy').click();
  await page.getByTestId('dialog-ok').click();
  await expect(page.getByTestId('phase')).toHaveText('Aucune instance', { timeout: 30_000 });
  expect((await mockState()).instances).toHaveLength(0);

  // Aucune requête Vast n'a été faite sans la clé (la clé n'apparaît que dans Authorization)
  const reqs = (await mockState()).requests.filter((r) => r.path.startsWith('/api/'));
  expect(reqs.length).toBeGreaterThan(10);
  expect(reqs.every((r) => r.auth === `Bearer ${VAST_KEY}`)).toBe(true);
});
