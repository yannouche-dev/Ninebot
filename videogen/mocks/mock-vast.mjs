// Mock de l'API REST Vast.ai (routes utilisées par l'interface) + mock Hugging Face (whoami, auth-check).
// Simule le cycle de vie d'une instance et les logs publiés par instance/onstart.sh.
import http from 'node:http';

export const VALID_VAST_KEY = 'test-vast-key-0123456789abcdef';
export const VALID_HF_TOKEN = 'hf_TestToken0123456789abcdef';

const OFFERS = [
  { id: 501, gpu_name: 'RTX 5090', num_gpus: 1, gpu_ram: 32607, dph_total: 0.612, reliability: 0.995, reliability2: 0.995, inet_down: 850, inet_up: 600, disk_space: 400, geolocation: 'Norway, NO', cuda_max_good: 12.9, storage_cost: 0.15 },
  { id: 502, gpu_name: 'RTX PRO 6000 WS', num_gpus: 1, gpu_ram: 97887, dph_total: 1.204, reliability: 0.997, reliability2: 0.997, inet_down: 2100, inet_up: 1500, disk_space: 800, geolocation: 'France, FR', cuda_max_good: 13.0, storage_cost: 0.12 },
  { id: 503, gpu_name: 'RTX PRO 6000 S', num_gpus: 1, gpu_ram: 97887, dph_total: 1.051, reliability: 0.993, reliability2: 0.993, inet_down: 900, inet_up: 900, disk_space: 300, geolocation: 'Germany, DE', cuda_max_good: 12.9, storage_cost: 0.12 },
  { id: 504, gpu_name: 'RTX 4090', num_gpus: 1, gpu_ram: 24564, dph_total: 0.35, reliability: 0.999, reliability2: 0.999, inet_down: 900, disk_space: 300, geolocation: 'US', cuda_max_good: 12.8 },
  { id: 666, gpu_name: 'RTX PRO 6000 WS', num_gpus: 1, gpu_ram: 97887, dph_total: 0.99, reliability: 0.991, reliability2: 0.991, inet_down: 700, disk_space: 300, geolocation: 'Gone, XX', cuda_max_good: 12.9 },
];

function matches(o, q) {
  for (const [field, cond] of Object.entries(q)) {
    if (!cond || typeof cond !== 'object' || Array.isArray(cond) || !(field in o)) continue;
    const v = o[field];
    if ('eq' in cond && v !== cond.eq) return false;
    if ('in' in cond && !cond.in.includes(v)) return false;
    if ('gte' in cond && !(v >= cond.gte)) return false;
    if ('lte' in cond && !(v <= cond.lte)) return false;
  }
  return true;
}

export function createVastMock({ shared, origin, speed = 1 }) {
  const state = { instances: new Map(), nextId: 9001, creates: [], logs: new Map(), requests: [] };
  shared.vast = state;
  const T = (ms) => Math.max(10, Math.round(ms * speed));

  function bootLines(inst) {
    // Lignes publiées par onstart.sh/agent.py (voir instance/), suivies au fil du temps.
    const t = Date.now() - inst.bootAt;
    const lines = [`VIDEOGEN_BOOT=${Math.floor(inst.bootAt / 1000)}`, 'VIDEOGEN_STEP=tools:running'];
    if (t > T(400)) lines.push('VIDEOGEN_STEP=tools:done', 'VIDEOGEN_STEP=tunnel:running');
    if (t > T(1200)) lines.push(`VIDEOGEN_TUNNEL_URL=${shared.comfyUrl}`, 'VIDEOGEN_STEP=comfy_install:running');
    return lines;
  }

  function send(res, status, data, extra = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
    res.end(JSON.stringify(data));
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : null;
    state.requests.push({ method: req.method, path: url.pathname, auth: req.headers.authorization || '' });

    // --- Hugging Face (le navigateur l'appelle directement : CORS ouvert à l'origine de test)
    if (url.pathname.startsWith('/hf/')) {
      const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization', Vary: 'Origin' };
      if (req.method === 'OPTIONS') return res.writeHead(204, cors), res.end();
      const ok = req.headers.authorization === `Bearer ${VALID_HF_TOKEN}`;
      if (!ok) return send(res, 401, { error: 'Invalid credentials in Authorization header' }, cors);
      if (url.pathname === '/hf/api/whoami-v2') return send(res, 200, { type: 'user', name: 'testuser', auth: { accessToken: { displayName: 'videogen', role: 'fineGrained' } } }, cors);
      if (url.pathname === '/hf/api/models/Lightricks/LTX-2.5/auth-check') return send(res, 200, {}, cors);
      return send(res, 404, { error: 'not found' }, cors);
    }

    // --- Logs « S3 » (sans authentification, comme les URL renvoyées par Vast)
    const s3 = url.pathname.match(/^\/s3\/vast\.ai\/instance_logs\/(\d+)-\w+\.log$/);
    if (s3 && req.method === 'GET') {
      const key = url.pathname;
      const hits = (state.logs.get(key) ?? 0) + 1;
      state.logs.set(key, hits);
      if (hits === 1) return send(res, 404, { error: 'NoSuchKey' }); // pas encore prêt
      const inst = state.instances.get(Number(s3[1]));
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(inst && inst.actual_status === 'running' ? bootLines(inst).join('\n') + '\n' : '');
    }

    // --- Contrôle des tests
    if (url.pathname === '/__mock/state') {
      const c = shared.comfy?.state;
      return send(res, 200, { instances: [...state.instances.values()], creates: state.creates, requests: state.requests, comfy: c ? { deletions: c.deletions, views: c.views, uploads: [...c.uploads], prompts: c.prompts.length } : null });
    }
    if (url.pathname === '/__mock/reset' && req.method === 'POST') {
      state.instances.clear();
      state.creates = [];
      state.requests = [];
      shared.comfy?.reset();
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/__mock/seed-stopped' && req.method === 'POST') {
      // Instance du projet déjà existante et arrêtée (pour tester « redémarrer »).
      const id = state.nextId++;
      shared.comfyToken = body.token;
      state.instances.set(id, mkInstance(id, OFFERS[1], { COMFY_ACCESS_TOKEN: body.token, HF_TOKEN: VALID_HF_TOKEN }, 'stopped'));
      shared.comfy?.setInstalled(['ltx25']);
      shared.comfy?.markDownloaded(['ltx25']);
      return send(res, 200, { id });
    }

    // --- API Vast (authentifiée)
    if (req.headers.authorization !== `Bearer ${VALID_VAST_KEY}`) return send(res, 401, { success: false, error: 'invalid_user_key', msg: 'Invalid user key' });
    if (url.searchParams.has('api_key')) return send(res, 400, { error: 'api_key in query' });

    if (url.pathname === '/api/v0/users/current/' && req.method === 'GET') return send(res, 200, { id: 42, email: 'test@example.com', credit: 25.5, balance: 0 });

    if (url.pathname === '/api/v0/bundles/' && req.method === 'POST') {
      state.lastQuery = body;
      return send(res, 200, { offers: OFFERS.filter((o) => matches(o, body)) });
    }

    let m;
    if ((m = url.pathname.match(/^\/api\/v0\/asks\/(\d+)\/$/)) && req.method === 'PUT') {
      const offer = OFFERS.find((o) => o.id === Number(m[1]));
      if (!offer || offer.id === 666) return send(res, 410, { success: false, error: 'no_such_ask', msg: 'Instance type no longer available.' });
      const problems = [];
      if (!body.image || !body.disk || !body.label || !body.onstart) problems.push('missing fields');
      if (typeof body.env !== 'object' || Array.isArray(body.env)) problems.push('env must be an object');
      if (body.onstart.length > 4048) problems.push('onstart too long');
      for (const [k, v] of Object.entries(body.env || {})) {
        if (String(v).includes(';')) problems.push(`semicolon in ${k}`);
        if (String(v) === VALID_VAST_KEY || String(v).includes(VALID_VAST_KEY)) problems.push(`MAIN VAST KEY LEAKED in ${k}`);
      }
      if (body.onstart.includes(VALID_VAST_KEY)) problems.push('MAIN VAST KEY LEAKED in onstart');
      for (const k of ['HF_TOKEN', 'COMFY_ACCESS_TOKEN', 'ALLOWED_ORIGIN', 'IDLE_MINUTES', 'MAX_HOURS', 'MODELS']) if (!(k in (body.env || {}))) problems.push(`missing env ${k}`);
      if (problems.length) return send(res, 400, { success: false, error: 'invalid_args', msg: problems.join(', ') });
      const id = state.nextId++;
      state.creates.push({ offerId: offer.id, body, id });
      shared.comfyToken = body.env.COMFY_ACCESS_TOKEN;
      shared.comfy?.setInstalled(body.env.MODELS.split(','));
      const inst = mkInstance(id, offer, body.env, 'loading', body.label);
      state.instances.set(id, inst);
      setTimeout(() => startRunning(inst), T(800));
      return send(res, 200, { success: true, new_contract: id, instance_api_key: 'cak_' + 'f'.repeat(40) });
    }

    if (url.pathname === '/api/v0/instances/' && req.method === 'GET') return send(res, 200, { instances: [...state.instances.values()].map(view) });

    if ((m = url.pathname.match(/^\/api\/v0\/instances\/(\d+)\/$/))) {
      const inst = state.instances.get(Number(m[1]));
      if (!inst) return send(res, 404, { success: false, error: 'no_such_instance' });
      if (req.method === 'GET') return send(res, 200, { instances: view(inst) });
      if (req.method === 'DELETE') {
        state.instances.delete(inst.id);
        return send(res, 200, { success: true });
      }
      if (req.method === 'PUT') {
        if (body.label !== undefined) inst.label = body.label;
        if (body.state === 'stopped') {
          inst.intended_status = 'stopped';
          shared.comfy?.setDown(true);
          setTimeout(() => {
            inst.actual_status = 'stopped';
            inst.cur_state = 'stopped';
          }, T(500));
        }
        if (body.state === 'running') {
          inst.intended_status = 'running';
          inst.actual_status = 'loading';
          setTimeout(() => startRunning(inst), T(600));
        }
        return send(res, 200, { success: true });
      }
    }

    if ((m = url.pathname.match(/^\/api\/v0\/instances\/request_logs\/(\d+)\/$/)) && req.method === 'PUT') {
      const inst = state.instances.get(Number(m[1]));
      if (!inst) return send(res, 404, { success: false, error: 'no_such_instance' });
      const key = Math.random().toString(36).slice(2, 10);
      return send(res, 200, { success: true, result_url: `${shared.vastUrl}/s3/vast.ai/instance_logs/${inst.id}-${key}.log`, msg: 'logs requested' });
    }

    return send(res, 404, { error: 'mock: route inconnue', path: url.pathname });
  });

  function mkInstance(id, offer, env, status, label = 'videogen') {
    return {
      id,
      label,
      actual_status: status,
      intended_status: status === 'stopped' ? 'stopped' : 'running',
      cur_state: status === 'stopped' ? 'stopped' : 'running',
      status_msg: status === 'loading' ? 'Pulling image…' : '',
      gpu_name: offer.gpu_name,
      num_gpus: 1,
      dph_total: offer.dph_total,
      disk_space: 150,
      storage_cost: 0.12,
      geolocation: offer.geolocation,
      extra_env: Object.entries(env),
      start_date: Date.now() / 1000,
      bootAt: 0,
    };
  }
  function startRunning(inst) {
    if (inst.intended_status !== 'running' || !state.instances.has(inst.id)) return;
    inst.actual_status = 'running';
    inst.cur_state = 'running';
    inst.status_msg = '';
    inst.bootAt = Date.now();
    shared.comfy?.boot();
  }
  function view(inst) {
    const { bootAt, ...rest } = inst;
    return { ...rest, uptime_mins: inst.actual_status === 'running' && bootAt ? (Date.now() - bootAt) / 60000 : null };
  }

  return server;
}
