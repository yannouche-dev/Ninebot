// État partagé de l'application (réglages, gestionnaire d'instance, registre des modèles, galerie).
import { journal } from '../core/journal.ts';
import { loadSettings, saveSettings, type Settings } from '../core/settings.ts';
import { vault } from '../core/vault.ts';
import { InstanceManager } from '../vast/manager.ts';
import type { BuildInfo } from '../vast/onstart.ts';
import { checkAvailability, type ApiPrompt, type Availability, type GenParams, type ModelDef, type Registry } from '../workflows/build.ts';
import type { ObjectInfo } from '../comfy/client.ts';
import { gallery } from '../media/gallery.ts';

declare const __BUILD__: BuildInfo;
export const BUILD: BuildInfo = __BUILD__;

export type Route = 'instance' | 'generate' | 'gallery' | 'journal' | 'keys';

/** Pré-remplissage du formulaire de génération (Rejouer / Prolonger). */
export interface Prefill {
  modelId: string;
  params: Partial<Omit<GenParams, 'startImage' | 'endImage' | 'outputPrefix'>>;
  startImage?: Blob | null;
  endImage?: Blob | null;
  parentId?: string;
  note?: string;
}

type Listener = (what: string) => void;

class AppContext {
  settings: Settings = loadSettings(BUILD.proxyUrl);
  manager = new InstanceManager(BUILD, () => this.settings);
  registry: Registry | null = null;
  workflows = new Map<string, ApiPrompt>();
  objectInfo: ObjectInfo | null = null;
  availability = new Map<string, Availability>();
  gallery = gallery;
  route: Route = 'instance';
  prefill: Prefill | null = null;
  private listeners = new Set<Listener>();
  private objectInfoFor: string | null = null;

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(what: string): void {
    for (const l of this.listeners) l(what);
  }

  saveSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    saveSettings(this.settings);
    this.emit('settings');
  }

  navigate(r: Route): void {
    this.route = r;
    this.emit('route');
  }

  async loadRegistry(): Promise<void> {
    if (this.registry) return;
    const reg = (await (await fetch('models.json', { cache: 'no-cache' })).json()) as Registry;
    await Promise.all(
      reg.models.map(async (m) => {
        const wf = (await (await fetch(m.workflow, { cache: 'no-cache' })).json()) as ApiPrompt;
        this.workflows.set(m.id, wf);
      }),
    );
    this.registry = reg;
    journal.debug('modèles', `${reg.models.length} workflows chargés (ComfyUI ${reg.comfyVersion}, templates ${reg.templatesVersion})`);
    this.emit('registry');
  }

  model(id: string): ModelDef | undefined {
    return this.registry?.models.find((m) => m.id === id);
  }

  /** Interroge /object_info (une fois par URL d'instance) et calcule la disponibilité de chaque modèle. */
  async refreshAvailability(force = false): Promise<void> {
    const c = this.manager.comfy;
    if (!c || !this.registry) return;
    if (!force && this.objectInfoFor === c.base && this.objectInfo) return;
    const info = await c.objectInfo();
    this.objectInfo = info;
    this.objectInfoFor = c.base;
    for (const m of this.registry.models) {
      const av = checkAvailability(this.workflows.get(m.id)!, info, m);
      this.availability.set(m.id, av);
      if (!av.ok) journal.info('modèles', `${m.label} indisponible sur le serveur`, av);
    }
    this.emit('availability');
  }

  invalidateAvailability(): void {
    this.objectInfo = null;
    this.objectInfoFor = null;
    this.availability.clear();
    this.emit('availability');
  }

  vastReady(): boolean {
    return vault.isUnlocked() && !!vault.secrets.vastKey && !!this.settings.proxyUrl;
  }
}

export const app = new AppContext();
