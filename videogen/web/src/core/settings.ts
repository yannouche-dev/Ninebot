// Réglages non secrets, conservés en clair dans localStorage (préfixe « videogen. »).

export interface Settings {
  /** URL du Worker Cloudflare qui relaie l'API Vast (ex. https://videogen-vast-proxy.xxx.workers.dev). */
  proxyUrl: string;
  /** Noms de GPU Vast acceptés, par ordre de préférence. */
  gpuNames: string[];
  numGpus: number;
  minReliability: number;
  minInetDown: number;
  diskGB: number;
  maxPrice: number;
  minCuda: number;
  /** Image Docker de l'instance. */
  image: string;
  comfyVersion: string;
  families: string[];
  idleMinutes: number;
  maxHours: number;
  label: string;
  /** Délai sans progression avant d'abandonner une génération (minutes). */
  stallMinutes: number;
}

export const GPU_PRO6000 = ['RTX PRO 6000 WS', 'RTX PRO 6000 S', 'RTX PRO 6000', 'RTX PRO 6000 Max-Q'];
export const GPU_5090 = ['RTX 5090'];

export const DEFAULT_SETTINGS: Settings = {
  proxyUrl: '',
  gpuNames: [...GPU_PRO6000, ...GPU_5090],
  numGpus: 1,
  minReliability: 0.99,
  minInetDown: 500,
  diskGB: 150,
  maxPrice: 2.5,
  minCuda: 12.9,
  image: 'vastai/pytorch:2.10.0-cu128-cuda-12.9-mini-py312-2026-10-23',
  comfyVersion: 'v0.44.2',
  families: ['ltx25'],
  idleMinutes: 20,
  maxHours: 4,
  label: 'videogen',
  stallMinutes: 15,
};

const KEY = 'videogen.settings.v1';

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = storage()?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function saveJson(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    /* stockage plein ou indisponible */
  }
}

export function loadSettings(defaultProxy = ''): Settings {
  const s = { ...DEFAULT_SETTINGS, ...loadJson<Partial<Settings>>(KEY, {}) };
  if (!s.proxyUrl && defaultProxy) s.proxyUrl = defaultProxy;
  return s;
}
export function saveSettings(s: Settings): void {
  saveJson(KEY, s);
}

// ------------------------------------------------------------ préréglages de génération

export interface GenPreset {
  name: string;
  modelId: string;
  values: Record<string, unknown>;
}
const PRESETS_KEY = 'videogen.presets.v1';
export function loadPresets(): GenPreset[] {
  return loadJson<GenPreset[]>(PRESETS_KEY, []);
}
export function savePresets(p: GenPreset[]): void {
  saveJson(PRESETS_KEY, p);
}

// ------------------------------------------------------------ suivi de session (coût)

export interface SessionMeta {
  instanceId: number;
  /** Début de la période « allumée » en cours (ms). */
  runningSince: number | null;
  dph: number;
}
const SESSION_KEY = 'videogen.session.v1';
export function loadSession(): SessionMeta | null {
  return loadJson<SessionMeta | null>(SESSION_KEY, null);
}
export function saveSession(s: SessionMeta | null): void {
  if (s) saveJson(SESSION_KEY, s);
  else storage()?.removeItem(SESSION_KEY);
}
