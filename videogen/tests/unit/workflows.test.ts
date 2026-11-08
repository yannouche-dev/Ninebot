import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildPrompt, checkAvailability, computeSize, frameCount, findVideoOutputs, type ApiPrompt, type Registry } from '../../web/src/workflows/build.ts';
import { explainExecutionError, explainPromptRejection } from '../../web/src/comfy/errors.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/public/models.json'), 'utf8')) as Registry;
const info = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/object_info.json'), 'utf8'));
const weights = JSON.parse(fs.readFileSync(path.join(ROOT, 'instance/weights.json'), 'utf8'));
const wf = (file: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'web/public', file), 'utf8')) as ApiPrompt;

describe('models.json ↔ workflows officiels convertis', () => {
  for (const m of reg.models) {
    it(`${m.id} : toutes les cibles existent dans le workflow`, () => {
      const w = wf(m.workflow);
      const targets = [
        ...m.output,
        ...(m.duration.targets ?? []),
        ...(m.duration.frames ?? []),
        ...m.fps.targets,
        ...Object.values(m.params).flatMap((p) => [...(p?.targets ?? []), ...((p as { half?: [] })?.half ?? [])]),
      ];
      for (const t of targets) {
        expect(w[t.node], `${m.id} nœud ${t.node}`).toBeDefined();
        expect(t.input in w[t.node].inputs, `${m.id} ${t.node}.${t.input}`).toBe(true);
      }
      expect(checkAvailability(w, info, m).ok).toBe(true);
    });
  }

  it('chaque poids des workflows est listé dans instance/weights.json', () => {
    const names = new Set(Object.values(weights.families as Record<string, { files: { name: string }[] }>).flatMap((f) => f.files.map((x) => x.name)));
    for (const m of reg.models) {
      for (const n of Object.values(wf(m.workflow))) {
        for (const v of Object.values(n.inputs)) if (typeof v === 'string' && v.endsWith('.safetensors')) expect(names.has(v), v).toBe(true);
      }
    }
  });
});

describe('construction des requêtes', () => {
  const ltx = reg.models.find((m) => m.id === 'ltx25-t2v')!;
  it('tailles arrondies au multiple du modèle', () => {
    expect(computeSize(reg, ltx, '720p', '16:9')).toEqual({ width: 1280, height: 704 });
    expect(computeSize(reg, ltx, '720p', '9:16')).toEqual({ width: 704, height: 1280 });
    expect(computeSize(reg, ltx, '720p', '1:1')).toEqual({ width: 960, height: 960 });
    const wan = reg.models.find((m) => m.id === 'wan22-t2v')!;
    expect(computeSize(reg, wan, '720p', '16:9')).toEqual({ width: 1280, height: 720 });
    expect(computeSize(reg, wan, '480p', '16:9')).toEqual({ width: 848, height: 480 });
  });
  it('images = durée × fps + 1 (4n+1 pour Wan/Hunyuan)', () => {
    expect(frameCount(5, 24)).toBe(121);
    expect(frameCount(5, 16)).toBe(81);
  });
  it('applique prompt, seed, taille, durée sans modifier le workflow source', () => {
    const src = wf(ltx.workflow);
    const before = JSON.stringify(src);
    const p = buildPrompt(reg, ltx, src, { prompt: 'un renard', preset: '720p', ratio: '16:9', duration: 3, fps: 25, seed: 42, outputPrefix: 'videogen/x', enhancePrompt: true });
    expect(JSON.stringify(src)).toBe(before);
    expect(p['405:376'].inputs.value).toBe('un renard');
    expect(p['405:372'].inputs.value).toBe(1280);
    expect(p['405:360'].inputs.value).toBe(704);
    expect(p['405:362'].inputs.value).toBe(3);
    expect(p['405:361'].inputs.value).toBe(25);
    expect(p['405:339'].inputs.noise_seed).toBe(42);
    expect(p['405:338'].inputs.noise_seed).toBe(42);
    expect(p['405:383'].inputs.value).toBe(true);
    expect(p['75'].inputs.filename_prefix).toBe('videogen/x');
  });
  it('Wan : steps et split, mode rapide', () => {
    const wan = reg.models.find((m) => m.id === 'wan22-t2v')!;
    const p = buildPrompt(reg, wan, wf(wan.workflow), { prompt: 'x', preset: '480p', ratio: '1:1', duration: 4, fps: 16, seed: 1, steps: 30, cfg: 4, outputPrefix: 'p' });
    expect(p['128:114'].inputs.value).toBe(30);
    expect(p['128:115'].inputs.value).toBe(15);
    expect(p['128:116'].inputs.value).toBe(4);
    expect(p['128:129'].inputs.value).toBe(false);
    const fast = buildPrompt(reg, wan, wf(wan.workflow), { prompt: 'x', preset: '480p', ratio: '1:1', duration: 4, fps: 16, seed: 1, steps: 30, fast: true, outputPrefix: 'p' });
    expect(fast['128:129'].inputs.value).toBe(true);
    expect(fast['128:114'].inputs.value).toBe(20);
  });
  it('Hunyuan : longueur en images', () => {
    const hy = reg.models.find((m) => m.id === 'hy15-i2v')!;
    const p = buildPrompt(reg, hy, wf(hy.workflow), { prompt: 'x', preset: '720p', ratio: '16:9', duration: 2, fps: 24, seed: 1, startImage: 'videogen/a.png', outputPrefix: 'p' });
    expect(p['78'].inputs.length).toBe(49);
    expect(p['80'].inputs.image).toBe('videogen/a.png');
  });
  it('refuse un prompt vide et une image manquante', () => {
    const i2v = reg.models.find((m) => m.id === 'ltx25-i2v')!;
    expect(() => buildPrompt(reg, ltx, wf(ltx.workflow), { prompt: ' ', preset: '720p', ratio: '16:9', duration: 3, fps: 24, seed: 1, outputPrefix: 'p' })).toThrow(/vide/);
    expect(() => buildPrompt(reg, i2v, wf(i2v.workflow), { prompt: 'x', preset: '720p', ratio: '16:9', duration: 3, fps: 24, seed: 1, outputPrefix: 'p' })).toThrow(/Image de début/);
  });
  it('détecte les poids absents (nœud grisé)', () => {
    const wan = reg.models.find((m) => m.id === 'wan22-t2v')!;
    const partial = structuredClone(info);
    partial.UNETLoader.input.required.unet_name[0] = ['autre.safetensors'];
    const av = checkAvailability(wf(wan.workflow), partial, wan);
    expect(av.ok).toBe(false);
    expect(av.missingFiles).toContain('wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors');
    delete partial.LTXVDualCFGGuider;
    expect(checkAvailability(wf(ltx.workflow), partial, ltx).missingNodes).toContain('LTXVDualCFGGuider');
  });
  it('trouve la vidéo dans /history', () => {
    expect(findVideoOutputs({ '75': { images: [{ filename: 'videogen/a_00001_.mp4', subfolder: 'videogen', type: 'output' }], animated: [true] } })).toHaveLength(1);
    expect(findVideoOutputs({ '9': { images: [{ filename: 'x.png', subfolder: '', type: 'output' }] } })).toHaveLength(0);
  });
});

describe('erreurs lisibles', () => {
  it('OOM', () => {
    expect(explainExecutionError({ exception_type: 'torch.OutOfMemoryError', exception_message: 'CUDA out of memory' }).title).toMatch(/OOM/);
  });
  it('nœud manquant / fichier absent', () => {
    expect(explainPromptRejection({ error: { type: 'missing_node_type', message: 'x' } }).title).toMatch(/Nœud manquant/);
    expect(
      explainPromptRejection({ error: { type: 'prompt_outputs_failed_validation' }, node_errors: { '1': { class_type: 'UNETLoader', errors: [{ type: 'value_not_in_list', extra_info: { received_value: 'a.safetensors' } }] } } }).title,
    ).toMatch(/Fichier de modèle absent/);
  });
});
