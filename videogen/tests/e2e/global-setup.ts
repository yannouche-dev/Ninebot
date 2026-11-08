import { startAll } from '../../mocks/start-all.mjs';

export default async function globalSetup() {
  process.env.MOCK_SPEED ??= '0.5';
  const env = await startAll({ speed: Number(process.env.MOCK_SPEED) });
  return async () => env.close();
}
