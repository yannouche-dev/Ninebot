// Exécute le Worker dans Node (tests et mocks) : http -> Request -> worker.fetch -> Response.
import http from 'node:http';
import worker from './src/index.js';

export function startWorker({ port = 0, env }) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    const resp = await worker.fetch(request, env);
    const out = {};
    resp.headers.forEach((v, k) => (out[k] = v));
    res.writeHead(resp.status, out);
    res.end(Buffer.from(await resp.arrayBuffer()));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
