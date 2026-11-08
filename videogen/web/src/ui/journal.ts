// Écran « Journal » : étapes, requêtes, erreurs détaillées (codes HTTP, réponses, logs de l'instance),
// toujours masquées. Bouton « Copier » pour coller le journal dans une discussion de dépannage.
import { h, replace, toast } from './dom.ts';
import { journal, type Entry } from '../core/journal.ts';
import { app, BUILD } from './context.ts';

export class JournalScreen {
  el = h('div', { class: 'screen' });
  private list = h('ol', { class: 'journal', 'data-testid': 'journal-list' });
  private onlyErrors = false;
  private showDebug = true;
  private pending = false;

  constructor() {
    const errs = h('input', { type: 'checkbox', id: 'only-errors' }) as HTMLInputElement;
    errs.addEventListener('change', () => {
      this.onlyErrors = errs.checked;
      this.render();
    });
    const dbg = h('input', { type: 'checkbox', id: 'show-debug', checked: true }) as HTMLInputElement;
    dbg.addEventListener('change', () => {
      this.showDebug = dbg.checked;
      this.render();
    });
    const copy = h('button', { type: 'button', class: 'btn btn-primary', 'data-testid': 'copy-journal' }, 'Copier');
    copy.addEventListener('click', () => void this.copy());
    const logs = h('button', { type: 'button', class: 'btn' }, 'Logs de l’instance');
    logs.addEventListener('click', async () => {
      const c = app.manager.comfy;
      if (!c) return toast('Instance non joignable', 'error');
      try {
        const r = await c.agentLog(300);
        journal.info('instance', `Logs de démarrage de l’instance (${r.lines.length} lignes)`, r.lines.join('\n'));
      } catch {
        /* journalisé */
      }
    });
    const clear = h('button', { type: 'button', class: 'btn' }, 'Vider');
    clear.addEventListener('click', () => journal.clear());
    this.el.append(
      h(
        'section',
        { class: 'card' },
        h('h1', null, 'Journal'),
        h('p', { class: 'hint' }, 'Clés et jetons sont masqués automatiquement. En cas de problème, copie le journal et colle-le dans ta demande d’aide.'),
        h('div', { class: 'row-wrap' }, copy, logs, clear),
        h('div', { class: 'row-wrap' }, h('label', { class: 'check' }, errs, ' Erreurs seulement'), h('label', { class: 'check' }, dbg, ' Détails des requêtes')),
      ),
      h('section', { class: 'card' }, this.list),
    );
    journal.subscribe(() => {
      if (this.pending) return;
      this.pending = true;
      requestAnimationFrame(() => {
        this.pending = false;
        if (app.route === 'journal') this.render();
      });
    });
    app.on((w) => w === 'route' && app.route === 'journal' && this.render());
  }

  private filter = (e: Entry) => (this.onlyErrors ? e.level === 'error' || e.level === 'warn' : this.showDebug || e.level !== 'debug');

  render(): void {
    const items = journal.entries().filter(this.filter).slice(-500);
    replace(
      this.list,
      ...items.map((e) =>
        h(
          'li',
          { class: `j j-${e.level}` },
          h('span', { class: 'j-time' }, new Date(e.ts).toLocaleTimeString('fr-FR')),
          h('span', { class: 'j-cat' }, e.cat),
          h('span', { class: 'j-msg' }, e.msg),
          e.detail ? h('pre', { class: 'j-detail' }, e.detail) : null,
        ),
      ),
    );
    this.list.lastElementChild?.scrollIntoView({ block: 'end' });
  }

  private async copy() {
    const header = `Videogen ${BUILD.ref.slice(0, 7)} (${BUILD.builtAt}) — ${navigator.userAgent}\nPhase : ${app.manager.state.phase} · instance ${app.manager.state.instance?.id ?? '-'}\n\n`;
    const text = header + journal.toText(this.filter);
    try {
      await navigator.clipboard.writeText(text);
      toast('Journal copié', 'ok');
    } catch {
      const ta = h('textarea', { class: 'input', rows: 10, readonly: true }) as HTMLTextAreaElement;
      ta.value = text;
      this.list.before(ta);
      ta.select();
      toast('Sélectionne le texte et copie-le', 'info');
    }
  }
}
