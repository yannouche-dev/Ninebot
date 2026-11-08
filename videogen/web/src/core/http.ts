// Client HTTP journalisé : chaque requête, son code de retour, sa durée et (en cas d'erreur) le corps de la
// réponse sont inscrits au Journal, toujours masqués.
import { journal, mask } from './journal.ts';

export type ErrorKind = 'network' | 'timeout' | 'http' | 'aborted';

export class HttpError extends Error {
  kind: ErrorKind;
  status: number;
  body: string;
  url: string;
  constructor(kind: ErrorKind, message: string, url: string, status = 0, body = '') {
    super(message);
    this.name = 'HttpError';
    this.kind = kind;
    this.status = status;
    this.body = body;
    this.url = url;
  }
  /** Corps JSON de la réponse d'erreur, s'il y en a un. */
  json<T = unknown>(): T | null {
    try {
      return JSON.parse(this.body) as T;
    } catch {
      return null;
    }
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  json?: unknown;
  timeoutMs?: number;
  /** Catégorie du Journal (vast, comfy, hf…). */
  cat: string;
  /** Ne pas journaliser les requêtes réussies (sondages fréquents). */
  quiet?: boolean;
  /** Codes HTTP attendus pendant un sondage : pas d'erreur au Journal. */
  silentStatuses?: number[];
  signal?: AbortSignal;
}

function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

export async function request(url: string, opts: RequestOptions): Promise<Response> {
  const method = opts.method ?? (opts.json !== undefined ? 'POST' : 'GET');
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body = opts.body ?? null;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const ctrl = new AbortController();
  const timeout = opts.timeoutMs ?? 30000;
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeout);
  const onAbort = () => ctrl.abort(opts.signal?.reason);
  opts.signal?.addEventListener('abort', onAbort);
  const t0 = performance.now();
  const label = `${method} ${describeUrl(url)}`;
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, signal: ctrl.signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    if (ctrl.signal.aborted && !opts.signal?.aborted) {
      journal.error(opts.cat, `${label} → délai dépassé (${ms} ms)`);
      throw new HttpError('timeout', `Délai dépassé (${Math.round(timeout / 1000)} s)`, url);
    }
    if (opts.signal?.aborted) throw new HttpError('aborted', 'Requête annulée', url);
    const msg = e instanceof Error ? e.message : String(e);
    journal.error(
      opts.cat,
      `${label} → échec réseau (${ms} ms)`,
      `${msg}\nCauses possibles : serveur injoignable, tunnel coupé, blocage CORS ou CSP, réseau mobile instable.`,
    );
    throw new HttpError('network', 'Serveur injoignable (réseau, tunnel ou CORS)', url);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
  const ms = Math.round(performance.now() - t0);
  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      /* corps illisible */
    }
    if (opts.silentStatuses?.includes(res.status)) journal.debug(opts.cat, `${label} → HTTP ${res.status} (${ms} ms)`);
    else journal.error(opts.cat, `${label} → HTTP ${res.status} (${ms} ms)`, text.slice(0, 4000) || '(corps vide)');
    throw new HttpError('http', `HTTP ${res.status}`, url, res.status, text);
  }
  if (!opts.quiet) journal.debug(opts.cat, `${label} → HTTP ${res.status} (${ms} ms)`);
  return res;
}

export async function requestJson<T>(url: string, opts: RequestOptions): Promise<T> {
  const res = await request(url, opts);
  const text = await res.text();
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    journal.error(opts.cat, `Réponse non JSON de ${describeUrl(url)}`, mask(text.slice(0, 2000)));
    throw new HttpError('http', 'Réponse invalide (JSON attendu)', url, res.status, text);
  }
}
