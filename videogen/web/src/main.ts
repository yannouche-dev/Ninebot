// Point d'entrée : coque de l'application (en-tête, bandeau de coût, onglets), garde anti-iframe,
// déverrouillage du coffre, rappel avant fermeture si l'instance est allumée.
import './styles.css';
import { h, replace, fmtDuration, fmtMoney, toast } from './ui/dom.ts';
import { app, BUILD, type Route } from './ui/context.ts';
import { vault } from './core/vault.ts';
import { journal } from './core/journal.ts';
import { renderKeys, renderUnlock } from './ui/keys.ts';
import { InstanceScreen } from './ui/instance.ts';
import { GenerateScreen } from './ui/generate.ts';
import { GalleryScreen } from './ui/gallery.ts';
import { JournalScreen } from './ui/journal.ts';
import { confirmDialog } from './ui/dialog.ts';

const root = document.getElementById('app')!;

// Protection contre l'intégration dans une page tierce (clickjacking) : la directive CSP
// frame-ancestors n'est pas utilisable dans une balise <meta>.
if (window.top !== window.self) {
  replace(root, h('p', { class: 'card msg err' }, 'Cette application refuse de s’exécuter dans un cadre (iframe).'));
  throw new Error('iframe refusée');
}

const TABS: [Route, string][] = [
  ['instance', 'Instance'],
  ['generate', 'Générer'],
  ['gallery', 'Galerie'],
  ['journal', 'Journal'],
  ['keys', 'Clés'],
];

const banner = h('div', { class: 'cost-banner hidden', role: 'status', 'data-testid': 'cost-banner' });
const lockBtn = h('button', { type: 'button', class: 'btn btn-small', 'data-testid': 'lock' }, 'Verrouiller');
const header = h('header', { class: 'topbar' }, h('span', { class: 'brand' }, 'Videogen'), lockBtn);
const main = h('main', { class: 'content' });
const nav = h('nav', { class: 'tabs', 'aria-label': 'Navigation' });
const keysBox = h('div', { class: 'screen' });

let screens: Record<Exclude<Route, 'keys'>, { el: HTMLElement }> | null = null;

function renderNav() {
  replace(
    nav,
    ...TABS.map(([r, label]) =>
      h('button', { type: 'button', class: `tab ${app.route === r ? 'active' : ''}`, 'aria-current': app.route === r ? 'page' : undefined, 'data-testid': `tab-${r}`, on: { click: () => app.navigate(r) } }, label),
    ),
  );
}

function show() {
  renderNav();
  if (!vault.isUnlocked() && vault.hasStored()) {
    replace(main, keysBox);
    renderUnlock(keysBox, afterUnlock);
    nav.classList.add('hidden');
    lockBtn.classList.add('hidden');
    return;
  }
  nav.classList.remove('hidden');
  lockBtn.classList.toggle('hidden', !vault.isUnlocked() || !vault.isRemembered());
  if (!vault.isUnlocked() || app.route === 'keys') {
    if (app.route !== 'keys') app.route = 'keys';
    renderNav();
    renderKeys(keysBox, afterUnlock);
    replace(main, keysBox);
    return;
  }
  screens ??= {
    instance: new InstanceScreen(),
    generate: new GenerateScreen(),
    gallery: new GalleryScreen(),
    journal: new JournalScreen(),
  };
  replace(main, screens[app.route as Exclude<Route, 'keys'>].el);
  window.scrollTo(0, 0);
}

let discovered = false;
function afterUnlock() {
  app.emit('vault');
  if (vault.isUnlocked() && app.vastReady() && !discovered) {
    discovered = true;
    if (app.route === 'keys') app.route = 'instance';
    void app.manager.discover().catch(() => undefined);
    void app.manager.refreshCredit();
  }
  if (!vault.isUnlocked()) discovered = false;
  show();
}

lockBtn.addEventListener('click', async () => {
  if (app.manager.state.runningSince && !(await confirmDialog({ title: 'Verrouiller ?', body: ['L’instance reste allumée (et facturée). Le suivi reprendra après déverrouillage.'], ok: 'Verrouiller' }))) return;
  vault.lock();
  show();
});

app.on((w) => {
  if (w === 'route') show();
});

// Bandeau de coût permanent quand une instance tourne.
function updateBanner() {
  const s = app.manager.state;
  const cost = app.manager.sessionCost();
  const on = !!cost && ['starting', 'booting', 'ready', 'error'].includes(s.phase);
  banner.classList.toggle('hidden', !on);
  if (!on || !cost) return;
  replace(
    banner,
    h('span', { class: 'dot', 'aria-hidden': 'true' }),
    h('span', null, `Instance allumée · ${fmtDuration(cost.hours * 3600000)} · ≈ ${fmtMoney(cost.cost)} (${cost.dph.toFixed(2).replace('.', ',')} $/h)`),
    h('button', { type: 'button', class: 'btn btn-small', on: { click: () => app.navigate('instance') } }, 'Gérer'),
  );
}
setInterval(updateBanner, 1000);
app.manager.onChange(() => {
  updateBanner();
  if (app.manager.state.phase === 'ready') void app.refreshAvailability().catch((e) => journal.warn('modèles', 'Lecture de /object_info impossible', e));
  else if (!app.manager.comfy) app.invalidateAvailability();
});
setInterval(() => {
  if (vault.isUnlocked() && app.vastReady()) void app.manager.refreshCredit();
}, 5 * 60000);

// Rappel avant de fermer l'onglet si l'instance est encore allumée.
window.addEventListener('beforeunload', (e) => {
  if (app.manager.state.runningSince && ['starting', 'booting', 'ready'].includes(app.manager.state.phase)) {
    e.preventDefault();
    e.returnValue = '';
  }
});

window.addEventListener('unhandledrejection', (e) => {
  journal.error('app', 'Erreur non gérée', e.reason instanceof Error ? `${e.reason.name}: ${e.reason.message}` : String(e.reason));
});
window.addEventListener('error', (e) => journal.error('app', 'Erreur JavaScript', `${e.message} (${e.filename}:${e.lineno})`));

replace(root, header, banner, main, nav);
journal.info('app', `Videogen ${BUILD.ref.slice(0, 7)} démarré`);
app.loadRegistry().catch((e) => {
  journal.error('modèles', 'Chargement de models.json impossible', e);
  toast('Chargement des modèles impossible', 'error');
});
vault.onChange(() => app.emit('vault'));
afterUnlock();
