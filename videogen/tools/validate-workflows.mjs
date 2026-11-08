#!/usr/bin/env node
// Valide les requêtes /prompt construites par l'interface (models.json + workflows) contre un VRAI ComfyUI
// de la version installée sur l'instance (ex. lancé en local avec --cpu et des fichiers de poids vides).
// Pour chaque modèle et plusieurs combinaisons d'options, POST /prompt doit répondre sans node_errors.
// La file est vidée et l'exécution interrompue juste après (aucun calcul réel n'est nécessaire).
//
// Usage : COMFY=http://127.0.0.1:8188 node tools/validate-workflows.mjs
import fs from 'node:fs';
import path from 'node:path';
import { buildPrompt, checkAvailability } from '../web/src/workflows/build.ts';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const COMFY = process.env.COMFY || 'http://127.0.0.1:8188';
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/public/models.json'), 'utf8'));

async function upload(name) {
  // PNG 1x1 valide
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData();
  fd.append('image', new Blob([png], { type: 'image/png' }), name);
  fd.append('subfolder', 'videogen');
  fd.append('type', 'input');
  fd.append('overwrite', 'true');
  const r = await fetch(`${COMFY}/upload/image`, { method: 'POST', body: fd });
  const j = await r.json();
  return `${j.subfolder}/${j.name}`;
}

const info = await (await fetch(`${COMFY}/object_info`)).json();
const start = await upload('vg_validate_start.png');
const end = await upload('vg_validate_end.png');
let failures = 0;

for (const model of reg.models) {
  const wf = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/public', model.workflow), 'utf8'));
  const av = checkAvailability(wf, info, model);
  if (!av.ok) {
    console.log(`✗ ${model.id} indisponible`, av);
    failures++;
    continue;
  }
  const variants = [];
  for (const preset of model.resolution.presets) {
    for (const ratio of Object.keys(reg.ratios)) {
      variants.push({ preset, ratio, duration: model.duration.default, fps: model.fps.default });
    }
  }
  variants.push({ preset: model.resolution.default, ratio: '16:9', duration: model.duration.max, fps: model.fps.options.at(-1), fast: true, enhancePrompt: true, steps: 8, cfg: 2.5 });
  variants.push({ preset: model.resolution.default, ratio: '9:16', duration: model.duration.min, fps: model.fps.options[0], steps: 30, cfg: 4 });
  for (const v of variants) {
    const g = {
      prompt: 'Un chat roux traverse une rue pavée sous la pluie, plan large cinématographique',
      negative: 'flou, basse qualité',
      seed: 123456789,
      startImage: start,
      endImage: end,
      outputPrefix: `videogen/validate_${model.id}`,
      ...v,
    };
    const prompt = buildPrompt(reg, model, wf, g);
    const r = await fetch(`${COMFY}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: 'videogen-validate' }),
    });
    const body = await r.json();
    const ok = r.ok && Object.keys(body.node_errors || {}).length === 0;
    if (!ok) failures++;
    console.log(`${ok ? '✓' : '✗'} ${model.id} ${v.preset} ${v.ratio} ${v.duration}s ${v.fps}fps${v.fast ? ' fast' : ''}`, ok ? '' : JSON.stringify(body).slice(0, 800));
    await fetch(`${COMFY}/queue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clear: true }) });
    await fetch(`${COMFY}/interrupt`, { method: 'POST' });
  }
}
console.log(failures ? `${failures} échec(s)` : 'Toutes les requêtes sont valides.');
process.exit(failures ? 1 : 0);
