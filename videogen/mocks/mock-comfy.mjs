// Mock de l'instance : Caddy (jeton + CORS) devant ComfyUI (/prompt, /ws, /history, /view, /upload/image,
// /object_info, /interrupt, /queue, /system_stats) et l'agent videogen (/videogen/status, /log, /files/delete).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const OBJECT_INFO = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/object_info.json'), 'utf8'));
const WEIGHTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'instance/weights.json'), 'utf8'));
const FIXTURES = {
  a: fs.readFileSync(path.join(HERE, 'fixtures/a.mp4')),
  b: fs.readFileSync(path.join(HERE, 'fixtures/b.mp4')),
  c: fs.readFileSync(path.join(HERE, 'fixtures/c.mp4')),
};
const PREVIEW = fs.readFileSync(path.join(HERE, 'fixtures/preview.jpg'));

export function createComfyMock({ shared, origin, speed = 1 }) {
  const T = (ms) => Math.max(5, Math.round(ms * speed));
  const st = {
    installed: ['ltx25'],
    downloaded: new Set(),
    bootAt: 0,
    down: false,
    uploads: new Set(),
    history: {},
    running: null,
    pending: [],
    deletions: [],
    views: [],
    prompts: [],
    outputCount: 0,
  };
  const sockets = new Map(); // clientId -> Set<ws>

  const api = {
    reset() {
      Object.assign(st, { installed: ['ltx25'], downloaded: new Set(), bootAt: 0, down: false, uploads: new Set(), history: {}, running: null, pending: [], deletions: [], views: [], prompts: [], outputCount: 0 });
    },
    setInstalled(fams) {
      st.installed = fams;
    },
    markDownloaded(fams) {
      for (const f of filesFor(fams)) st.downloaded.add(f.name);
    },
    setDown(v) {
      st.down = v;
    },
    boot() {
      st.bootAt = Date.now();
      st.down = false;
    },
    state: st,
  };
  shared.comfy = api;

  function filesFor(fams) {
    return fams.flatMap((f) => WEIGHTS.families[f]?.files ?? []);
  }

  function agentStatus() {
    const t = Date.now() - st.bootAt;
    const done = (s) => ({ state: 'done', msg: '', ts: Date.now() / 1000 });
    const run = () => ({ state: 'running', msg: '' });
    const pend = { state: 'pending' };
    const files = filesFor(st.installed);
    const already = files.every((f) => st.downloaded.has(f.name));
    const dlStart = T(2000);
    const dlDur = already ? 0 : T(2500);
    const frac = Math.max(0, Math.min(1, (t - dlStart) / Math.max(1, dlDur)));
    const total = files.length * 1e9;
    if (frac >= 1) files.forEach((f) => st.downloaded.add(f.name));
    const steps = {
      tools: done(),
      tunnel: done(),
      comfy_install: t > T(1200) ? done() : run(),
      comfy_start: t > T(1800) ? done() : t > T(1200) ? run() : pend,
      models: t < dlStart ? pend : frac < 1 ? run() : done(),
      ready: frac >= 1 && t > dlStart ? done() : pend,
    };
    return {
      version: 1,
      now: Date.now() / 1000,
      steps,
      models: t < dlStart ? null : {
        state: frac >= 1 ? 'done' : 'running',
        families: st.installed,
        total_bytes: total,
        done_bytes: Math.round(total * frac),
        error: null,
        files: files.map((f, i) => ({ family: '', repo: f.repo, name: f.name, size: 1e9, done: Math.round(1e9 * Math.min(1, Math.max(0, frac * files.length - i))), state: frac >= 1 ? 'done' : 'downloading', error: null })),
      },
      tunnel_url: shared.comfyUrl,
      comfy_ready: t > T(1800),
      comfy_version: 'v0.44.2',
      watchdog: { idle_minutes: 20, max_hours: 4, boot_ts: st.bootAt / 1000, idle_since: Date.now() / 1000, stop_at: Date.now() / 1000 + 1200, triggered: false, reason: null },
      disk: { free_bytes: 80e9, total_bytes: 150e9 },
    };
  }

  function objectInfo() {
    // Ne liste dans les combos que les poids des familles installées (comme le vrai /object_info).
    const allowed = new Set(filesFor(st.installed).map((f) => f.name));
    const all = new Set(Object.values(WEIGHTS.families).flatMap((f) => f.files.map((x) => x.name)));
    const out = structuredClone(OBJECT_INFO);
    for (const def of Object.values(out)) {
      for (const group of [def.input.required ?? {}, def.input.optional ?? {}]) {
        for (const spec of Object.values(group)) {
          if (Array.isArray(spec[0])) spec[0] = spec[0].filter((v) => !all.has(v) || allowed.has(v));
        }
      }
    }
    return out;
  }

  const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Cache-Control': 'no-store' };
  function send(res, status, data, type = 'application/json') {
    res.writeHead(status, { 'Content-Type': type, ...cors });
    res.end(type === 'application/json' ? JSON.stringify(data) : data);
  }
  function authed(req, url) {
    const tok = shared.comfyToken;
    return !!tok && (req.headers.authorization === `Bearer ${tok}` || url.searchParams.get('token') === tok);
  }
  function emit(clientId, msg) {
    for (const ws of sockets.get(clientId) ?? []) if (ws.readyState === 1) ws.send(typeof msg === 'string' || Buffer.isBuffer(msg) ? msg : JSON.stringify(msg));
  }

  function textOf(prompt) {
    return Object.values(prompt)
      .flatMap((n) => [n.inputs.value, n.inputs.text])
      .filter((v) => typeof v === 'string')
      .join(' ');
  }

  function validate(prompt) {
    const info = objectInfo();
    for (const [id, n] of Object.entries(prompt)) {
      if (!info[n.class_type]) return { error: { type: 'missing_node_type', message: `Node '${n.class_type}' not found. The custom node may not be installed.` }, node_errors: {} };
      for (const [name, v] of Object.entries(n.inputs)) {
        if (typeof v !== 'string') continue;
        if (n.class_type === 'LoadImage' && name === 'image') {
          if (!st.uploads.has(v)) return { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' }, node_errors: { [id]: { errors: [{ type: 'custom_validation_failed', message: 'Invalid image file', details: `image - Invalid image file: ${v}` }], class_type: 'LoadImage' } } };
          continue;
        }
        const spec = info[n.class_type].input.required?.[name] ?? info[n.class_type].input.optional?.[name];
        if (spec && Array.isArray(spec[0]) && /\.safetensors$/.test(v) && !spec[0].includes(v)) {
          return { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' }, node_errors: { [id]: { errors: [{ type: 'value_not_in_list', message: 'Value not in list', details: `${name}: '${v}' not in [...]`, extra_info: { input_name: name, received_value: v } }], class_type: n.class_type } } };
        }
      }
    }
    return null;
  }

  function execute(job) {
    const { id, clientId, prompt } = job;
    st.running = job;
    const text = textOf(prompt);
    const slow = text.includes('#slow');
    const oom = text.includes('#oom');
    const save = Object.entries(prompt).find(([, n]) => n.class_type === 'SaveVideo');
    const samplers = Object.entries(prompt).filter(([, n]) => /Sampler/.test(n.class_type) && !/Select/.test(n.class_type)).map(([k]) => k);
    const steps = slow ? 40 : 6;
    const tick = T(slow ? 300 : 60);
    const audio = Object.values(prompt).some((n) => n.class_type === 'LTXVAudioVAEDecode');
    const timers = [];
    job.timers = timers;
    let t = T(50);
    const at = (fn) => timers.push(setTimeout(fn, (t += tick)));
    at(() => emit(clientId, { type: 'execution_start', data: { prompt_id: id, timestamp: Date.now() } }));
    at(() => emit(clientId, { type: 'execution_cached', data: { nodes: [], prompt_id: id, timestamp: Date.now() } }));
    for (const s of samplers.length ? samplers : ['1']) {
      at(() => emit(clientId, { type: 'executing', data: { node: s, display_node: s, prompt_id: id } }));
      for (let i = 1; i <= steps; i++) {
        at(() => emit(clientId, { type: 'progress', data: { value: i, max: steps, prompt_id: id, node: s } }));
        if (i === 3) {
          at(() => {
            const head = Buffer.alloc(8);
            head.writeUInt32BE(1, 0);
            head.writeUInt32BE(1, 4);
            emit(clientId, Buffer.concat([head, PREVIEW]));
          });
        }
        if (oom && i === 2) {
          at(() => {
            const err = { prompt_id: id, node_id: s, node_type: prompt[s]?.class_type ?? 'SamplerCustomAdvanced', executed: [], exception_message: 'CUDA out of memory. Tried to allocate 12.00 GiB. GPU 0 has a total capacity of 31.36 GiB', exception_type: 'torch.OutOfMemoryError', traceback: ['...'], current_inputs: {}, current_outputs: {}, timestamp: Date.now() };
            st.history[id] = { prompt: [0, id, prompt, {}, []], outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_error', err]] } };
            emit(clientId, { type: 'execution_error', data: err });
            st.running = null;
            for (const x of timers) clearTimeout(x);
            next();
          });
          return;
        }
      }
    }
    at(() => {
      const fixture = audio ? (st.outputCount % 2 ? 'b' : 'a') : 'c';
      st.outputCount++;
      const prefix = String(save?.[1].inputs.filename_prefix ?? 'videogen/out');
      const [sub, base] = prefix.includes('/') ? [prefix.split('/')[0], prefix.split('/').slice(1).join('/')] : ['', prefix];
      const filename = `${base}_${String(st.outputCount).padStart(5, '0')}_${fixture}.mp4`;
      const out = { images: [{ filename, subfolder: sub, type: 'output' }], animated: [true] };
      st.history[id] = { prompt: [0, id, prompt, {}, []], outputs: { [save?.[0] ?? '1']: out }, status: { status_str: 'success', completed: true, messages: [['execution_success', { prompt_id: id }]] } };
      emit(clientId, { type: 'executed', data: { node: save?.[0], display_node: save?.[0], output: out, prompt_id: id } });
      emit(clientId, { type: 'execution_success', data: { prompt_id: id, timestamp: Date.now() } });
      emit(clientId, { type: 'executing', data: { node: null, prompt_id: id } });
      st.running = null;
      next();
    });
  }
  function next() {
    const job = st.pending.shift();
    if (job) execute(job);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (st.down || !st.bootAt) return req.socket.destroy();
    if (req.method === 'OPTIONS') {
      res.writeHead(req.headers.origin === origin ? 204 : 401, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' });
      return res.end();
    }
    if (!authed(req, url)) return send(res, 401, 'unauthorized', 'text/plain');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const json = () => JSON.parse(raw.toString() || '{}');
    const p = url.pathname;
    const comfyUp = Date.now() - st.bootAt > T(1800);

    if (p === '/videogen/status') return send(res, 200, agentStatus());
    if (p === '/videogen/log') return send(res, 200, { lines: ['2026-11-08T10:00:00Z VIDEOGEN_BOOT=1', 'Python : /venv/main/bin/python (2.10.0 12.8)', 'HF_TOKEN=hf_…cdef (masqué)'] });
    if (p === '/videogen/files/delete' && req.method === 'POST') {
      const files = json().files ?? [];
      st.deletions.push(...files);
      return send(res, 200, { deleted: files.map((f) => f.filename), missing: [], refused: [] });
    }
    if (!comfyUp) return send(res, 502, 'Bad Gateway', 'text/plain');

    if (p === '/system_stats') return send(res, 200, { system: { comfyui_version: '0.44.2' }, devices: [{ name: 'cuda:0 NVIDIA RTX PRO 6000', vram_total: 96e9, vram_free: 90e9 }] });
    if (p === '/object_info') return send(res, 200, objectInfo());
    if (p === '/queue' && req.method === 'GET') return send(res, 200, { queue_running: st.running ? [[0, st.running.id]] : [], queue_pending: st.pending.map((j, i) => [i + 1, j.id]) });
    if (p === '/queue' && req.method === 'POST') {
      const del = json().delete ?? [];
      st.pending = st.pending.filter((j) => !del.includes(j.id));
      return send(res, 200, {});
    }
    if (p === '/interrupt' && req.method === 'POST') {
      const pid = json().prompt_id;
      const job = st.running;
      if (job && (!pid || pid === job.id)) {
        for (const x of job.timers ?? []) clearTimeout(x);
        st.running = null;
        st.history[job.id] = { prompt: [0, job.id, job.prompt, {}, []], outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_interrupted', { prompt_id: job.id }]] } };
        emit(job.clientId, { type: 'execution_interrupted', data: { prompt_id: job.id, node_id: '1', node_type: 'KSampler', executed: [] } });
        next();
      }
      return send(res, 200, {});
    }
    if (p === '/upload/image' && req.method === 'POST') {
      const text = raw.toString('latin1');
      const name = text.match(/filename="([^"]+)"/)?.[1] ?? 'image.png';
      const sub = text.match(/name="subfolder"\r\n\r\n([^\r]*)/)?.[1] ?? '';
      st.uploads.add(sub ? `${sub}/${name}` : name);
      return send(res, 200, { name, subfolder: sub, type: 'input' });
    }
    if (p === '/prompt' && req.method === 'POST') {
      const body = json();
      st.prompts.push(body);
      if (textOf(body.prompt).includes('#missing')) {
        return send(res, 400, { error: { type: 'missing_node_type', message: "Node 'LTXVMagicNode' not found. The custom node may not be installed.", details: 'Node ID #77' }, node_errors: {} });
      }
      const invalid = validate(body.prompt);
      if (invalid) return send(res, 400, invalid);
      const id = crypto.randomUUID();
      const job = { id, clientId: body.client_id, prompt: body.prompt };
      if (st.running) st.pending.push(job);
      else setTimeout(() => execute(job), T(30));
      return send(res, 200, { prompt_id: id, number: st.prompts.length, node_errors: {} });
    }
    let m;
    if ((m = p.match(/^\/history\/(.+)$/))) {
      const h = st.history[decodeURIComponent(m[1])];
      return send(res, 200, h ? { [m[1]]: h } : {});
    }
    if (p === '/view') {
      const fn = url.searchParams.get('filename') ?? '';
      st.views.push(fn);
      const key = fn.match(/_([abc])\.mp4$/)?.[1];
      if (!key) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': 'video/mp4', ...cors });
      return res.end(FIXTURES[key]);
    }
    return send(res, 404, { error: 'mock: route inconnue', path: p });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (st.down || url.pathname !== '/ws' || !authed(req, url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const cid = url.searchParams.get('clientId') ?? 'anon';
      if (!sockets.has(cid)) sockets.set(cid, new Set());
      sockets.get(cid).add(ws);
      ws.send(JSON.stringify({ type: 'status', data: { status: { exec_info: { queue_remaining: st.pending.length + (st.running ? 1 : 0) } }, sid: cid } }));
      ws.on('close', () => sockets.get(cid)?.delete(ws));
    });
  });
  return server;
}
