import { expect, type Page } from '@playwright/test';

export const VAST_KEY = 'test-vast-key-0123456789abcdef';
export const HF_TOKEN = 'hf_TestToken0123456789abcdef';
export const PASS = 'phrase de passe de test';
export const MOCK = 'http://127.0.0.1:4310';

export async function resetMocks(): Promise<void> {
  await fetch(`${MOCK}/__mock/reset`, { method: 'POST' });
}
export async function mockState(): Promise<{ instances: Record<string, unknown>[]; creates: { offerId: number; body: { env: Record<string, string>; onstart: string; label: string; image: string; disk: number; runtype: string } }[]; requests: { auth: string; path: string; method: string }[]; comfy: { deletions: { filename: string }[]; views: string[]; uploads: string[]; prompts: number } | null }> {
  return (await fetch(`${MOCK}/__mock/state`)).json();
}

/** Saisie des clés, tests, enregistrement chiffré. */
export async function enterKeys(page: Page, opts: { remember?: boolean } = {}): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Clés' })).toBeVisible();
  await expect(page.locator('#proxy-url')).toHaveValue('http://127.0.0.1:4311');
  await page.fill('#vast-key', VAST_KEY);
  await page.getByTestId('test-vast').click();
  await expect(page.getByTestId('vast-test')).toContainText('OK — compte test@example.com, crédit 25.50 $');
  await page.fill('#hf-token', HF_TOKEN);
  await page.getByTestId('test-hf').click();
  await expect(page.getByTestId('hf-test')).toContainText('OK — testuser');
  await expect(page.getByTestId('hf-test')).toContainText('LTX-2.5 : OK');
  await page.fill('#new-pass', PASS);
  if (opts.remember === false) await page.uncheck('#remember');
  await page.getByTestId('save-keys').click();
  await expect(page.getByTestId('phase')).toBeVisible();
}

export async function rentAndWaitReady(page: Page, offerId = 502): Promise<void> {
  await page.getByTestId('tab-instance').click();
  await page.getByTestId('start').click();
  await expect(page.getByTestId('offers')).toBeVisible();
  await page.getByTestId(`offer-${offerId}`).click();
  await expect(page.getByTestId('confirm-price')).toBeVisible();
  await page.getByTestId('dialog-ok').click();
  await expect(page.getByTestId('phase')).toHaveText('Prête', { timeout: 90_000 });
}

export async function generate(page: Page, prompt: string): Promise<void> {
  await page.getByTestId('tab-generate').click();
  await page.getByTestId('prompt').fill(prompt);
  await expect(page.getByTestId('generate')).toBeEnabled();
  await page.getByTestId('generate').click();
}
