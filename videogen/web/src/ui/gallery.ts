// Écran « Galerie » : vidéos de la session (en mémoire), timeline réordonnable, assemblage ffmpeg.wasm.
import { h, replace, toast, download, fmtDuration } from './dom.ts';
import { confirmDialog } from './dialog.ts';
import { app } from './context.ts';
import { journal } from '../core/journal.ts';
import { concatVideos } from '../media/ffmpeg.ts';
import { thumbnail, videoMeta } from '../media/frames.ts';
import type { GalleryItem } from '../media/gallery.ts';
import { extendItem, replayItem } from './generate.ts';

export class GalleryScreen {
  el = h('div', { class: 'screen' });
  private detail = h('section', { class: 'card hidden', 'data-testid': 'item-detail' });
  private timelineBox = h('section', { class: 'card', 'data-testid': 'timeline' });
  private grid = h('section', { class: 'card' });
  private selected: string | null = null;
  private assembling = false;

  constructor() {
    this.el.append(this.detail, this.timelineBox, this.grid);
    app.gallery.onChange(() => this.render());
    this.render();
  }

  render(): void {
    const items = app.gallery.list();
    replace(
      this.grid,
      h('h2', null, `Galerie de session (${items.length})`),
      h('p', { class: 'hint' }, 'Les vidéos restent uniquement dans ce navigateur, en mémoire : télécharge celles à garder avant de fermer l’onglet.'),
      items.length
        ? h(
            'div',
            { class: 'grid', 'data-testid': 'gallery-grid' },
            ...items.map((it) =>
              h(
                'button',
                { type: 'button', class: `tile ${this.selected === it.id ? 'selected' : ''}`, 'data-testid': `tile-${it.id}`, on: { click: () => this.select(it.id) } },
                it.thumbUrl ? h('img', { src: it.thumbUrl, alt: '' }) : h('div', { class: 'tile-ph' }, '▶'),
                h('span', { class: 'tile-cap' }, `${it.id} · ${it.kind === 'assembled' ? 'assemblage' : it.modelLabel.split('·')[0]} · ${it.duration.toFixed(1)} s`),
                app.gallery.inTimeline(it.id) ? h('span', { class: 'tile-badge' }, `#${app.gallery.timeline.indexOf(it.id) + 1}`) : null,
              ),
            ),
          )
        : h('p', null, 'Aucune vidéo pour l’instant.'),
    );
    this.renderTimeline();
    if (this.selected && !app.gallery.get(this.selected)) this.selected = null;
    this.renderDetail();
  }

  private select(id: string) {
    this.selected = this.selected === id ? null : id;
    this.render();
    if (this.selected) this.detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  private renderDetail() {
    const it = this.selected ? app.gallery.get(this.selected) : undefined;
    if (!it) {
      this.detail.classList.add('hidden');
      replace(this.detail);
      return;
    }
    this.detail.classList.remove('hidden');
    const p = it.params;
    const rows: [string, string][] =
      it.kind === 'assembled'
        ? [['Type', 'Assemblage de la timeline']]
        : [
            ['Modèle', it.modelLabel],
            ['Prompt', p.prompt],
            ['Résolution', `${it.width}×${it.height} (${p.preset}, ${p.ratio})`],
            ['Durée', `${it.duration.toFixed(1)} s à ${p.fps} i/s`],
            ['Seed', String(it.seed)],
            ...(p.steps !== undefined && !p.fast ? ([['Steps / CFG', `${p.steps} / ${p.cfg ?? '-'}`]] as [string, string][]) : []),
            ['Temps de calcul', fmtDuration(it.elapsedMs)],
          ];
    replace(
      this.detail,
      h('h2', null, `Vidéo ${it.id}`),
      h('video', { src: it.url, poster: it.thumbUrl ?? undefined, controls: true, playsinline: true, loop: true, preload: 'metadata', class: 'video' }),
      h('dl', { class: 'kv' }, ...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      h(
        'div',
        { class: 'actions' },
        it.kind === 'generated' ? h('button', { type: 'button', class: 'btn', 'data-testid': 'replay', on: { click: () => replayItem(it) } }, 'Rejouer') : null,
        h('button', { type: 'button', class: 'btn', 'data-testid': 'gallery-extend', on: { click: () => void extendItem(it) } }, 'Prolonger'),
        h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => download(it.blob, `videogen_${it.id}_${it.seed || 'assemblage'}.mp4`) } }, 'Télécharger'),
        h('button', { type: 'button', class: 'btn', on: { click: () => app.gallery.toggleTimeline(it.id) } }, app.gallery.inTimeline(it.id) ? 'Retirer de la timeline' : 'Ajouter à la timeline'),
        h('button', { type: 'button', class: 'btn btn-danger', 'data-testid': 'delete-item', on: { click: () => void this.remove(it) } }, 'Supprimer'),
      ),
    );
  }

  private async remove(it: GalleryItem) {
    if (await confirmDialog({ title: `Supprimer ${it.id} ?`, body: ['La vidéo sera retirée de ce navigateur (pense à la télécharger si besoin).'], ok: 'Supprimer', danger: true })) {
      app.gallery.remove(it.id);
    }
  }

  private renderTimeline() {
    const items = app.gallery.timelineItems();
    const total = items.reduce((n, i) => n + i.duration, 0);
    const assemble = h('button', { type: 'button', class: 'btn btn-primary btn-big', disabled: items.length < 2 || this.assembling, 'data-testid': 'assemble' }, this.assembling ? 'Assemblage…' : 'Assembler');
    const status = h('p', { class: 'hint', 'data-testid': 'assemble-status' });
    const bar = h('progress', { max: 1, value: 0, class: 'hidden' }) as HTMLProgressElement;
    assemble.addEventListener('click', () => void this.assemble(items, status, bar));
    replace(
      this.timelineBox,
      h('h2', null, `Timeline (${items.length} · ${total.toFixed(1)} s)`),
      items.length
        ? h(
            'ol',
            { class: 'timeline' },
            ...items.map((it, i) =>
              h(
                'li',
                { 'data-testid': `tl-${it.id}` },
                h('span', { class: 'tl-name' }, `${it.id} · ${it.duration.toFixed(1)} s · ${it.kind === 'assembled' ? 'assemblage' : it.modelLabel.split('·')[0]}`),
                h(
                  'span',
                  { class: 'tl-btns' },
                  h('button', { type: 'button', class: 'btn btn-small', 'aria-label': 'Monter', disabled: i === 0, 'data-testid': `up-${it.id}`, on: { click: () => app.gallery.move(it.id, -1) } }, '↑'),
                  h('button', { type: 'button', class: 'btn btn-small', 'aria-label': 'Descendre', disabled: i === items.length - 1, 'data-testid': `down-${it.id}`, on: { click: () => app.gallery.move(it.id, 1) } }, '↓'),
                  h('button', { type: 'button', class: 'btn btn-small', 'aria-label': 'Retirer', on: { click: () => app.gallery.toggleTimeline(it.id) } }, '✕'),
                ),
              ),
            ),
          )
        : h('p', { class: 'hint' }, 'Les vidéos générées s’ajoutent ici ; les prolongations se placent après leur vidéo d’origine.'),
      assemble,
      bar,
      status,
    );
  }

  private async assemble(items: GalleryItem[], status: HTMLElement, bar: HTMLProgressElement) {
    if (items.length < 2) return;
    this.assembling = true;
    bar.classList.remove('hidden');
    const t0 = Date.now();
    try {
      const first = items[0];
      const blob = await concatVideos(
        items.map((i) => ({ blob: i.blob, hasAudio: i.hasAudio })),
        { width: first.width, height: first.height, fps: first.params.fps || 24 },
        (t) => (status.textContent = t),
        (p) => (bar.value = p),
      );
      const meta = await videoMeta(blob).catch(() => ({ duration: items.reduce((n, i) => n + i.duration, 0), width: first.width, height: first.height }));
      const item = app.gallery.add({
        kind: 'assembled',
        modelId: '',
        modelLabel: 'Assemblage',
        params: { ...first.params },
        seed: 0,
        blob,
        thumb: await thumbnail(blob),
        thumbUrl: null,
        width: meta.width,
        height: meta.height,
        duration: meta.duration,
        hasAudio: items.every((i) => i.hasAudio),
        elapsedMs: Date.now() - t0,
      });
      journal.info('assemblage', `Assemblage terminé : ${items.length} segments, ${meta.duration.toFixed(1)} s, ${(blob.size / 1e6).toFixed(1)} Mo`);
      toast('Assemblage prêt', 'ok');
      this.assembling = false;
      this.select(item.id);
    } catch (e) {
      journal.error('assemblage', 'Assemblage impossible', e);
      toast('Assemblage impossible (voir Journal)', 'error');
      this.assembling = false;
      this.render();
    }
  }
}
