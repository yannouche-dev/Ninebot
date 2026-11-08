// Proxy Vast.ai sans état pour l'interface videogen (Cloudflare Worker).
//
// L'API REST de Vast.ai n'envoie pas d'en-têtes CORS : un navigateur ne peut donc pas l'appeler
// directement depuis GitHub Pages. Ce Worker relaie UNIQUEMENT les routes nécessaires à l'interface,
// n'accepte que l'origine configurée (ALLOWED_ORIGIN), ne journalise rien et ne stocke rien.
// La clé API voyage dans l'en-tête Authorization de chaque requête ; elle n'est jamais conservée.
//
// Variables (wrangler.jsonc / --var) :
//   ALLOWED_ORIGIN    origine de l'interface, ex. https://utilisateur.github.io (obligatoire)
//   VAST_BASE         (tests uniquement) remplace https://console.vast.ai
//   LOG_URL_PREFIXES  (tests uniquement) préfixes d'URL de logs autorisés, séparés par des virgules

const DEFAULT_VAST_BASE = 'https://console.vast.ai';
const DEFAULT_LOG_PREFIXES = ['https://s3.amazonaws.com/vast.ai/instance_logs/'];
const MAX_BODY = 64 * 1024;

/** Routes Vast autorisées : [méthode, motif du chemin]. */
export const ROUTES = [
  ['POST', /^\/api\/v0\/bundles\/$/], // recherche d'offres
  ['PUT', /^\/api\/v0\/asks\/\d{1,12}\/$/], // création d'une instance depuis une offre
  ['GET', /^\/api\/v0\/instances\/$/], // liste de mes instances
  ['GET', /^\/api\/v0\/instances\/\d{1,12}\/$/], // détail d'une instance
  ['PUT', /^\/api\/v0\/instances\/\d{1,12}\/$/], // démarrer / arrêter / label
  ['DELETE', /^\/api\/v0\/instances\/\d{1,12}\/$/], // détruire
  ['PUT', /^\/api\/v0\/instances\/request_logs\/\d{1,12}\/$/], // demander les logs
  ['GET', /^\/api\/v0\/users\/current\/$/], // compte et crédit
];
const ALLOWED_QUERY = new Set(['owner']);

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function json(status, data, origin) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (origin) Object.assign(headers, corsHeaders(origin));
  return new Response(JSON.stringify(data), { status, headers });
}

function routeAllowed(method, pathname) {
  return ROUTES.some(([m, re]) => m === method && re.test(pathname));
}

function logUrlAllowed(raw, prefixes) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password || u.hash) return false;
  const s = u.origin + u.pathname;
  return prefixes.some((p) => s.startsWith(p) && /^[A-Za-z0-9._/-]+$/.test(s.slice(p.length)) && !s.includes('..'));
}

async function relay(upstreamUrl, init, origin) {
  let resp;
  try {
    resp = await fetch(upstreamUrl, { ...init, redirect: 'manual' });
  } catch {
    return json(502, { error: 'upstream_unreachable', msg: 'API Vast injoignable depuis le proxy' }, origin);
  }
  const headers = new Headers();
  for (const h of ['Content-Type', 'Retry-After', 'X-RateLimit-Reset']) {
    const v = resp.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, headers });
}

export default {
  async fetch(request, env) {
    const allowed = (env.ALLOWED_ORIGIN || '').trim();
    const origin = request.headers.get('Origin');
    if (!allowed || origin !== allowed) {
      return json(403, { error: 'origin_not_allowed' });
    }
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(allowed) });
    }

    // Lecture des logs d'instance : Vast renvoie une URL S3 (sans CORS) que l'on relaie, sans clé.
    if (url.pathname === '/logs' && request.method === 'GET') {
      const target = url.searchParams.get('url') || '';
      const prefixes = (env.LOG_URL_PREFIXES ? env.LOG_URL_PREFIXES.split(',') : DEFAULT_LOG_PREFIXES).map((s) => s.trim());
      if (!logUrlAllowed(target, prefixes)) return json(400, { error: 'log_url_not_allowed' }, allowed);
      return relay(target, { method: 'GET' }, allowed);
    }

    if (!routeAllowed(request.method, url.pathname)) {
      return json(404, { error: 'route_not_allowed' }, allowed);
    }
    for (const k of url.searchParams.keys()) {
      if (!ALLOWED_QUERY.has(k)) return json(400, { error: 'query_not_allowed', param: k }, allowed);
    }
    const auth = request.headers.get('Authorization') || '';
    if (!/^Bearer [A-Za-z0-9._~+/=-]{8,200}$/.test(auth)) {
      return json(401, { error: 'missing_api_key' }, allowed);
    }

    let body = null;
    if (request.method === 'POST' || request.method === 'PUT') {
      const buf = await request.arrayBuffer();
      if (buf.byteLength > MAX_BODY) return json(413, { error: 'body_too_large' }, allowed);
      body = buf;
    }
    const base = env.VAST_BASE || DEFAULT_VAST_BASE;
    const headers = { Authorization: auth, Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    return relay(base + url.pathname + url.search, { method: request.method, headers, body }, allowed);
  },
};
