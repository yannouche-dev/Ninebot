// Journal de l'application : étapes, requêtes, erreurs. Tout texte est masqué AVANT d'être stocké :
// aucune clé ni aucun jeton ne peut s'y retrouver en clair (URL, en-têtes, corps de réponse compris).

export type Level = 'debug' | 'info' | 'warn' | 'error';
export interface Entry {
  ts: number;
  level: Level;
  cat: string;
  msg: string;
  detail?: string;
}

const secrets = new Map<string, string>(); // valeur -> étiquette
const MAX = 3000;
const entries: Entry[] = [];
const listeners = new Set<(e: Entry | null) => void>();

/** Enregistre une valeur secrète à masquer partout (ex. registerSecret(cle, 'vast')). */
export function registerSecret(value: string | undefined | null, label: string): void {
  if (!value || value.length < 6) return;
  secrets.set(value, label);
  // Variantes encodées (dans une URL) de la même valeur.
  const enc = encodeURIComponent(value);
  if (enc !== value) secrets.set(enc, label);
}

export function maskValue(value: string, label = ''): string {
  if (value.length < 10) return '***';
  return `${label ? label + '_' : ''}…${value.slice(-4)}`;
}

const PATTERNS: [RegExp, (m: string, ...g: string[]) => string][] = [
  // En-têtes / chaînes « Bearer xxx »
  [/\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{6,})(?![A-Za-z0-9._~+/=-]|…)/g, (_m, kind, v) => `${kind} ${maskValue(v)}`],
  // Paramètres d'URL sensibles
  [/([?&](?:token|api_key|apikey|key|access_token|password)=)([^&#\s"'<>]+)/gi, (_m, k, v) => `${k}${v.includes('…') ? v : maskValue(v)}`],
  // Tokens Hugging Face
  [/\bhf_[A-Za-z0-9]{8,}\b/g, (m) => maskValue(m, 'hf')],
  // Champs JSON sensibles : "xxx_token": "...", "api_key": "...", "authorization": "..."
  [
    /("[A-Za-z0-9_-]*(?:token|key|secret|password|authorization)[A-Za-z0-9_-]*"\s*:\s*")([^"\\]{4,})(")/gi,
    (_m, a, v, c) => `${a}${v.includes('…') ? v : maskValue(v)}${c}`,
  ],
  // Paires d'environnement Vast : ["HF_TOKEN", "valeur"]
  [
    /(\[\s*"[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z0-9_]*"\s*,\s*")([^"\\]{4,})(")/g,
    (_m, a, v, c) => `${a}${v.includes('…') ? v : maskValue(v)}${c}`,
  ],
  // Variables d'environnement en clair : HF_TOKEN=xxx
  [/\b([A-Z0-9_]*(?:TOKEN|API_KEY|SECRET|PASSWORD))=([^\s"'&;]{4,})/g, (_m, k, v) => `${k}=${v.includes('…') ? v : maskValue(v)}`],
];

/** Masque toutes les valeurs secrètes connues et les motifs sensibles d'un texte. */
export function mask(text: string): string {
  let out = text;
  // Les plus longues d'abord (une valeur encodée peut contenir la valeur brute).
  const known = [...secrets.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [value, label] of known) {
    if (out.includes(value)) out = out.split(value).join(maskValue(value, label));
  }
  for (const [re, fn] of PATTERNS) out = out.replace(re, fn as (substring: string, ...args: string[]) => string);
  return out;
}

function stringify(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) return undefined;
  if (typeof detail === 'string') return detail;
  if (detail instanceof Error) return `${detail.name}: ${detail.message}`;
  try {
    return JSON.stringify(detail, null, 1);
  } catch {
    return String(detail);
  }
}

export function log(level: Level, cat: string, msg: string, detail?: unknown): Entry {
  let d = stringify(detail);
  if (d && d.length > 6000) d = d.slice(0, 6000) + ' …[tronqué]';
  const e: Entry = { ts: Date.now(), level, cat, msg: mask(msg), detail: d ? mask(d) : undefined };
  entries.push(e);
  if (entries.length > MAX) entries.splice(0, entries.length - MAX);
  for (const l of listeners) l(e);
  if (level === 'error' && typeof console !== 'undefined') console.warn(`[${cat}] ${e.msg}`);
  return e;
}

export const journal = {
  debug: (cat: string, msg: string, d?: unknown) => log('debug', cat, msg, d),
  info: (cat: string, msg: string, d?: unknown) => log('info', cat, msg, d),
  warn: (cat: string, msg: string, d?: unknown) => log('warn', cat, msg, d),
  error: (cat: string, msg: string, d?: unknown) => log('error', cat, msg, d),
  entries: (): readonly Entry[] => entries,
  subscribe(fn: (e: Entry | null) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  clear(): void {
    entries.length = 0;
    for (const l of listeners) l(null);
  },
  forgetSecrets(): void {
    secrets.clear();
  },
  toText(filter?: (e: Entry) => boolean): string {
    return entries
      .filter((e) => (filter ? filter(e) : true))
      .map((e) => {
        const t = new Date(e.ts).toISOString().replace('T', ' ').replace('Z', '');
        return `${t} ${e.level.toUpperCase().padEnd(5)} [${e.cat}] ${e.msg}${e.detail ? '\n    ' + e.detail.replace(/\n/g, '\n    ') : ''}`;
      })
      .join('\n');
  },
};
