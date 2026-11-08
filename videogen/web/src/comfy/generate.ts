// Exécution d'une génération : envoi des images, POST /prompt, suivi WebSocket (progression, aperçus),
// récupération du résultat via /history + /view (Blob en mémoire), nettoyage des fichiers sur l'instance.
import { journal } from '../core/journal.ts';
import { randomToken } from '../core/vault.ts';
import { HttpError } from '../core/http.ts';
import type { ComfyClient, FileRef, HistoryEntry } from './client.ts';
import { explainError, explainExecutionError, type ReadableError } from './errors.ts';
import { buildPrompt, findVideoOutputs, type ApiPrompt, type GenParams, type ModelDef, type Registry } from '../workflows/build.ts';

export interface GenProgress {
  /** Fraction globale estimée (0..1). */
  overall: number;
  /** Étape en cours (titre du nœud). */
  label: string;
  value?: number;
  max?: number;
}

export interface GenEvents {
  onStatus?(text: string): void;
  onProgress?(p: GenProgress): void;
  onPreview?(blob: Blob): void;
  onQueued?(promptId: string): void;
}

export interface GenResult {
  blob: Blob;
  file: FileRef;
  promptId: string;
  seed: number;
  modelId: string;
  params: GenParams;
  elapsedMs: number;
}

export class GenerationError extends Error {
  readable: ReadableError;
  cancelled: boolean;
  constructor(readable: ReadableError, cancelled = false) {
    super(readable.title);
    this.readable = readable;
    this.cancelled = cancelled;
  }
}

export interface GenInput {
  client: ComfyClient;
  registry: Registry;
  model: ModelDef;
  workflow: ApiPrompt;
  params: Omit<GenParams, 'startImage' | 'endImage' | 'outputPrefix'>;
  startImage?: Blob | null;
  endImage?: Blob | null;
  stallMinutes: number;
  events?: GenEvents;
}

export class Generation {
  readonly promise: Promise<GenResult>;
  private input: GenInput;
  private promptId: string | null = null;
  private ws: WebSocket | null = null;
  private cancelled = false;
  private finished = false;
  private resolveFn!: (r: GenResult) => void;
  private rejectFn!: (e: GenerationError) => void;
  private lastActivity = Date.now();
  private timers: ReturnType<typeof setInterval>[] = [];
  private executed = new Set<string>();
  private totalNodes = 1;
  private titles: Record<string, string> = {};
  private uploaded: FileRef[] = [];
  private t0 = Date.now();
  private clientId = crypto.randomUUID();
  private finalizing = false;

  constructor(input: GenInput) {
    this.input = input;
    this.promise = new Promise<GenResult>((res, rej) => {
      this.resolveFn = res;
      this.rejectFn = rej;
    });
    this.run().catch((e) => this.fail(e instanceof GenerationError ? e : new GenerationError(explainError(e))));
  }

  get id(): string | null {
    return this.promptId;
  }

  private status(t: string) {
    this.input.events?.onStatus?.(t);
  }

  private async run() {
    const { client, registry, model, workflow, params } = this.input;
    this.status('Connexion au serveur…');
    this.openSocket();

    const names: { start?: string; end?: string } = {};
    for (const [key, blob] of [['start', this.input.startImage], ['end', this.input.endImage]] as const) {
      if (!blob) continue;
      this.status(key === 'start' ? 'Envoi de l’image de début…' : 'Envoi de l’image de fin…');
      const ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
      const ref = await client.uploadImage(blob, `vg_${randomToken(9)}.${ext}`);
      this.uploaded.push(ref);
      names[key] = ref.subfolder ? `${ref.subfolder}/${ref.filename}` : ref.filename;
    }
    if (this.cancelled) throw new GenerationError({ title: 'Génération annulée', hint: '' }, true);

    const prompt = buildPrompt(registry, model, workflow, {
      ...params,
      startImage: names.start,
      endImage: names.end,
      outputPrefix: `videogen/${model.id}_${Date.now()}`,
    });
    this.totalNodes = Object.keys(prompt).length;
    for (const [id, n] of Object.entries(prompt)) this.titles[id] = n._meta?.title ?? n.class_type;

    this.status('Envoi du workflow…');
    journal.info('génération', `Lancement ${model.label} — ${params.preset} ${params.ratio}, ${params.duration} s à ${params.fps} i/s, seed ${params.seed}`);
    const res = await client.prompt(prompt, this.clientId);
    this.promptId = res.prompt_id;
    this.input.events?.onQueued?.(res.prompt_id);
    journal.info('génération', `Prompt accepté (id ${res.prompt_id}, position ${res.number})`);
    this.status('En file d’attente…');
    this.lastActivity = Date.now();
    if (this.cancelled) await this.sendCancel();

    // Surveillance : blocage, perte du WebSocket.
    this.timers.push(
      setInterval(() => {
        void this.watch();
      }, 5000),
    );
  }

  private openSocket(attempt = 0) {
    if (this.finished) return;
    let ws: WebSocket;
    try {
      ws = this.input.client.openSocket(this.clientId);
    } catch (e) {
      journal.warn('génération', 'WebSocket impossible, suivi par interrogation', e);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'feature_flags', data: { supports_preview_metadata: true } }));
      journal.debug('génération', 'WebSocket connecté');
    };
    ws.onmessage = (ev) => this.onMessage(ev);
    ws.onclose = () => {
      if (this.finished) return;
      journal.debug('génération', 'WebSocket fermé, reconnexion…');
      const delay = Math.min(15000, 1000 * 2 ** attempt);
      setTimeout(() => this.openSocket(attempt + 1), delay);
    };
    ws.onerror = () => {
      /* onclose suit */
    };
  }

  private onMessage(ev: MessageEvent) {
    if (ev.data instanceof ArrayBuffer) {
      this.onBinary(ev.data);
      return;
    }
    let msg: { type: string; data: Record<string, unknown> };
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    const d = msg.data ?? {};
    if (d.prompt_id && this.promptId && d.prompt_id !== this.promptId) return;
    if (!this.promptId && msg.type !== 'status') return;
    this.lastActivity = Date.now();
    switch (msg.type) {
      case 'execution_start':
        this.status('Génération en cours…');
        break;
      case 'execution_cached':
        for (const n of (d.nodes as string[]) ?? []) this.executed.add(String(n));
        this.emitProgress();
        break;
      case 'executing': {
        const node = d.node as string | null;
        if (node === null) {
          void this.finalize();
        } else {
          this.current = String(node);
          this.currentValue = 0;
          this.currentMax = 0;
          this.emitProgress();
        }
        break;
      }
      case 'progress':
        this.currentValue = Number(d.value ?? 0);
        this.currentMax = Number(d.max ?? 0);
        if (d.node) this.current = String(d.node);
        this.emitProgress();
        break;
      case 'executed':
        if (d.node) this.executed.add(String(d.node));
        this.emitProgress();
        break;
      case 'execution_success':
        void this.finalize();
        break;
      case 'execution_error': {
        const readable = explainExecutionError(d as Record<string, string>);
        journal.error('génération', readable.title, d);
        this.fail(new GenerationError(readable));
        break;
      }
      case 'execution_interrupted':
        journal.warn('génération', 'Génération interrompue', d);
        this.fail(new GenerationError({ title: 'Génération annulée', hint: '' }, true));
        break;
    }
  }

  private current = '';
  private currentValue = 0;
  private currentMax = 0;

  private emitProgress() {
    if (this.current) this.executed.add(this.current);
    const done = Math.max(0, this.executed.size - 1);
    const frac = this.currentMax > 0 ? this.currentValue / this.currentMax : 0;
    const overall = Math.min(0.99, (done + frac) / this.totalNodes);
    this.input.events?.onProgress?.({
      overall,
      label: this.titles[this.current] ?? this.current,
      value: this.currentMax ? this.currentValue : undefined,
      max: this.currentMax || undefined,
    });
  }

  private onBinary(buf: ArrayBuffer) {
    if (buf.byteLength < 8) return;
    const view = new DataView(buf);
    const event = view.getUint32(0);
    let offset = 4;
    let mime = 'image/jpeg';
    if (event === 1) {
      mime = view.getUint32(4) === 2 ? 'image/png' : 'image/jpeg';
      offset = 8;
    } else if (event === 4) {
      const len = view.getUint32(4);
      try {
        const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, len))) as { prompt_id?: string; image_type?: string };
        if (meta.prompt_id && meta.prompt_id !== this.promptId) return;
        if (meta.image_type) mime = meta.image_type;
      } catch {
        return;
      }
      offset = 8 + len;
    } else return;
    this.lastActivity = Date.now();
    this.input.events?.onPreview?.(new Blob([buf.slice(offset)], { type: mime }));
  }

  private async watch() {
    if (this.finished || !this.promptId) return;
    const wsDown = !this.ws || this.ws.readyState !== WebSocket.OPEN;
    const idleMs = Date.now() - this.lastActivity;
    if (!wsDown && idleMs < 60000) return;
    try {
      const h = await this.input.client.history(this.promptId);
      if (h) return this.handleHistory(h);
      const q = await this.input.client.queue();
      const inQueue = [...q.queue_running, ...q.queue_pending].some((e) => e[1] === this.promptId);
      if (inQueue) {
        if (idleMs > this.input.stallMinutes * 60000) {
          journal.warn('génération', `Aucune progression depuis ${Math.round(idleMs / 60000)} min`);
          this.status('Toujours en cours (pas de nouvelles depuis un moment)…');
        }
        return;
      }
      if (idleMs > 120000) {
        this.fail(new GenerationError({ title: 'Délai dépassé', hint: 'Le travail a disparu de la file sans résultat (redémarrage de ComfyUI ?). Relance la génération.' }));
      }
    } catch (e) {
      if (idleMs > this.input.stallMinutes * 60000) {
        this.fail(new GenerationError({ title: 'Délai dépassé', hint: 'L’instance ne répond plus. Vérifie l’onglet Instance.', detail: String(e) }));
      }
    }
  }

  private async handleHistory(h: HistoryEntry) {
    if (h.status?.status_str === 'error') {
      const err = h.status.messages.find((m) => m[0] === 'execution_error');
      if (err) return this.fail(new GenerationError(explainExecutionError(err[1] as Record<string, string>)));
      if (h.status.messages.some((m) => m[0] === 'execution_interrupted')) return this.fail(new GenerationError({ title: 'Génération annulée', hint: '' }, true));
      return this.fail(new GenerationError({ title: 'Échec de la génération', hint: 'Voir le Journal.' }));
    }
    if (!h.status?.completed && h.status?.status_str !== 'success') return;
    const files = findVideoOutputs(h.outputs);
    if (!files.length) return this.fail(new GenerationError({ title: 'Aucune vidéo produite', hint: 'Le workflow s’est terminé sans sortie vidéo.' }));
    this.status('Téléchargement de la vidéo…');
    this.input.events?.onProgress?.({ overall: 0.995, label: 'Téléchargement' });
    const file = files[files.length - 1];
    const blob = await this.input.client.view(file);
    this.succeed({
      blob: blob.type ? blob : new Blob([blob], { type: 'video/mp4' }),
      file,
      promptId: this.promptId!,
      seed: this.input.params.seed,
      modelId: this.input.model.id,
      params: { ...this.input.params, outputPrefix: '' },
      elapsedMs: Date.now() - this.t0,
    });
    // Suppression des sorties sur l'instance une fois récupérées.
    void this.input.client.deleteFiles([...files, ...this.uploaded]).catch((e) => journal.warn('génération', 'Suppression des fichiers sur l’instance impossible', e));
  }

  private async finalize() {
    if (this.finished || this.finalizing || !this.promptId) return;
    this.finalizing = true;
    try {
      for (let i = 0; i < 10 && !this.finished; i++) {
        const h = await this.input.client.history(this.promptId);
        if (h && (h.status?.completed || h.status?.status_str === 'error')) {
          await this.handleHistory(h);
          return;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (e) {
      this.fail(new GenerationError(explainError(e)));
    } finally {
      this.finalizing = false;
    }
  }

  private async sendCancel() {
    if (!this.promptId) return;
    try {
      await this.input.client.removeFromQueue([this.promptId]);
      await this.input.client.interrupt(this.promptId);
    } catch (e) {
      journal.warn('génération', 'Annulation : requête échouée', e);
    }
  }

  async cancel(): Promise<void> {
    if (this.finished) return;
    this.cancelled = true;
    journal.info('génération', 'Annulation demandée');
    this.status('Annulation…');
    if (!this.promptId) return;
    await this.sendCancel();
    setTimeout(() => {
      if (!this.finished) this.fail(new GenerationError({ title: 'Génération annulée', hint: '' }, true));
    }, 8000);
  }

  private cleanup() {
    this.finished = true;
    for (const t of this.timers) clearInterval(t);
    try {
      this.ws?.close();
    } catch {
      /* déjà fermé */
    }
  }
  private succeed(r: GenResult) {
    if (this.finished) return;
    this.cleanup();
    journal.info('génération', `Vidéo reçue (${(r.blob.size / 1e6).toFixed(1)} Mo, ${Math.round(r.elapsedMs / 1000)} s)`);
    this.resolveFn(r);
  }
  private fail(e: GenerationError) {
    if (this.finished) return;
    this.cleanup();
    if (!e.cancelled) journal.error('génération', `${e.readable.title}${e.readable.detail ? ' — ' + e.readable.detail : ''}`);
    if (this.uploaded.length) void this.input.client.deleteFiles(this.uploaded).catch(() => undefined);
    this.rejectFn(e);
  }
}

export { HttpError };
