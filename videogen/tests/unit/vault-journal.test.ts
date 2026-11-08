import { describe, it, expect, beforeEach } from 'vitest';
import { installStorage } from './setup-storage.ts';
import { Vault, VAULT_KEY, randomToken } from '../../web/src/core/vault.ts';
import { journal, mask, registerSecret, maskValue } from '../../web/src/core/journal.ts';

describe('coffre chiffré', () => {
  beforeEach(() => {
    installStorage();
    journal.forgetSecrets();
  });

  it('chiffre, déverrouille, refuse une mauvaise phrase', async () => {
    const v = new Vault();
    await v.create('correct horse battery', { vastKey: 'VASTKEY-abcdef0123456789', hfToken: 'hf_abcdefghijklmnop' }, true);
    const raw = localStorage.getItem(VAULT_KEY)!;
    expect(raw).not.toContain('VASTKEY');
    expect(raw).not.toContain('hf_abcdefghijklmnop');
    const st = JSON.parse(raw);
    expect(st.kdf).toBe('PBKDF2-SHA256');
    expect(st.iter).toBeGreaterThanOrEqual(600000);
    const v2 = new Vault();
    expect(await v2.unlock('mauvaise phrase')).toBe(false);
    expect(v2.isUnlocked()).toBe(false);
    expect(await v2.unlock('correct horse battery')).toBe(true);
    expect(v2.secrets.vastKey).toBe('VASTKEY-abcdef0123456789');
    await v2.setComfyToken(123, 'jeton-comfy-0123456789abcdef');
    const iv1 = JSON.parse(raw).iv;
    const iv2 = JSON.parse(localStorage.getItem(VAULT_KEY)!).iv;
    expect(iv2).not.toBe(iv1);
    v2.lock();
    expect(v2.isUnlocked()).toBe(false);
    expect(() => v2.secrets).toThrow();
  });

  it('« ne pas mémoriser » n’écrit rien et « tout effacer » vide tout', async () => {
    const v = new Vault();
    localStorage.setItem('videogen.settings.v1', '{}');
    localStorage.setItem('autre.app', 'x');
    await v.create('phrase-longue', { vastKey: 'k-0123456789' }, false);
    expect(localStorage.getItem(VAULT_KEY)).toBeNull();
    expect(v.secrets.vastKey).toBe('k-0123456789');
    v.wipe();
    expect(localStorage.getItem('videogen.settings.v1')).toBeNull();
    expect(localStorage.getItem('autre.app')).toBe('x');
  });

  it('refuse une phrase trop courte', async () => {
    await expect(new Vault().create('court', {}, true)).rejects.toThrow(/8 caractères/);
  });

  it('génère des jetons aléatoires base64url de 256 bits', () => {
    const a = randomToken(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(32)).not.toBe(a);
  });
});

describe('masquage du Journal', () => {
  beforeEach(() => journal.forgetSecrets());

  it('masque les secrets enregistrés partout (URL, en-têtes, JSON)', () => {
    const vast = 'c0ffee1234567890deadbeef1234567890abcdef1234567890abcdefa3f9';
    registerSecret(vast, 'vast');
    const s = mask(`GET https://proxy/x?api_key=${vast} Authorization: Bearer ${vast} {"k":"${vast}"}`);
    expect(s).not.toContain(vast);
    expect(s).toContain('vast_…a3f9');
  });

  it('masque les motifs sensibles même inconnus', () => {
    const s = mask(
      'wss://abc.trycloudflare.com/ws?clientId=1&token=SECRETTOKEN123456 Bearer abcdef123456789 hf_ABCDEFGHIJKLMNOP ' +
        '{"COMFY_ACCESS_TOKEN":"zzzzzzzzzzzzzzzz1234","api_key":"yyyyyyyyyyyy5678"} ["HF_TOKEN", "hf_qwertyuiopasdf"] HF_TOKEN=abcdefgh9999',
    );
    for (const secret of ['SECRETTOKEN123456', 'abcdef123456789', 'hf_ABCDEFGHIJKLMNOP', 'zzzzzzzzzzzzzzzz1234', 'yyyyyyyyyyyy5678', 'hf_qwertyuiopasdf', 'abcdefgh9999']) {
      expect(s).not.toContain(secret);
    }
    expect(s).toContain('clientId=1');
  });

  it('le Journal ne stocke que du texte masqué', () => {
    registerSecret('my-very-secret-token-xyz9', 'comfy');
    journal.info('test', 'url https://x/?token=my-very-secret-token-xyz9', { headers: { Authorization: 'Bearer my-very-secret-token-xyz9' } });
    const text = journal.toText();
    expect(text).not.toContain('my-very-secret-token-xyz9');
    expect(text).toContain('comfy_…xyz9');
  });

  it('format court', () => {
    expect(maskValue('abc')).toBe('***');
    expect(maskValue('0123456789abcdef', 'hf')).toBe('hf_…cdef');
  });
});
