// Galerie de session : vidéos gardées UNIQUEMENT en mémoire (Blob URLs), jamais envoyées ailleurs.
// Elles disparaissent à la fermeture de l'onglet ; « Télécharger » permet de les garder.
import type { GenParams } from '../workflows/build.ts';

export interface GalleryItem {
  id: string;
  createdAt: number;
  kind: 'generated' | 'assembled';
  modelId: string;
  modelLabel: string;
  params: Omit<GenParams, 'startImage' | 'endImage' | 'outputPrefix'>;
  seed: number;
  blob: Blob;
  url: string;
  thumbUrl: string | null;
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
  elapsedMs: number;
  startImage?: Blob | null;
  endImage?: Blob | null;
  parentId?: string;
}

type Listener = () => void;

export class Gallery {
  private items: GalleryItem[] = [];
  timeline: string[] = [];
  private listeners = new Set<Listener>();
  private seq = 0;

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const l of this.listeners) l();
  }

  list(): readonly GalleryItem[] {
    return this.items;
  }
  get(id: string): GalleryItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  add(item: Omit<GalleryItem, 'id' | 'url' | 'createdAt'> & { thumb?: Blob | null }): GalleryItem {
    const { thumb, ...rest } = item;
    const full: GalleryItem = {
      ...rest,
      id: `v${++this.seq}`,
      createdAt: Date.now(),
      url: URL.createObjectURL(item.blob),
      thumbUrl: thumb ? URL.createObjectURL(thumb) : null,
    };
    this.items.unshift(full);
    if (full.kind === 'generated') {
      // Une prolongation se place juste après sa vidéo d'origine dans la timeline.
      const idx = full.parentId ? this.timeline.indexOf(full.parentId) : -1;
      if (idx >= 0) this.timeline.splice(idx + 1, 0, full.id);
      else this.timeline.push(full.id);
    }
    this.emit();
    return full;
  }

  remove(id: string): void {
    const it = this.get(id);
    if (!it) return;
    URL.revokeObjectURL(it.url);
    if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl);
    this.items = this.items.filter((i) => i.id !== id);
    this.timeline = this.timeline.filter((t) => t !== id);
    this.emit();
  }

  inTimeline(id: string): boolean {
    return this.timeline.includes(id);
  }
  toggleTimeline(id: string): void {
    if (this.inTimeline(id)) this.timeline = this.timeline.filter((t) => t !== id);
    else this.timeline.push(id);
    this.emit();
  }
  move(id: string, delta: number): void {
    const i = this.timeline.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.timeline.length) return;
    const t = [...this.timeline];
    [t[i], t[j]] = [t[j], t[i]];
    this.timeline = t;
    this.emit();
  }
  timelineItems(): GalleryItem[] {
    return this.timeline.map((id) => this.get(id)).filter((x): x is GalleryItem => !!x);
  }
  clear(): void {
    for (const i of [...this.items]) this.remove(i.id);
  }
}

export const gallery = new Gallery();
