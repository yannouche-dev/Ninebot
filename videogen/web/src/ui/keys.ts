// Écrans « Déverrouiller » et « Clés » : saisie, test, chiffrement, verrouillage, effacement.
import { h, replace, toast } from './dom.ts';
import { confirmDialog } from './dialog.ts';
import { app, BUILD } from './context.ts';
import { vault, type Secrets } from '../core/vault.ts';
import { journal, registerSecret } from '../core/journal.ts';
import { requestJson, HttpError } from '../core/http.ts';
import { VastApi } from '../vast/api.ts';

function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('small', { class: 'hint' }, hint) : null);
}

function secretInput(id: string, value: string, placeholder: string): HTMLInputElement {
  return h('input', {
    id,
    type: 'password',
    value,
    placeholder,
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    class: 'input',
  }) as HTMLInputElement;
}

function revealToggle(input: HTMLInputElement): HTMLElement {
  const b = h('button', { type: 'button', class: 'btn btn-small' }, 'Afficher');
  b.addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    b.textContent = input.type === 'password' ? 'Afficher' : 'Masquer';
  });
  return b;
}

export async function testVastKey(proxyUrl: string, key: string): Promise<string> {
  const api = new VastApi(proxyUrl, () => key);
  const u = await api.currentUser();
  const credit = typeof u.credit === 'number' ? u.credit : u.balance;
  return `OK — compte ${u.email ?? u.username ?? u.id ?? '?'}${typeof credit === 'number' ? `, crédit ${credit.toFixed(2)} $` : ''}`;
}

export async function testHfToken(token: string): Promise<string> {
  const me = await requestJson<{ name?: string; auth?: { accessToken?: { role?: string; displayName?: string } } }>(`${BUILD.hfBase}/api/whoami-v2`, {
    cat: 'hf',
    headers: { Authorization: `Bearer ${token}` },
  });
  let gated = '';
  try {
    await requestJson(`${BUILD.hfBase}/api/models/Lightricks/LTX-2.5/auth-check`, { cat: 'hf', headers: { Authorization: `Bearer ${token}` }, silentStatuses: [401, 403, 404] });
    gated = ' · accès à Lightricks/LTX-2.5 : OK';
  } catch (e) {
    if (e instanceof HttpError && (e.status === 401 || e.status === 403)) gated = ' · ⚠ licence Lightricks/LTX-2.5 à accepter sur huggingface.co';
    else gated = ' · accès LTX-2.5 non vérifiable depuis le navigateur (sera vérifié par l’instance)';
  }
  return `OK — ${me.name ?? '?'} (token ${me.auth?.accessToken?.role ?? '?'})${gated}`;
}

/** Écran affiché quand un coffre chiffré existe mais est verrouillé. */
export function renderUnlock(root: HTMLElement, onDone: () => void): void {
  const pass = h('input', { type: 'password', class: 'input', id: 'unlock-pass', autocomplete: 'current-password', placeholder: 'Phrase de passe' }) as HTMLInputElement;
  const msg = h('p', { class: 'msg', role: 'alert' });
  const btn = h('button', { class: 'btn btn-primary btn-big', type: 'submit', 'data-testid': 'unlock' }, 'Déverrouiller');
  const form = h(
    'form',
    { class: 'card' },
    h('h1', null, 'Déverrouiller'),
    h('p', null, 'Tes clés sont chiffrées dans ce navigateur. Saisis ta phrase de passe pour ouvrir la session.'),
    field('Phrase de passe', pass),
    msg,
    btn,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    msg.textContent = 'Vérification…';
    try {
      const ok = await vault.unlock(pass.value);
      if (ok) onDone();
      else msg.textContent = 'Phrase de passe incorrecte.';
    } catch (err) {
      msg.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      btn.disabled = false;
      pass.value = '';
    }
  });
  const wipe = h('button', { class: 'btn btn-danger', type: 'button' }, 'Tout effacer (phrase oubliée)');
  wipe.addEventListener('click', async () => {
    if (await confirmDialog({ title: 'Tout effacer ?', body: ['Les clés chiffrées, réglages et préréglages de ce navigateur seront supprimés. Tes instances Vast ne sont pas touchées.'], ok: 'Tout effacer', danger: true })) {
      vault.wipe();
      onDone();
    }
  });
  replace(root, form, h('div', { class: 'card' }, wipe));
  pass.focus();
}

/** Écran « Clés ». */
export function renderKeys(root: HTMLElement, onSaved: () => void): void {
  const unlocked = vault.isUnlocked();
  const cur: Secrets = unlocked ? vault.secrets : {};
  const proxy = h('input', { id: 'proxy-url', class: 'input', type: 'url', value: app.settings.proxyUrl, placeholder: 'https://videogen-vast-proxy.xxx.workers.dev', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const vastKey = secretInput('vast-key', cur.vastKey ?? '', 'Clé API Vast.ai');
  const hfToken = secretInput('hf-token', cur.hfToken ?? '', 'hf_…');
  const vastRes = h('p', { class: 'msg', 'data-testid': 'vast-test' });
  const hfRes = h('p', { class: 'msg', 'data-testid': 'hf-test' });
  const pass = h('input', { id: 'new-pass', type: 'password', class: 'input', autocomplete: 'new-password', placeholder: unlocked ? '(inchangée si vide)' : 'Au moins 8 caractères' }) as HTMLInputElement;
  const remember = h('input', { id: 'remember', type: 'checkbox', checked: unlocked ? vault.isRemembered() : true }) as HTMLInputElement;
  const msg = h('p', { class: 'msg', role: 'alert' });

  const testVast = h('button', { type: 'button', class: 'btn', 'data-testid': 'test-vast' }, 'Tester');
  testVast.addEventListener('click', async () => {
    vastRes.className = 'msg';
    vastRes.textContent = 'Test en cours…';
    registerSecret(vastKey.value.trim(), 'vast');
    try {
      if (!proxy.value.trim()) throw new Error('Renseigne d’abord l’URL du proxy (Worker)');
      vastRes.textContent = await testVastKey(proxy.value.trim(), vastKey.value.trim());
      vastRes.className = 'msg ok';
    } catch (e) {
      vastRes.className = 'msg err';
      vastRes.textContent = e instanceof HttpError && e.status === 401 ? 'Clé refusée par Vast (401)' : e instanceof HttpError && e.status === 403 ? 'Proxy : origine refusée (403) — vérifie ALLOWED_ORIGIN du Worker' : `Échec : ${e instanceof Error ? e.message : e}`;
    }
  });
  const testHf = h('button', { type: 'button', class: 'btn', 'data-testid': 'test-hf' }, 'Tester');
  testHf.addEventListener('click', async () => {
    hfRes.className = 'msg';
    hfRes.textContent = 'Test en cours…';
    registerSecret(hfToken.value.trim(), 'hf');
    try {
      hfRes.textContent = await testHfToken(hfToken.value.trim());
      hfRes.className = 'msg ok';
    } catch (e) {
      hfRes.className = 'msg err';
      hfRes.textContent =
        e instanceof HttpError && e.status === 401
          ? 'Token refusé par Hugging Face (401)'
          : e instanceof HttpError && e.kind === 'network'
            ? 'huggingface.co injoignable depuis le navigateur (réseau ou CORS) : le token sera vérifié par l’instance au démarrage.'
            : `Échec : ${e instanceof Error ? e.message : e}`;
    }
  });

  const save = h('button', { type: 'submit', class: 'btn btn-primary btn-big', 'data-testid': 'save-keys' }, 'Enregistrer');
  const form = h(
    'form',
    { class: 'card', autocomplete: 'off' },
    h('h1', null, 'Clés'),
    h('p', { class: 'hint' }, 'Les clés restent dans ce navigateur, chiffrées (AES-GCM, clé dérivée de ta phrase de passe). Elles ne sont envoyées qu’à Vast (via ton proxy) et à Hugging Face.'),
    field('URL du proxy Vast (Cloudflare Worker)', proxy, 'Affichée à la fin du déploiement du Worker (voir README).'),
    field('Clé API Vast.ai', h('div', { class: 'row' }, vastKey, revealToggle(vastKey), testVast), 'Conseil : une clé restreinte (instances + lecture du compte).'),
    vastRes,
    field('Token Hugging Face', h('div', { class: 'row' }, hfToken, revealToggle(hfToken), testHf), 'Lecture + dépôts protégés (licence LTX-2.5 acceptée).'),
    hfRes,
    field(unlocked ? 'Nouvelle phrase de passe' : 'Phrase de passe', pass),
    h('label', { class: 'check' }, remember, ' Mémoriser dans ce navigateur (chiffré). Décoché : clés gardées en mémoire seulement.'),
    msg,
    save,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.textContent = '';
    const url = proxy.value.trim().replace(/\/+$/, '');
    if (url && !/^https:\/\//.test(url) && !BUILD.test) {
      msg.textContent = 'L’URL du proxy doit commencer par https://';
      return;
    }
    app.saveSettings({ proxyUrl: url });
    const data: Secrets = { vastKey: vastKey.value.trim(), hfToken: hfToken.value.trim() };
    try {
      if (unlocked && !pass.value && remember.checked === vault.isRemembered()) {
        await vault.update(data);
      } else {
        if (!pass.value) throw new Error('Choisis une phrase de passe (8 caractères minimum).');
        await vault.create(pass.value, { ...data, comfyTokens: unlocked ? vault.secrets.comfyTokens : {} }, remember.checked);
      }
      toast('Clés enregistrées', 'ok');
      journal.info('clés', 'Clés enregistrées');
      onSaved();
    } catch (err) {
      msg.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      pass.value = '';
    }
  });

  const lock = h('button', { type: 'button', class: 'btn', disabled: !unlocked || !vault.isRemembered() }, 'Verrouiller');
  lock.addEventListener('click', () => {
    vault.lock();
    onSaved();
  });
  const wipe = h('button', { type: 'button', class: 'btn btn-danger', 'data-testid': 'wipe' }, 'Tout effacer');
  wipe.addEventListener('click', async () => {
    if (await confirmDialog({ title: 'Tout effacer ?', body: ['Clés, réglages et préréglages de ce navigateur seront supprimés. Les instances Vast ne sont pas touchées : pense à les arrêter.'], ok: 'Tout effacer', danger: true })) {
      vault.wipe();
      app.gallery.clear();
      onSaved();
    }
  });
  replace(root, form, h('div', { class: 'card row-wrap' }, lock, wipe), h('p', { class: 'hint center' }, `Version ${BUILD.ref.slice(0, 7)} · ${BUILD.builtAt.slice(0, 10)}`));
}
