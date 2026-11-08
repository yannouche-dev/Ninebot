// Coffre des secrets : clé API Vast, token Hugging Face, jetons d'accès ComfyUI par instance.
// Chiffré avec WebCrypto : AES-GCM 256 bits, clé dérivée par PBKDF2-SHA256 (600 000 itérations)
// d'une phrase de passe saisie à chaque ouverture de session. La clé dérivée n'est pas exportable
// et ne vit qu'en mémoire. Option « ne pas mémoriser » : rien n'est écrit dans localStorage.
import { registerSecret, journal } from './journal.ts';

export interface Secrets {
  vastKey?: string;
  hfToken?: string;
  /** Jeton d'accès ComfyUI par identifiant d'instance Vast. */
  comfyTokens?: Record<string, string>;
}

interface Stored {
  v: 1;
  kdf: 'PBKDF2-SHA256';
  iter: number;
  salt: string;
  iv: string;
  ct: string;
}

export const VAULT_KEY = 'videogen.vault.v1';
const ITERATIONS = 600_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iter: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Génère un jeton aléatoire (base64url) de `bytes` octets avec crypto.getRandomValues. */
export function randomToken(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return b64(a).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type Listener = () => void;

export class Vault {
  private key: CryptoKey | null = null;
  private salt: Uint8Array<ArrayBuffer> | null = null;
  private data: Secrets | null = null;
  private remember = true;
  private listeners = new Set<Listener>();

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const l of this.listeners) l();
  }

  /** Un coffre chiffré est-il présent dans ce navigateur ? */
  hasStored(): boolean {
    return !!storage()?.getItem(VAULT_KEY);
  }
  isUnlocked(): boolean {
    return this.data !== null;
  }
  isRemembered(): boolean {
    return this.remember;
  }
  get secrets(): Readonly<Secrets> {
    if (!this.data) throw new Error('Coffre verrouillé');
    return this.data;
  }

  /** Crée un nouveau coffre (remplace l'existant). */
  async create(passphrase: string, data: Secrets, remember: boolean): Promise<void> {
    if (passphrase.length < 8) throw new Error('Phrase de passe trop courte (8 caractères minimum)');
    this.salt = crypto.getRandomValues(new Uint8Array(16));
    this.key = await deriveKey(passphrase, this.salt, ITERATIONS);
    this.data = { ...data, comfyTokens: { ...(data.comfyTokens ?? {}) } };
    this.remember = remember;
    this.registerAll();
    if (!remember) storage()?.removeItem(VAULT_KEY);
    await this.persist();
    journal.info('clés', remember ? 'Coffre chiffré créé (mémorisé dans ce navigateur)' : 'Clés gardées en mémoire uniquement');
    this.emit();
  }

  /** Déverrouille le coffre stocké. Retourne false si la phrase de passe est fausse. */
  async unlock(passphrase: string): Promise<boolean> {
    const raw = storage()?.getItem(VAULT_KEY);
    if (!raw) throw new Error('Aucun coffre enregistré');
    const st = JSON.parse(raw) as Stored;
    const salt = unb64(st.salt);
    const key = await deriveKey(passphrase, salt, st.iter);
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(st.iv) }, key, unb64(st.ct));
      this.data = JSON.parse(dec.decode(pt)) as Secrets;
    } catch {
      journal.warn('clés', 'Déverrouillage refusé : phrase de passe incorrecte');
      return false;
    }
    this.key = key;
    this.salt = salt;
    this.remember = true;
    this.data.comfyTokens ??= {};
    this.registerAll();
    journal.info('clés', 'Coffre déverrouillé');
    this.emit();
    return true;
  }

  /** Modifie des secrets et ré-enregistre (nouveau vecteur d'initialisation à chaque écriture). */
  async update(patch: Partial<Secrets>): Promise<void> {
    if (!this.data) throw new Error('Coffre verrouillé');
    this.data = { ...this.data, ...patch, comfyTokens: { ...(this.data.comfyTokens ?? {}), ...(patch.comfyTokens ?? {}) } };
    this.registerAll();
    await this.persist();
    this.emit();
  }

  async setComfyToken(instanceId: string | number, token: string | null): Promise<void> {
    if (!this.data) throw new Error('Coffre verrouillé');
    const tokens = { ...(this.data.comfyTokens ?? {}) };
    if (token) tokens[String(instanceId)] = token;
    else delete tokens[String(instanceId)];
    this.data = { ...this.data, comfyTokens: tokens };
    this.registerAll();
    await this.persist();
    this.emit();
  }

  /** Verrouille : oublie la clé dérivée et les secrets en mémoire. */
  lock(): void {
    this.key = null;
    this.data = null;
    journal.info('clés', 'Coffre verrouillé');
    this.emit();
  }

  /** Efface tout : coffre chiffré, réglages, préréglages, état local. */
  wipe(): void {
    const st = storage();
    if (st) {
      const keys: string[] = [];
      for (let i = 0; i < st.length; i++) {
        const k = st.key(i);
        if (k && k.startsWith('videogen.')) keys.push(k);
      }
      for (const k of keys) st.removeItem(k);
    }
    this.key = null;
    this.data = null;
    journal.forgetSecrets();
    journal.info('clés', 'Toutes les données locales ont été effacées');
    this.emit();
  }

  private registerAll() {
    if (!this.data) return;
    registerSecret(this.data.vastKey, 'vast');
    registerSecret(this.data.hfToken, 'hf');
    for (const t of Object.values(this.data.comfyTokens ?? {})) registerSecret(t, 'comfy');
  }

  private async persist(): Promise<void> {
    if (!this.remember || !this.key || !this.salt || !this.data) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, enc.encode(JSON.stringify(this.data))));
    const st: Stored = { v: 1, kdf: 'PBKDF2-SHA256', iter: ITERATIONS, salt: b64(this.salt), iv: b64(iv), ct: b64(ct) };
    storage()?.setItem(VAULT_KEY, JSON.stringify(st));
  }
}

export const vault = new Vault();
