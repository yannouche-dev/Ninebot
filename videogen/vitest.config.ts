import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __BUILD__: JSON.stringify({ test: true }) },
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
});
