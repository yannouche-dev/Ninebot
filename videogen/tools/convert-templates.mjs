#!/usr/bin/env node
// Convertit les templates officiels ComfyUI (format UI, avec sous-graphes) en workflows au format API,
// en utilisant le frontend officiel (app.graphToPrompt = « Export (API) ») dans un Chromium headless.
//
// Prérequis : un ComfyUI de la MÊME version que celle installée sur l'instance (COMFY_VERSION dans
// instance/onstart.sh), lancé en local, par ex. `python main.py --cpu --port 8188`.
//
// Usage : COMFY=http://127.0.0.1:8188 TEMPLATES_DIR=<site-packages>/comfyui_workflow_templates_json/templates \
//         node tools/convert-templates.mjs [--placeholders]
//   --placeholders  crée des fichiers de poids vides (taille 0) dans COMFY_MODELS_DIR pour que les listes
//                   de fichiers des nœuds contiennent les bons noms (validation sans GPU ni téléchargement).
//
// Produit : web/public/workflows/<id>.json, instance/weights.json, tests/fixtures/object_info.json
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const COMFY = process.env.COMFY || 'http://127.0.0.1:8188';
const TEMPLATES_DIR = process.env.TEMPLATES_DIR;
const MODELS_DIR = process.env.COMFY_MODELS_DIR;

// id du workflow -> [fichier template officiel, famille de poids]
export const TEMPLATES = {
  'ltx25-t2v': ['video_ltx2_5_t2v.json', 'ltx25'],
  'ltx25-i2v': ['video_ltx2_5_i2v.json', 'ltx25'],
  'ltx25-flf2v': ['video_ltx2_5_flf2v.json', 'ltx25'],
  'wan22-t2v': ['video_wan2_2_14B_t2v.json', 'wan22'],
  'wan22-i2v': ['video_wan2_2_14B_i2v.json', 'wan22'],
  'hy15-t2v': ['video_hunyuan_video_1.5_720p_t2v.json', 'hunyuan15'],
  'hy15-i2v': ['video_hunyuan_video_1.5_720p_i2v.json', 'hunyuan15'],
};
const FAMILY_LABELS = { ltx25: 'LTX-2.5', wan22: 'Wan 2.2 (14B)', hunyuan15: 'HunyuanVideo 1.5 (720p)' };

function walkNodes(wf) {
  const out = [...(wf.nodes || [])];
  for (const sg of wf.definitions?.subgraphs || []) out.push(...(sg.nodes || []));
  return out;
}

function modelsOf(wf) {
  const seen = new Map();
  for (const n of walkNodes(wf)) {
    for (const m of n.properties?.models || []) {
      const u = new URL(m.url);
      const mm = u.pathname.match(/^\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/);
      if (!mm || u.hostname !== 'huggingface.co') throw new Error(`URL de modèle inattendue : ${m.url}`);
      seen.set(m.name, { repo: mm[1], path: decodeURIComponent(mm[3]), dir: m.directory, name: m.name });
    }
  }
  return [...seen.values()];
}

async function main() {
  if (!TEMPLATES_DIR) throw new Error('TEMPLATES_DIR manquant');
  const weights = { generated_by: 'tools/convert-templates.mjs', families: {} };
  const templates = {};
  for (const [id, [file, fam]] of Object.entries(TEMPLATES)) {
    const wf = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8'));
    templates[id] = wf;
    const famEntry = (weights.families[fam] ||= { label: FAMILY_LABELS[fam], files: [] });
    for (const m of modelsOf(wf)) {
      if (!famEntry.files.some((f) => f.name === m.name)) famEntry.files.push(m);
    }
  }

  if (process.argv.includes('--placeholders')) {
    if (!MODELS_DIR) throw new Error('COMFY_MODELS_DIR manquant');
    for (const fam of Object.values(weights.families)) {
      for (const f of fam.files) {
        const p = path.join(MODELS_DIR, f.dir, f.name);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        if (!fs.existsSync(p)) fs.writeFileSync(p, '');
      }
    }
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('dialog', (d) => d.dismiss());
  await page.goto(COMFY);
  await page.waitForFunction(() => window.app && window.app.graph && window.app.loadGraphData, null, { timeout: 120000 });
  fs.mkdirSync(path.join(ROOT, 'web/public/workflows'), { recursive: true });

  for (const [id, wf] of Object.entries(templates)) {
    const prompt = await page.evaluate(async (data) => {
      await window.app.loadGraphData(structuredClone(data), true, false, null);
      await new Promise((r) => setTimeout(r, 500));
      const res = await window.app.graphToPrompt();
      return res.output;
    }, wf);
    const nodes = Object.keys(prompt).length;
    if (!nodes) throw new Error(`${id} : conversion vide`);
    const file = path.join(ROOT, 'web/public/workflows', `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(prompt, null, 2) + '\n');
    console.log(`${id}: ${nodes} nœuds -> ${path.relative(ROOT, file)}`);
  }
  await browser.close();

  // Ne garder que les poids réellement référencés par les workflows API (les branches désactivées
  // des templates, ex. super-résolution 1080p de Hunyuan, ne sont pas exportées).
  const usedNames = new Set();
  for (const id of Object.keys(templates)) {
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/public/workflows', `${id}.json`), 'utf8'));
    for (const n of Object.values(p)) for (const v of Object.values(n.inputs)) if (typeof v === 'string') usedNames.add(v);
  }
  for (const fam of Object.values(weights.families)) fam.files = fam.files.filter((f) => usedNames.has(f.name));
  fs.writeFileSync(path.join(ROOT, 'instance/weights.json'), JSON.stringify(weights, null, 2) + '\n');
  console.log('instance/weights.json écrit');

  // Fixture /object_info restreinte aux nœuds utilisés (mock ComfyUI et tests).
  const info = await (await fetch(`${COMFY}/object_info`)).json();
  const used = new Set();
  for (const id of Object.keys(templates)) {
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/public/workflows', `${id}.json`), 'utf8'));
    for (const n of Object.values(p)) used.add(n.class_type);
  }
  const subset = Object.fromEntries([...used].sort().map((k) => [k, info[k]]).filter(([, v]) => v));
  fs.mkdirSync(path.join(ROOT, 'tests/fixtures'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'tests/fixtures/object_info.json'), JSON.stringify(subset) + '\n');
  console.log(`tests/fixtures/object_info.json : ${Object.keys(subset).length} nœuds`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
