// Registre des modèles (models.json) et construction des requêtes /prompt à partir des workflows API.
// Module pur (sans DOM) : utilisé par l'interface, les tests unitaires et la validation contre un vrai ComfyUI.
import { comboOptions, type ObjectInfo } from '../comfy/client.ts';

export interface Target {
  node: string;
  input: string;
}
export interface NumericParam {
  targets: Target[];
  min?: number;
  max?: number;
  step?: number;
  default?: number;
  half?: Target[];
}
export interface BoolParam {
  targets: Target[];
  label: string;
  default: boolean;
  hides?: string[];
}
export interface ModelDef {
  id: string;
  family: string;
  label: string;
  mode: 't2v' | 'i2v' | 'flf2v';
  audio: boolean;
  workflow: string;
  template: string;
  extendWith?: string;
  output: Target[];
  resolution: { multiple: number; presets: string[]; default: string };
  duration: { min: number; max: number; default: number; targets?: Target[]; frames?: Target[] };
  fps: { options: number[]; default: number; targets: Target[] };
  params: {
    prompt: { targets: Target[] };
    negative?: { targets: Target[] };
    width: { targets: Target[] };
    height: { targets: Target[] };
    seed: { targets: Target[] };
    startImage?: { targets: Target[]; required?: boolean };
    endImage?: { targets: Target[]; required?: boolean };
    steps?: NumericParam;
    cfg?: NumericParam;
    enhancePrompt?: BoolParam;
    fast?: BoolParam;
  };
}
export interface Registry {
  version: number;
  comfyVersion: string;
  templatesVersion: string;
  families: Record<string, { label: string; approxGB: number; default: boolean; note?: string }>;
  resolutionPresets: Record<string, { label: string; pixels: number }>;
  ratios: Record<string, number>;
  models: ModelDef[];
}

export type ApiPrompt = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }>;

export interface GenParams {
  prompt: string;
  negative?: string;
  preset: string;
  ratio: string;
  duration: number;
  fps: number;
  seed: number;
  steps?: number;
  cfg?: number;
  enhancePrompt?: boolean;
  fast?: boolean;
  /** Noms de fichiers (sous-dossier compris) déjà envoyés via /upload/image. */
  startImage?: string;
  endImage?: string;
  outputPrefix: string;
}

export const MAX_SEED = 2 ** 48;

export function randomSeed(): number {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return (a[0] * 2 ** 16 + (a[1] & 0xffff)) % MAX_SEED;
}

function roundTo(v: number, m: number): number {
  return Math.max(m, Math.round(v / m) * m);
}

/** Largeur et hauteur pour un préréglage (nombre de pixels) et un ratio, arrondies au multiple du modèle. */
export function computeSize(reg: Registry, model: ModelDef, preset: string, ratio: string): { width: number; height: number } {
  const px = reg.resolutionPresets[preset]?.pixels ?? reg.resolutionPresets[model.resolution.default].pixels;
  const r = reg.ratios[ratio] ?? 16 / 9;
  const m = model.resolution.multiple;
  return { width: roundTo(Math.sqrt(px * r), m), height: roundTo(Math.sqrt(px / r), m) };
}

/** Nombre d'images généré pour une durée donnée (formule des templates : durée × fps + 1). */
export function frameCount(duration: number, fps: number): number {
  return Math.round(duration * fps) + 1;
}

/** Options affichées pour un modèle (uniquement ce que le workflow supporte). */
export function supportedOptions(model: ModelDef) {
  const p = model.params;
  return {
    negative: !!p.negative,
    steps: p.steps ?? null,
    cfg: p.cfg ?? null,
    startImage: !!p.startImage,
    endImage: !!p.endImage,
    enhancePrompt: p.enhancePrompt ?? null,
    fast: p.fast ?? null,
    fps: model.fps.options,
    duration: model.duration,
    presets: model.resolution.presets,
  };
}

/** Valeur actuelle d'une entrée dans le workflow (ex. prompt négatif par défaut du template). */
export function readInput(wf: ApiPrompt, t: Target): unknown {
  return wf[t.node]?.inputs[t.input];
}

function set(wf: ApiPrompt, targets: Target[] | undefined, value: unknown) {
  for (const t of targets ?? []) {
    const node = wf[t.node];
    if (!node) throw new Error(`Nœud ${t.node} absent du workflow`);
    node.inputs[t.input] = value;
  }
}

/** Construit la requête API à partir du workflow officiel converti et des réglages choisis. */
export function buildPrompt(reg: Registry, model: ModelDef, workflow: ApiPrompt, g: GenParams): ApiPrompt {
  const wf = structuredClone(workflow);
  const p = model.params;
  if (!g.prompt.trim()) throw new Error('Le prompt est vide');
  set(wf, p.prompt.targets, g.prompt);
  if (p.negative && g.negative !== undefined) set(wf, p.negative.targets, g.negative);
  const { width, height } = computeSize(reg, model, g.preset, g.ratio);
  set(wf, p.width.targets, width);
  set(wf, p.height.targets, height);

  const duration = Math.min(model.duration.max, Math.max(model.duration.min, Math.round(g.duration)));
  const fps = model.fps.options.includes(g.fps) ? g.fps : model.fps.default;
  // Les primitives « Duration » des templates sont entières (LTX) ou décimales (Wan) : même valeur.
  set(wf, model.duration.targets, duration);
  set(wf, model.duration.frames, frameCount(duration, fps));
  set(wf, model.fps.targets, fps);

  const seed = Math.max(0, Math.min(MAX_SEED, Math.floor(g.seed)));
  set(wf, p.seed.targets, seed);

  if (p.enhancePrompt) set(wf, p.enhancePrompt.targets, !!(g.enhancePrompt ?? p.enhancePrompt.default));
  const fast = p.fast ? !!(g.fast ?? p.fast.default) : false;
  if (p.fast) set(wf, p.fast.targets, fast);
  if (p.steps && g.steps !== undefined && !fast) {
    const steps = Math.min(p.steps.max ?? 100, Math.max(p.steps.min ?? 1, Math.round(g.steps)));
    set(wf, p.steps.targets, steps);
    if (p.steps.half) set(wf, p.steps.half, Math.max(1, Math.floor(steps / 2)));
  }
  if (p.cfg && g.cfg !== undefined && !fast) {
    set(wf, p.cfg.targets, Math.min(p.cfg.max ?? 30, Math.max(p.cfg.min ?? 0, Number(g.cfg))));
  }

  if (p.startImage) {
    if (!g.startImage) throw new Error('Image de début requise pour ce modèle');
    set(wf, p.startImage.targets, g.startImage);
  }
  if (p.endImage) {
    if (!g.endImage) throw new Error('Image de fin requise pour ce modèle');
    set(wf, p.endImage.targets, g.endImage);
  }
  set(wf, model.output, g.outputPrefix);
  return wf;
}

export interface Availability {
  ok: boolean;
  missingNodes: string[];
  missingFiles: string[];
}

/** Le modèle est-il utilisable sur ce serveur ? (nœuds présents et fichiers de poids listés par /object_info) */
export function checkAvailability(workflow: ApiPrompt, info: ObjectInfo, model?: ModelDef): Availability {
  const missingNodes = new Set<string>();
  const missingFiles = new Set<string>();
  const imageTargets = new Set(
    [...(model?.params.startImage?.targets ?? []), ...(model?.params.endImage?.targets ?? [])].map((t) => `${t.node}.${t.input}`),
  );
  for (const [id, node] of Object.entries(workflow)) {
    const def = info[node.class_type];
    if (!def) {
      missingNodes.add(node.class_type);
      continue;
    }
    for (const [name, value] of Object.entries(node.inputs)) {
      if (typeof value !== 'string' || imageTargets.has(`${id}.${name}`)) continue;
      const spec = def.input.required?.[name] ?? def.input.optional?.[name];
      const opts = comboOptions(spec as unknown[] | undefined);
      if (opts && !opts.includes(value) && /\.(safetensors|ckpt|pt|pth|bin|gguf|sft)$/i.test(value)) missingFiles.add(value);
    }
  }
  return { ok: missingNodes.size === 0 && missingFiles.size === 0, missingNodes: [...missingNodes], missingFiles: [...missingFiles] };
}

/** Trouve les sorties vidéo d'une entrée d'historique (SaveVideo : images + animated, ou videos/gifs). */
export function findVideoOutputs(outputs: Record<string, Record<string, unknown>>): { filename: string; subfolder: string; type: string }[] {
  const out: { filename: string; subfolder: string; type: string }[] = [];
  for (const o of Object.values(outputs)) {
    for (const key of ['videos', 'gifs', 'images']) {
      const arr = o[key];
      if (!Array.isArray(arr)) continue;
      for (const f of arr as { filename?: string; subfolder?: string; type?: string }[]) {
        if (f?.filename && /\.(mp4|webm|mov|mkv|gif)$/i.test(f.filename)) {
          out.push({ filename: f.filename, subfolder: f.subfolder ?? '', type: f.type ?? 'output' });
        }
      }
    }
  }
  return out;
}
