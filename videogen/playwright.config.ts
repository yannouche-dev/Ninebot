import { defineConfig, devices } from '@playwright/test';

// Parcours complet contre les mocks (Vast, Hugging Face, instance ComfyUI) et le vrai Worker (exécuté dans Node).
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    ...devices['Pixel 7'],
    trace: 'off',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
});
