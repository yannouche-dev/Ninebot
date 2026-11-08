// Écran « Générer » : choix du modèle (grisé si absent du serveur), options supportées par le modèle,
// préréglages, lancement, progression en direct, annulation, résultat.
import { h, replace, toast, download, fmtDuration } from './dom.ts';
import { app, type Prefill } from './context.ts';
import { journal } from '../core/journal.ts';
import { loadPresets, savePresets, type GenPreset } from '../core/settings.ts';
import { computeSize, frameCount, randomSeed, readInput, supportedOptions, MAX_SEED, type ModelDef } from '../workflows/build.ts';
import { Generation, GenerationError } from '../comfy/generate.ts';
import { explainError } from '../comfy/errors.ts';
import { thumbnail, videoMeta, lastFrame } from '../media/frames.ts';
import type { GalleryItem } from '../media/gallery.ts';
import { confirmDialog } from './dialog.ts';

interface FormState {
  modelId: string;
  prompt: string;
  negative: string | null;
  preset: string;
  ratio: string;
  duration: number;
  fps: number;
  seed: number;
  randomSeed: boolean;
  steps: number | null;
  cfg: number | null;
  enhancePrompt: boolean;
  fast: boolean;
  startImage: Blob | null;
  endImage: Blob | null;
  parentId?: string;
}

export class GenerateScreen {
  el = h('div', { class: 'screen' });
  private form = h('form', { class: 'card', 'data-testid': 'gen-form' });
  private progressBox = h('section', { class: 'card hidden', 'data-testid': 'gen-progress' });
  private resultBox = h('section', { class: 'card hidden', 'data-testid': 'gen-result' });
  private notice = h('div');
  private st: FormState | null = null;
  private gen: Generation | null = null;
  private previewUrl: string | null = null;
  private imageUrls: string[] = [];

  constructor() {
    this.el.append(this.notice, this.form, this.progressBox, this.resultBox);
    app.on((w) => {
      if (w === 'registry' || w === 'availability') this.renderForm();
      if (w === 'route' && app.route === 'generate') this.onShow();
    });
    app.manager.onChange(() => this.renderNotice());
    this.renderNotice();
    this.renderForm();
  }

  private onShow() {
    if (app.prefill) {
      this.applyPrefill(app.prefill);
      app.prefill = null;
    }
    this.renderNotice();
    if (app.manager.state.phase === 'ready') void app.refreshAvailability().catch((e) => journal.warn('modèles', 'Lecture de /object_info impossible', e));
  }

  private renderNotice() {
    const ph = app.manager.state.phase;
    replace(
      this.notice,
      ph !== 'ready'
        ? h(
            'div',
            { class: 'card msg warn' },
            ph === 'booting' || ph === 'starting' ? 'L’instance démarre… tu peux préparer ta génération.' : 'Aucune instance prête. ',
            ph === 'booting' || ph === 'starting' ? null : h('button', { type: 'button', class: 'btn btn-small', on: { click: () => app.navigate('instance') } }, 'Démarrer'),
          )
        : null,
    );
  }

  private defaults(m: ModelDef): FormState {
    const wf = app.workflows.get(m.id)!;
    const neg = m.params.negative ? String(readInput(wf, m.params.negative.targets[0]) ?? '') : null;
    return {
      modelId: m.id,
      prompt: this.st?.prompt ?? '',
      negative: neg,
      preset: m.resolution.presets.includes(this.st?.preset ?? '') ? this.st!.preset : m.resolution.default,
      ratio: this.st?.ratio ?? '16:9',
      duration: Math.min(m.duration.max, Math.max(m.duration.min, this.st?.duration ?? m.duration.default)),
      fps: m.fps.options.includes(this.st?.fps ?? -1) ? this.st!.fps : m.fps.default,
      seed: this.st?.seed ?? randomSeed(),
      randomSeed: this.st?.randomSeed ?? true,
      steps: m.params.steps?.default ?? null,
      cfg: m.params.cfg?.default ?? null,
      enhancePrompt: m.params.enhancePrompt?.default ?? false,
      fast: m.params.fast?.default ?? false,
      startImage: m.params.startImage ? this.st?.startImage ?? null : null,
      endImage: m.params.endImage ? this.st?.endImage ?? null : null,
    };
  }

  private applyPrefill(p: Prefill) {
    const m = app.model(p.modelId);
    if (!m) return;
    const base = this.defaults(m);
    this.st = {
      ...base,
      ...Object.fromEntries(Object.entries(p.params).filter(([, v]) => v !== undefined)),
      modelId: m.id,
      randomSeed: p.params.seed === undefined,
      startImage: p.startImage ?? base.startImage,
      endImage: p.endImage ?? base.endImage,
      parentId: p.parentId,
    } as FormState;
    if (p.note) toast(p.note, 'info');
    this.renderForm();
  }

  private currentModel(): ModelDef | undefined {
    return this.st ? app.model(this.st.modelId) : undefined;
  }

  renderForm(): void {
    const reg = app.registry;
    if (!reg) {
      replace(this.form, h('p', null, 'Chargement des modèles…'));
      return;
    }
    if (!this.st || !app.model(this.st.modelId)) this.st = this.defaults(reg.models[0]);
    const st = this.st;
    const m = this.currentModel()!;
    const opts = supportedOptions(m);
    for (const u of this.imageUrls) URL.revokeObjectURL(u);
    this.imageUrls = [];

    // Sélecteur de modèle
    const select = h('select', { class: 'input', id: 'model', 'data-testid': 'model-select' }) as HTMLSelectElement;
    for (const [famId, fam] of Object.entries(reg.families)) {
      const group = h('optgroup', { label: fam.label });
      for (const mm of reg.models.filter((x) => x.family === famId)) {
        const av = app.availability.get(mm.id);
        const known = app.availability.size > 0;
        const label = `${mm.label}${known && !av?.ok ? ' — absent du serveur' : ''}`;
        group.append(h('option', { value: mm.id, disabled: known && !av?.ok, selected: mm.id === m.id }, label));
      }
      select.append(group);
    }
    select.addEventListener('change', () => {
      const nm = app.model(select.value)!;
      this.st = { ...this.defaults(nm), parentId: undefined };
      this.renderForm();
    });
    const av = app.availability.get(m.id);
    const avMsg =
      av && !av.ok
        ? h('p', { class: 'msg warn' }, `Absent du serveur : ${[...av.missingNodes.map((n) => 'nœud ' + n), ...av.missingFiles].join(', ')}. Active la famille « ${reg.families[m.family]?.label} » dans les réglages de location.`)
        : null;

    // Prompt
    const prompt = h('textarea', { class: 'input', id: 'prompt', rows: 5, placeholder: 'Décris la scène, le mouvement, la caméra… (en anglais de préférence)', 'data-testid': 'prompt' }) as HTMLTextAreaElement;
    prompt.value = st.prompt;
    prompt.addEventListener('input', () => (st.prompt = prompt.value));
    let negBox: HTMLElement | null = null;
    if (opts.negative && st.negative !== null) {
      const neg = h('textarea', { class: 'input', id: 'negative', rows: 3 }) as HTMLTextAreaElement;
      neg.value = st.negative;
      neg.addEventListener('input', () => (st.negative = neg.value));
      negBox = h('details', null, h('summary', null, 'Prompt négatif'), neg);
    }

    // Images
    const imageField = (key: 'startImage' | 'endImage', label: string, required: boolean) => {
      const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'input', 'data-testid': key }) as HTMLInputElement;
      const preview = h('div', { class: 'img-preview' });
      const show = () => {
        const b = st[key];
        if (b) {
          const u = URL.createObjectURL(b);
          this.imageUrls.push(u);
          const clearBtn = h('button', { type: 'button', class: 'btn btn-small', on: { click: () => ((st[key] = null), show()) } }, 'Retirer');
          replace(preview, h('img', { src: u, alt: label }), clearBtn);
        } else replace(preview);
      };
      input.addEventListener('change', () => {
        const f = input.files?.[0];
        if (f) st[key] = f;
        show();
      });
      show();
      return h('label', { class: 'field' }, h('span', { class: 'field-label' }, `${label}${required ? ' *' : ''}`), input, preview);
    };

    // Résolution
    const size = computeSize(reg, m, st.preset, st.ratio);
    const presetSel = h('select', { class: 'input', id: 'preset', 'data-testid': 'preset' }) as HTMLSelectElement;
    for (const p of m.resolution.presets) presetSel.append(h('option', { value: p, selected: p === st.preset }, reg.resolutionPresets[p].label));
    presetSel.addEventListener('change', () => {
      st.preset = presetSel.value;
      this.renderForm();
    });
    const ratios = h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': 'Format' },
      ...Object.keys(reg.ratios).map((r) =>
        h('button', { type: 'button', class: `seg ${r === st.ratio ? 'active' : ''}`, 'aria-pressed': String(r === st.ratio), 'data-testid': `ratio-${r}`, on: { click: () => ((st.ratio = r), this.renderForm()) } }, r),
      ),
    );

    // Durée / FPS
    const dur = h('input', { type: 'range', min: m.duration.min, max: m.duration.max, step: 1, value: st.duration, id: 'duration', 'data-testid': 'duration' }) as HTMLInputElement;
    const durLabel = h('span', { class: 'value' });
    const frames = () => `${st.duration} s · ${frameCount(st.duration, st.fps)} images`;
    durLabel.textContent = frames();
    dur.addEventListener('input', () => {
      st.duration = Number(dur.value);
      durLabel.textContent = frames();
    });
    let fpsField: HTMLElement | null = null;
    if (opts.fps.length > 1) {
      const fps = h('select', { class: 'input', id: 'fps' }) as HTMLSelectElement;
      for (const f of opts.fps) fps.append(h('option', { value: f, selected: f === st.fps }, `${f} i/s`));
      fps.addEventListener('change', () => {
        st.fps = Number(fps.value);
        durLabel.textContent = frames();
      });
      fpsField = h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Images par seconde'), fps);
    }

    // Avancé : steps, CFG, seed, options booléennes
    const adv: HTMLElement[] = [];
    const numberField = (key: 'steps' | 'cfg', label: string, p: NonNullable<typeof opts.steps>) => {
      const input = h('input', { type: 'number', class: 'input', min: p.min, max: p.max, step: p.step ?? 1, value: String(st[key] ?? p.default), id: key, inputmode: 'decimal' }) as HTMLInputElement;
      input.addEventListener('change', () => (st[key] = Number(input.value)));
      return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input);
    };
    const boolField = (key: 'enhancePrompt' | 'fast', p: NonNullable<typeof opts.fast>) => {
      const c = h('input', { type: 'checkbox', checked: st[key], id: key }) as HTMLInputElement;
      c.addEventListener('change', () => {
        st[key] = c.checked;
        if (p.hides) this.renderForm();
      });
      return h('label', { class: 'check' }, c, ` ${p.label}`);
    };
    if (opts.fast) adv.push(boolField('fast', opts.fast));
    if (opts.enhancePrompt) adv.push(boolField('enhancePrompt', opts.enhancePrompt));
    if (opts.steps && !st.fast) adv.push(numberField('steps', 'Étapes (steps)', opts.steps));
    if (opts.cfg && !st.fast) adv.push(numberField('cfg', 'CFG', opts.cfg));
    const seed = h('input', { type: 'number', class: 'input', min: 0, max: MAX_SEED, value: String(st.seed), id: 'seed', disabled: st.randomSeed, inputmode: 'numeric', 'data-testid': 'seed' }) as HTMLInputElement;
    seed.addEventListener('change', () => (st.seed = Number(seed.value)));
    const rnd = h('input', { type: 'checkbox', checked: st.randomSeed, id: 'random-seed' }) as HTMLInputElement;
    rnd.addEventListener('change', () => {
      st.randomSeed = rnd.checked;
      seed.disabled = rnd.checked;
    });
    adv.push(h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Seed'), h('div', { class: 'row' }, seed, h('label', { class: 'check' }, rnd, ' aléatoire'))));

    // Préréglages
    const presets = loadPresets().filter((p) => p.modelId === m.id);
    const presetPick = h('select', { class: 'input', 'aria-label': 'Préréglage' }) as HTMLSelectElement;
    presetPick.append(h('option', { value: '' }, presets.length ? '— Préréglages —' : 'Aucun préréglage'));
    for (const p of presets) presetPick.append(h('option', { value: p.name }, p.name));
    presetPick.addEventListener('change', () => {
      const p = presets.find((x) => x.name === presetPick.value);
      if (p) {
        this.st = { ...st, ...(p.values as Partial<FormState>), modelId: m.id, startImage: st.startImage, endImage: st.endImage };
        this.renderForm();
      }
    });
    const savePreset = h('button', { type: 'button', class: 'btn btn-small' }, 'Enregistrer');
    savePreset.addEventListener('click', () => {
      const name = window.prompt('Nom du préréglage', `${m.label.split('·')[0].trim()} ${st.preset} ${st.ratio}`)?.trim();
      if (!name) return;
      const values: Record<string, unknown> = { prompt: st.prompt, negative: st.negative, preset: st.preset, ratio: st.ratio, duration: st.duration, fps: st.fps, steps: st.steps, cfg: st.cfg, enhancePrompt: st.enhancePrompt, fast: st.fast, seed: st.seed, randomSeed: st.randomSeed };
      const all = loadPresets().filter((p) => !(p.modelId === m.id && p.name === name));
      all.push({ name, modelId: m.id, values } as GenPreset);
      savePresets(all);
      toast('Préréglage enregistré', 'ok');
      this.renderForm();
    });
    const delPreset = h('button', { type: 'button', class: 'btn btn-small', disabled: !presets.length }, 'Supprimer');
    delPreset.addEventListener('click', () => {
      if (!presetPick.value) return;
      savePresets(loadPresets().filter((p) => !(p.modelId === m.id && p.name === presetPick.value)));
      this.renderForm();
    });

    const busy = !!this.gen;
    const ready = app.manager.state.phase === 'ready' && !!app.manager.comfy;
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-big', disabled: busy || !ready || (av && !av.ok), 'data-testid': 'generate' }, busy ? 'Génération en cours…' : 'Générer');

    replace(
      this.form,
      h('h1', null, 'Générer'),
      st.parentId ? h('p', { class: 'msg info' }, `Prolongation de ${st.parentId} : la dernière image sert d’image de début.`) : null,
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Modèle'), select),
      avMsg,
      h('div', { class: 'row' }, presetPick, savePreset, delPreset),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Prompt *'), prompt),
      negBox,
      opts.startImage ? imageField('startImage', 'Image de début', !!m.params.startImage?.required) : null,
      opts.endImage ? imageField('endImage', 'Image de fin', !!m.params.endImage?.required) : null,
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Résolution'), h('div', { class: 'row' }, presetSel, ratios), h('small', { class: 'hint', 'data-testid': 'size' }, `${size.width} × ${size.height}`)),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Durée '), durLabel, dur),
      fpsField,
      h('details', { class: 'advanced', open: false }, h('summary', null, 'Options avancées'), ...adv),
      submit,
    );
    this.form.onsubmit = (e) => {
      e.preventDefault();
      void this.start();
    };
  }

  private async start() {
    const st = this.st;
    const m = this.currentModel();
    const c = app.manager.comfy;
    if (!st || !m || !c || !app.registry) return;
    if (!st.prompt.trim()) return toast('Écris un prompt', 'error');
    if (m.params.startImage?.required && !st.startImage) return toast('Ajoute une image de début', 'error');
    if (m.params.endImage?.required && !st.endImage) return toast('Ajoute une image de fin', 'error');
    if (st.randomSeed) st.seed = randomSeed();
    const params = {
      prompt: st.prompt,
      negative: st.negative ?? undefined,
      preset: st.preset,
      ratio: st.ratio,
      duration: st.duration,
      fps: st.fps,
      seed: st.seed,
      steps: st.steps ?? undefined,
      cfg: st.cfg ?? undefined,
      enhancePrompt: st.enhancePrompt,
      fast: st.fast,
    };
    const statusEl = h('p', { class: 'gen-status', 'data-testid': 'gen-status' }, 'Préparation…');
    const bar = h('progress', { max: 1, value: 0, 'data-testid': 'gen-bar' }) as HTMLProgressElement;
    const stepEl = h('p', { class: 'hint' });
    const img = h('img', { class: 'gen-preview hidden', alt: 'Aperçu' }) as HTMLImageElement;
    const timer = h('span', { class: 'hint' });
    const cancel = h('button', { type: 'button', class: 'btn btn-danger btn-big', 'data-testid': 'cancel' }, 'Annuler');
    replace(this.progressBox, h('h2', null, 'Génération'), statusEl, bar, stepEl, timer, img, cancel);
    this.progressBox.classList.remove('hidden');
    this.resultBox.classList.add('hidden');
    const t0 = Date.now();
    const tick = setInterval(() => (timer.textContent = `Écoulé : ${fmtDuration(Date.now() - t0)}`), 1000);

    const gen = new Generation({
      client: c,
      registry: app.registry,
      model: m,
      workflow: app.workflows.get(m.id)!,
      params,
      startImage: st.startImage,
      endImage: st.endImage,
      stallMinutes: app.settings.stallMinutes,
      events: {
        onStatus: (t) => (statusEl.textContent = t),
        onProgress: (p) => {
          bar.value = p.overall;
          stepEl.textContent = `${Math.round(p.overall * 100)} % · ${p.label}${p.max ? ` (${p.value}/${p.max})` : ''}`;
        },
        onPreview: (b) => {
          if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
          this.previewUrl = URL.createObjectURL(b);
          img.src = this.previewUrl;
          img.classList.remove('hidden');
        },
      },
    });
    this.gen = gen;
    cancel.addEventListener('click', async () => {
      if (await confirmDialog({ title: 'Annuler la génération ?', ok: 'Annuler la génération', cancel: 'Continuer', danger: true })) void gen.cancel();
    });
    this.renderForm();
    try {
      const r = await gen.promise;
      const meta = await videoMeta(r.blob).catch(() => ({ duration: st.duration, width: 0, height: 0 }));
      const thumb = await thumbnail(r.blob);
      const size = computeSize(app.registry, m, st.preset, st.ratio);
      const item = app.gallery.add({
        kind: 'generated',
        modelId: m.id,
        modelLabel: m.label,
        params,
        seed: r.seed,
        blob: r.blob,
        thumb,
        thumbUrl: null,
        width: meta.width || size.width,
        height: meta.height || size.height,
        duration: meta.duration || st.duration,
        hasAudio: m.audio,
        elapsedMs: r.elapsedMs,
        startImage: st.startImage,
        endImage: st.endImage,
        parentId: st.parentId,
      });
      st.parentId = undefined;
      this.progressBox.classList.add('hidden');
      this.showResult(item);
      toast('Vidéo prête', 'ok');
    } catch (e) {
      const r = e instanceof GenerationError ? e.readable : explainError(e);
      const cancelled = e instanceof GenerationError && e.cancelled;
      replace(
        this.progressBox,
        h('h2', null, cancelled ? 'Génération annulée' : 'Échec de la génération'),
        h('p', { class: `msg ${cancelled ? 'warn' : 'err'}`, 'data-testid': 'gen-error' }, r.title),
        r.hint ? h('p', null, r.hint) : null,
        r.detail ? h('pre', { class: 'detail' }, r.detail) : null,
        h('button', { type: 'button', class: 'btn', on: { click: () => app.navigate('journal') } }, 'Voir le Journal'),
      );
    } finally {
      clearInterval(tick);
      this.gen = null;
      if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
      this.previewUrl = null;
      this.renderForm();
    }
  }

  showResult(item: GalleryItem): void {
    const video = h('video', { src: item.url, poster: item.thumbUrl ?? undefined, controls: true, playsinline: true, loop: true, preload: 'metadata', class: 'video', 'data-testid': 'result-video' });
    replace(
      this.resultBox,
      h('h2', null, 'Résultat'),
      video,
      h('p', { class: 'hint' }, `${item.modelLabel} · ${item.width}×${item.height} · ${item.duration.toFixed(1)} s · seed ${item.seed} · ${fmtDuration(item.elapsedMs)}`),
      h(
        'div',
        { class: 'actions' },
        h('button', { type: 'button', class: 'btn btn-primary', 'data-testid': 'download', on: { click: () => download(item.blob, `videogen_${item.modelId}_${item.seed}.mp4`) } }, 'Télécharger'),
        h('button', { type: 'button', class: 'btn', 'data-testid': 'extend', on: { click: () => void extendItem(item) } }, 'Prolonger'),
        h('button', { type: 'button', class: 'btn', on: { click: () => app.navigate('gallery') } }, 'Galerie / timeline'),
      ),
    );
    this.resultBox.classList.remove('hidden');
    this.resultBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

/** Prolonger : extrait la dernière image dans le navigateur et prépare un image → vidéo enchaîné. */
export async function extendItem(item: GalleryItem): Promise<void> {
  const m = app.model(item.modelId);
  const target = app.model(m?.extendWith ?? '') ?? app.registry?.models.find((x) => x.mode === 'i2v' && x.family === m?.family);
  if (!target) return toast('Aucun modèle image → vidéo pour prolonger', 'error');
  toast('Extraction de la dernière image…', 'info');
  try {
    const frame = await lastFrame(item.blob, (t) => toast(t, 'info'));
    app.prefill = {
      modelId: target.id,
      params: { prompt: item.params.prompt, negative: item.params.negative, preset: item.params.preset, ratio: item.params.ratio, duration: item.params.duration, fps: item.params.fps },
      startImage: frame,
      parentId: item.id,
      note: `Prolongation de ${item.id} avec ${target.label}`,
    };
    app.navigate('generate');
  } catch (e) {
    journal.error('média', 'Extraction de la dernière image impossible', e);
    toast('Extraction de la dernière image impossible (voir Journal)', 'error');
  }
}

/** Rejouer : mêmes réglages et même seed. */
export function replayItem(item: GalleryItem): void {
  app.prefill = { modelId: item.modelId, params: { ...item.params, seed: item.seed }, startImage: item.startImage, endImage: item.endImage, note: `Réglages de ${item.id} rechargés (seed ${item.seed})` };
  app.navigate('generate');
}
