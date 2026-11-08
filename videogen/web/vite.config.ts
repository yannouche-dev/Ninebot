// Configuration de build de l'interface.
// - CSP stricte injectée dans index.html (GitHub Pages ne permet pas d'en-têtes HTTP personnalisés).
// - Empreintes SHA-256 des scripts de l'instance intégrées au build : l'amorce « onstart » les vérifie
//   avant d'exécuter quoi que ce soit.
// - ffmpeg.wasm copié depuis node_modules (versions figées par package-lock) : servi par Pages, pas par un CDN.
import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TEST = process.env.VIDEOGEN_TEST_BUILD === '1';
export const INSTANCE_FILES = ['onstart.sh', 'agent.py', 'Caddyfile', 'weights.json'];

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || TEST ? u.origin : null;
  } catch {
    return null;
  }
}

export function buildCsp(opts: { test: boolean; proxyOrigin: string | null }): string {
  const connect = ["'self'"];
  connect.push(opts.proxyOrigin ?? 'https://*.workers.dev');
  connect.push('https://huggingface.co', 'https://*.trycloudflare.com', 'wss://*.trycloudflare.com');
  if (opts.test) connect.push('http://127.0.0.1:*', 'ws://127.0.0.1:*');
  return [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self'",
    `connect-src ${connect.join(' ')}`,
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "style-src 'self'",
    "font-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

function videogenPlugin(): Plugin {
  const proxyOrigin = originOf(process.env.VAST_PROXY_URL);
  return {
    name: 'videogen',
    configResolved() {
      // Copie de ffmpeg.wasm (ESM) dans public/vendor, servi depuis notre propre origine.
      const vendor = path.join(ROOT, 'web/public/vendor');
      const pairs: [string, string][] = [];
      const esm = path.join(ROOT, 'node_modules/@ffmpeg/ffmpeg/dist/esm');
      for (const f of fs.readdirSync(esm)) if (f.endsWith('.js')) pairs.push([path.join(esm, f), path.join(vendor, 'ffmpeg', f)]);
      const core = path.join(ROOT, 'node_modules/@ffmpeg/core/dist/esm');
      for (const f of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) pairs.push([path.join(core, f), path.join(vendor, 'ffmpeg-core', f)]);
      for (const [from, to] of pairs) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        if (!fs.existsSync(to) || fs.statSync(to).size !== fs.statSync(from).size) fs.copyFileSync(from, to);
      }
    },
    transformIndexHtml(html) {
      return html.replace('%CSP%', buildCsp({ test: TEST, proxyOrigin }));
    },
  };
}

const instanceHashes = Object.fromEntries(INSTANCE_FILES.map((f) => [f, sha256(path.join(ROOT, 'instance', f))]));

export default defineConfig({
  root: path.join(ROOT, 'web'),
  base: './',
  publicDir: path.join(ROOT, 'web/public'),
  plugins: [videogenPlugin()],
  define: {
    __BUILD__: JSON.stringify({
      test: TEST,
      repo: process.env.GITHUB_REPOSITORY || process.env.VIDEOGEN_REPO || 'OWNER/REPO',
      ref: process.env.GITHUB_SHA || process.env.VIDEOGEN_REF || 'main',
      instanceBase: process.env.VIDEOGEN_INSTANCE_BASE || '',
      instanceFiles: instanceHashes,
      proxyUrl: process.env.VAST_PROXY_URL || '',
      hfBase: process.env.VIDEOGEN_HF_BASE || 'https://huggingface.co',
      builtAt: new Date().toISOString(),
    }),
  },
  build: {
    outDir: path.join(ROOT, process.env.VIDEOGEN_OUT_DIR || (TEST ? 'dist-test' : 'dist')),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 4173 },
});
