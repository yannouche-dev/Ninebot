// Écran « Instance » : démarrer (redémarrer ou louer une offre choisie), suivi du démarrage, statut,
// coût, arrêter, détruire, réglages de location.
import { h, replace, toast, fmtDuration, fmtMoney, fmtBytes } from './dom.ts';
import { confirmDialog } from './dialog.ts';
import { app } from './context.ts';
import { journal } from '../core/journal.ts';
import { GPU_5090, GPU_PRO6000, type Settings } from '../core/settings.ts';
import type { VastOffer } from '../vast/api.ts';
import { formatPrice, reliabilityOf } from '../vast/offers.ts';
import type { ManagerState } from '../vast/manager.ts';
import { explainError } from '../comfy/errors.ts';

const PHASE_LABEL: Record<string, string> = {
  idle: 'Aucune instance',
  renting: 'Location…',
  starting: 'Démarrage',
  booting: 'Installation',
  ready: 'Prête',
  stopping: 'Arrêt…',
  stopped: 'Arrêtée',
  error: 'Erreur',
};

export class InstanceScreen {
  el = h('div', { class: 'screen' });
  private status = h('section', { class: 'card', 'data-testid': 'instance-status' });
  private steps = h('ol', { class: 'steps', 'data-testid': 'boot-steps' });
  private actions = h('div', { class: 'actions' });
  private offersBox = h('section', { class: 'offers' });
  private settingsBox = h('details', { class: 'card' });
  private busy = false;

  constructor() {
    this.el.append(this.status, h('section', { class: 'card' }, h('h2', null, 'Démarrage'), this.steps), this.actions, this.offersBox, this.settingsBox);
    app.manager.onChange(() => this.update());
    app.on((w) => {
      if (w === 'settings' || w === 'vault') this.update();
    });
    this.renderSettings();
    this.update();
  }

  update(): void {
    const s = app.manager.state;
    this.renderStatus(s);
    this.renderSteps(s);
    this.renderActions(s);
  }

  private renderStatus(s: ManagerState) {
    const i = s.instance;
    const cost = app.manager.sessionCost();
    const rows: [string, string][] = [];
    if (i) {
      rows.push(['Instance', `#${i.id}${i.geolocation ? ' · ' + i.geolocation : ''}`]);
      rows.push(['GPU', `${i.num_gpus ?? 1}× ${i.gpu_name ?? '?'}`]);
      rows.push(['État Vast', `${i.actual_status ?? '?'}${i.status_msg ? ' — ' + i.status_msg : ''}`]);
      if (typeof i.dph_total === 'number') rows.push(['Prix', formatPrice(i.dph_total)]);
      if (cost) {
        rows.push(['Allumée depuis', fmtDuration(cost.hours * 3600000)]);
        rows.push(['Coût estimé (session)', fmtMoney(cost.cost)]);
      }
      if (s.phase === 'stopped' && typeof i.storage_cost === 'number' && i.disk_space) {
        rows.push(['Stockage (arrêtée)', `≈ ${fmtMoney((i.storage_cost * i.disk_space) / 30)} / jour`]);
      }
    }
    if (s.credit !== null) rows.push(['Crédit Vast restant', fmtMoney(s.credit)]);
    const wd = s.agent?.watchdog;
    if (wd?.stop_at && s.phase === 'ready') {
      const left = wd.stop_at * 1000 - Date.now();
      rows.push(['Arrêt automatique', left > 0 ? `dans ${fmtDuration(left)} (${wd.idle_since ? 'inactivité' : 'durée max.'})` : 'imminent']);
    }
    if (s.agent?.disk) rows.push(['Disque libre', fmtBytes(s.agent.disk.free_bytes)]);
    replace(
      this.status,
      h('div', { class: 'status-head' }, h('span', { class: `badge badge-${s.phase}`, 'data-testid': 'phase' }, PHASE_LABEL[s.phase] ?? s.phase), h('span', { class: 'status-msg' }, s.message)),
      s.autoStop ? h('p', { class: 'msg warn' }, `Arrêt automatique : ${s.autoStop}`) : null,
      rows.length ? h('dl', { class: 'kv' }, ...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])) : null,
    );
  }

  private renderSteps(s: ManagerState) {
    replace(
      this.steps,
      ...s.steps.map((st) =>
        h(
          'li',
          { class: `step step-${st.state}`, 'data-step': st.id },
          h('span', { class: 'step-icon', 'aria-hidden': 'true' }, st.state === 'done' ? '✓' : st.state === 'error' ? '✕' : st.state === 'running' ? '…' : '○'),
          h('span', { class: 'step-label' }, st.label),
          st.detail ? h('small', { class: 'step-detail' }, st.detail) : null,
          typeof st.progress === 'number' ? h('progress', { max: 1, value: st.progress }) : null,
        ),
      ),
    );
    const files = s.agent?.models?.files ?? [];
    if (files.length && s.phase !== 'ready') {
      this.steps.append(
        h(
          'li',
          { class: 'step-files' },
          h(
            'details',
            null,
            h('summary', null, `Fichiers (${files.filter((f) => f.state === 'done').length}/${files.length})`),
            h('ul', null, ...files.map((f) => h('li', { class: `file file-${f.state}` }, `${f.name} — ${f.size ? fmtBytes(f.done) + ' / ' + fmtBytes(f.size) : f.state}${f.error ? ' — ' + f.error : ''}`))),
          ),
        ),
      );
    }
  }

  private renderActions(s: ManagerState) {
    const btns: HTMLElement[] = [];
    const ready = app.vastReady();
    if (!ready) {
      btns.push(h('p', { class: 'msg warn' }, 'Configure d’abord tes clés et l’URL du proxy (onglet Clés).'));
    }
    const running = ['starting', 'booting', 'ready'].includes(s.phase);
    if (!running && s.phase !== 'renting' && s.phase !== 'stopping') {
      btns.push(this.button('Démarrer', 'btn btn-primary btn-big', 'start', () => this.start(), !ready));
    }
    if (s.phase === 'ready') btns.push(this.button('Générer une vidéo →', 'btn btn-primary btn-big', 'go-generate', () => app.navigate('generate')));
    if (running || (s.phase === 'error' && s.instance)) btns.push(this.button('Arrêter (garder le disque)', 'btn btn-big', 'stop', () => this.stop(), !ready));
    if (s.instance && s.phase !== 'stopping') btns.push(this.button('Détruire l’instance', 'btn btn-danger', 'destroy', () => this.destroy(), !ready));
    btns.push(this.button('Actualiser', 'btn', 'refresh', () => this.refresh(), !ready));
    if (app.manager.comfy) btns.push(this.button('Logs de l’instance → Journal', 'btn', 'instance-logs', () => this.instanceLogs()));
    replace(this.actions, ...btns);
  }

  private button(label: string, cls: string, testid: string, fn: () => Promise<void> | void, disabled = false): HTMLButtonElement {
    const b = h('button', { type: 'button', class: cls, 'data-testid': testid, disabled: disabled || this.busy }, label) as HTMLButtonElement;
    b.addEventListener('click', async () => {
      if (this.busy) return;
      this.busy = true;
      b.disabled = true;
      try {
        await fn();
      } catch (e) {
        const r = explainError(e);
        toast(`${r.title}${r.hint ? ' — ' + r.hint : ''}`, 'error');
        journal.error('instance', r.title, r.detail ?? e);
      } finally {
        this.busy = false;
        this.update();
      }
    });
    return b;
  }

  async refresh(): Promise<void> {
    await app.manager.discover();
    void app.manager.refreshCredit();
  }

  private async start() {
    replace(this.offersBox);
    const m = app.manager;
    if (!m.state.instance) await m.discover();
    const inst = m.state.instance;
    if (inst && ['running', 'loading'].includes(inst.actual_status ?? '')) {
      m.followBoot(inst.id, false);
      return;
    }
    if (inst && inst.actual_status !== 'offline') {
      const ok = await confirmDialog({
        title: `Redémarrer l’instance #${inst.id} ?`,
        body: [`${inst.gpu_name ?? 'GPU'} · ${typeof inst.dph_total === 'number' ? formatPrice(inst.dph_total) : 'prix inconnu'}`, h('br'), 'Les modèles déjà téléchargés sont conservés sur son disque.'],
        ok: 'Redémarrer',
      });
      if (ok) await m.restart();
      return;
    }
    const offers = await m.searchOffers();
    this.renderOffers(offers);
  }

  private renderOffers(offers: VastOffer[]) {
    if (!offers.length) {
      replace(this.offersBox, h('div', { class: 'card' }, h('p', { class: 'msg warn' }, 'Aucune offre ne correspond aux réglages. Augmente le prix max ou assouplis les filtres (Réglages de location).')));
      return;
    }
    const pro = offers.filter((o) => GPU_PRO6000.includes(o.gpu_name));
    const note = pro.length ? '' : 'Aucune RTX PRO 6000 disponible : offres RTX 5090 (repli).';
    replace(
      this.offersBox,
      h('h2', null, `Offres (${offers.length})`),
      note ? h('p', { class: 'msg warn' }, note) : null,
      h('p', { class: 'hint' }, 'Touche une offre pour voir le prix et confirmer.'),
      h(
        'ul',
        { class: 'offer-list', 'data-testid': 'offers' },
        ...offers.slice(0, 30).map((o) =>
          h(
            'li',
            null,
            h(
              'button',
              { type: 'button', class: 'offer', 'data-testid': `offer-${o.id}`, on: { click: () => void this.chooseOffer(o) } },
              h('span', { class: 'offer-gpu' }, `${o.num_gpus}× ${o.gpu_name}`),
              h('span', { class: 'offer-price' }, formatPrice(o.dph_total)),
              h('span', { class: 'offer-meta' }, `${Math.round(o.inet_down)} Mb/s · fiabilité ${(reliabilityOf(o) * 100).toFixed(1)} % · ${Math.round(o.gpu_ram / 1000)} Go VRAM · ${o.geolocation ?? '?'}${o.cuda_max_good ? ' · CUDA ' + o.cuda_max_good : ''}`),
            ),
          ),
        ),
      ),
    );
  }

  private async chooseOffer(o: VastOffer) {
    const s = app.settings;
    const fams = s.families.map((f) => app.registry?.families[f]?.label ?? f).join(', ');
    const needGB = s.families.reduce((n, f) => n + (app.registry?.families[f]?.approxGB ?? 0), 0);
    const ok = await confirmDialog({
      title: 'Confirmer la location',
      body: [
        h('p', { class: 'big-price', 'data-testid': 'confirm-price' }, formatPrice(o.dph_total)),
        h(
          'ul',
          null,
          h('li', null, `${o.num_gpus}× ${o.gpu_name} · ${o.geolocation ?? ''}`),
          h('li', null, `Disque ${s.diskGB} Go (modèles : ${fams}, ≈ ${needGB} Go)`),
          h('li', null, `≈ ${fmtMoney(o.dph_total)} par heure allumée ; arrêt auto après ${s.idleMinutes} min d’inactivité ou ${s.maxHours} h`),
          h('li', null, 'Le stockage reste facturé tant que l’instance n’est pas détruite.'),
        ),
        needGB + 20 > s.diskGB ? h('p', { class: 'msg warn' }, `Disque probablement trop petit pour les modèles choisis (≈ ${needGB} Go + système).`) : null,
      ],
      ok: `Louer à ${formatPrice(o.dph_total)}`,
    });
    if (!ok) return;
    replace(this.offersBox);
    try {
      await app.manager.rent(o);
    } catch (e) {
      const r = explainError(e);
      toast(r.title, 'error');
      journal.error('instance', 'Location impossible', e);
    }
  }

  private async stop() {
    const ok = await confirmDialog({ title: 'Arrêter l’instance ?', body: ['Le GPU est libéré, le disque (et les modèles) est conservé. Le stockage reste facturé.'], ok: 'Arrêter' });
    if (ok) await app.manager.stop();
  }

  private async destroy() {
    const id = app.manager.state.instance?.id;
    const ok = await confirmDialog({
      title: `Détruire l’instance #${id} ?`,
      body: ['Le disque et les modèles téléchargés seront supprimés définitivement. Plus aucun frais ensuite.', h('br'), 'Les vidéos de la galerie (dans ce navigateur) ne sont pas touchées.'],
      ok: 'Détruire définitivement',
      danger: true,
    });
    if (ok) await app.manager.destroy();
  }

  private async instanceLogs() {
    const c = app.manager.comfy;
    if (!c) return;
    const res = await c.agentLog(300);
    journal.info('instance', `Logs de démarrage de l’instance (${res.lines.length} lignes)`, res.lines.join('\n'));
    toast('Logs ajoutés au Journal', 'ok');
  }

  private renderSettings() {
    const s = app.settings;
    const num = (key: keyof Settings, label: string, step: string, min = '0', hint?: string) => {
      const input = h('input', { class: 'input', type: 'number', step, min, value: String(s[key]), id: `set-${key}`, inputmode: 'decimal' }) as HTMLInputElement;
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) app.saveSettings({ [key]: key === 'minReliability' ? Math.min(1, v / 100) : v } as Partial<Settings>);
      });
      if (key === 'minReliability') input.value = String(Math.round(s.minReliability * 1000) / 10);
      return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('small', { class: 'hint' }, hint) : null);
    };
    const gpus = [...GPU_PRO6000, ...GPU_5090].map((g) => {
      const c = h('input', { type: 'checkbox', checked: s.gpuNames.includes(g) }) as HTMLInputElement;
      c.addEventListener('change', () => {
        const all = [...GPU_PRO6000, ...GPU_5090];
        const cur = new Set(app.settings.gpuNames);
        if (c.checked) cur.add(g);
        else cur.delete(g);
        app.saveSettings({ gpuNames: all.filter((x) => cur.has(x)) });
      });
      return h('label', { class: 'check' }, c, ` ${g}`);
    });
    const famBox = h('div', { class: 'stack' });
    const renderFams = () => {
      const reg = app.registry;
      if (!reg) return;
      replace(
        famBox,
        ...Object.entries(reg.families).map(([id, f]) => {
          const c = h('input', { type: 'checkbox', checked: app.settings.families.includes(id), 'data-testid': `family-${id}` }) as HTMLInputElement;
          c.addEventListener('change', () => {
            const cur = new Set(app.settings.families);
            if (c.checked) cur.add(id);
            else cur.delete(id);
            const fams = Object.keys(reg.families).filter((x) => cur.has(x));
            const need = fams.reduce((n, x) => n + reg.families[x].approxGB, 0) + 40;
            const patch: Partial<Settings> = { families: fams };
            if (need > app.settings.diskGB) {
              patch.diskGB = Math.ceil(need / 50) * 50;
              toast(`Disque porté à ${patch.diskGB} Go pour ces modèles`, 'info');
            }
            app.saveSettings(patch);
            this.renderSettings();
          });
          return h('label', { class: 'check' }, c, ` ${f.label} (≈ ${f.approxGB} Go)`, f.note ? h('small', { class: 'hint block' }, f.note) : null);
        }),
      );
    };
    renderFams();
    app.on((w) => w === 'registry' && renderFams());
    const text = (key: 'image' | 'comfyVersion' | 'label', label: string, hint?: string) => {
      const input = h('input', { class: 'input', value: s[key], id: `set-${key}`, spellcheck: 'false', autocapitalize: 'off' }) as HTMLInputElement;
      input.addEventListener('change', () => input.value.trim() && app.saveSettings({ [key]: input.value.trim() } as Partial<Settings>));
      return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('small', { class: 'hint' }, hint) : null);
    };
    replace(
      this.settingsBox,
      h('summary', null, 'Réglages de location'),
      h('h3', null, 'GPU acceptés'),
      h('div', { class: 'stack' }, ...gpus),
      h('small', { class: 'hint' }, 'Les RTX PRO 6000 sont proposées en premier, les RTX 5090 en repli.'),
      num('maxPrice', 'Prix max ($/h)', '0.05', '0'),
      num('minReliability', 'Fiabilité min. (%)', '0.1', '0'),
      num('minInetDown', 'Débit descendant min. (Mb/s)', '50', '0'),
      num('diskGB', 'Disque (Go)', '10', '50'),
      h('h3', null, 'Modèles à installer'),
      famBox,
      h('h3', null, 'Arrêt automatique (watchdog)'),
      num('idleMinutes', 'File vide depuis (minutes, 0 = jamais)', '1', '0'),
      num('maxHours', 'Durée max allumée (heures, 0 = jamais)', '0.5', '0'),
      h('h3', null, 'Avancé'),
      text('image', 'Image Docker', 'PyTorch CUDA 12.8+ (requis pour les GPU Blackwell).'),
      text('comfyVersion', 'Version de ComfyUI', 'Les workflows sont validés pour v0.44.2.'),
      text('label', 'Label des instances du projet'),
      num('stallMinutes', 'Abandon d’une génération sans progression (minutes)', '1', '1'),
    );
  }
}
