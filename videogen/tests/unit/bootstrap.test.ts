// Exécute réellement l'amorce « onstart » générée par l'interface (bash, curl, sha256sum) contre un
// serveur local qui sert des scripts factices : vérifie le téléchargement, le contrôle SHA-256 et le
// refus d'un fichier modifié.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
import { buildOnstart } from '../../web/src/vast/onstart.ts';

const files: Record<string, string> = {
  'onstart.sh': '#!/bin/bash\necho "stub ok" > "$VG_HOME/marker"\n',
  'agent.py': 'print("agent")\n',
  Caddyfile: ':8080 {}\n',
  'weights.json': '{"families":{}}\n',
};
let served = { ...files };
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const name = (req.url ?? '').split('/').pop()!;
    if (!(name in served)) return res.writeHead(404).end();
    res.writeHead(200).end(served[name]);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/instance`;
});
afterAll(() => server.close());

function script() {
  const hashes = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, createHash('sha256').update(v).digest('hex')]));
  return buildOnstart({ test: true, repo: 'o/r', ref: 'abc', instanceBase: base, instanceFiles: hashes, proxyUrl: '', hfBase: '', builtAt: '' });
}

// Asynchrone : le serveur de test tourne dans ce même processus (execFileSync le bloquerait).
async function run(home: string) {
  const sh = path.join(home, 'boot.sh');
  fs.writeFileSync(sh, script());
  return (await execFileP('bash', [sh], { env: { ...process.env, VG_HOME: home }, encoding: 'utf8', timeout: 30000 })).stdout;
}

describe('amorce onstart', () => {
  it('télécharge, vérifie les empreintes et lance onstart.sh', async () => {
    served = { ...files };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-'));
    await run(home);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(home, 'marker')); i++) await new Promise((r) => setTimeout(r, 100));
    expect(fs.readFileSync(path.join(home, 'marker'), 'utf8')).toBe('stub ok\n');
    for (const f of Object.keys(files)) expect(fs.readFileSync(path.join(home, 'src', f), 'utf8')).toBe(files[f]);
  });

  it('refuse un fichier modifié (empreinte différente) et n’exécute rien', async () => {
    served = { ...files, 'onstart.sh': '#!/bin/bash\necho pirate > "$VG_HOME/marker"\n' };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-'));
    let out = '';
    try {
      await run(home);
    } catch (e) {
      out = String((e as { stdout?: string }).stdout ?? '');
    }
    expect(out).toContain('VIDEOGEN_STEP=tools:error empreinte SHA-256 invalide');
    expect(fs.existsSync(path.join(home, 'marker'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'src', 'onstart.sh'))).toBe(false);
  });
});
