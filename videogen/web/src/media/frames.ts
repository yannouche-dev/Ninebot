// Extraction d'images d'une vidéo dans le navigateur (dernière image pour « Prolonger », miniature).
// Méthode 1 : <video> + canvas (rapide). Méthode 2 (repli) : ffmpeg.wasm, plus fiable sur Safari iOS.
import { journal } from '../core/journal.ts';
import { lastFrameFFmpeg } from './ffmpeg.ts';

export interface VideoMeta {
  duration: number;
  width: number;
  height: number;
}

function once<T extends keyof HTMLVideoElementEventMap>(el: HTMLVideoElement, ev: T, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      reject(new Error(`délai dépassé (${ev})`));
    }, timeoutMs);
    const ok = () => {
      cleanup();
      resolve();
    };
    const ko = () => {
      cleanup();
      reject(new Error('vidéo illisible par le navigateur'));
    };
    const cleanup = () => {
      clearTimeout(t);
      el.removeEventListener(ev, ok);
      el.removeEventListener('error', ko);
    };
    el.addEventListener(ev, ok);
    el.addEventListener('error', ko);
  });
}

async function withVideo<T>(blob: Blob, fn: (v: HTMLVideoElement) => Promise<T>): Promise<T> {
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = url;
  try {
    v.load();
    await once(v, 'loadeddata', 15000);
    return await fn(v);
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}

async function seek(v: HTMLVideoElement, t: number): Promise<void> {
  const p = once(v, 'seeked', 10000);
  v.currentTime = t;
  await p;
  // Safari peut peindre une image périmée juste après « seeked » : attendre une image décodée.
  const rvfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
  if (rvfc) await Promise.race([new Promise<void>((r) => rvfc.call(v, () => r())), new Promise((r) => setTimeout(r, 300))]);
  else await new Promise((r) => setTimeout(r, 150));
}

function grab(v: HTMLVideoElement, maxSide?: number, type = 'image/png', quality?: number): Promise<Blob> {
  let w = v.videoWidth;
  let h = v.videoHeight;
  if (!w || !h) throw new Error('dimensions vidéo inconnues');
  if (maxSide && Math.max(w, h) > maxSide) {
    const k = maxSide / Math.max(w, h);
    w = Math.round(w * k);
    h = Math.round(h * k);
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('canvas indisponible');
  ctx.drawImage(v, 0, 0, w, h);
  // Image entièrement noire = capture ratée (bug connu de certains navigateurs mobiles).
  const px = ctx.getImageData(0, 0, Math.min(w, 32), Math.min(h, 32)).data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
  if (sum === 0 && !maxSide) throw new Error('capture noire');
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob a échoué'))), type, quality));
}

export async function videoMeta(blob: Blob): Promise<VideoMeta> {
  return withVideo(blob, async (v) => ({ duration: Number.isFinite(v.duration) ? v.duration : 0, width: v.videoWidth, height: v.videoHeight }));
}

/** Miniature JPEG (vers 0,5 s). */
export async function thumbnail(blob: Blob): Promise<Blob | null> {
  try {
    return await withVideo(blob, async (v) => {
      const d = Number.isFinite(v.duration) ? v.duration : 1;
      await seek(v, Math.min(0.5, d / 2));
      return grab(v, 320, 'image/jpeg', 0.8);
    });
  } catch (e) {
    journal.debug('média', 'Miniature impossible', e instanceof Error ? e.message : e);
    return null;
  }
}

/** Dernière image (PNG) pour enchaîner une prolongation en image → vidéo. */
export async function lastFrame(blob: Blob, onStatus?: (t: string) => void): Promise<Blob> {
  try {
    const png = await withVideo(blob, async (v) => {
      const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      if (!d) throw new Error('durée inconnue');
      const fps = 24;
      await seek(v, Math.max(0, d - 1 / fps / 2 - 0.02));
      return grab(v);
    });
    journal.info('média', 'Dernière image extraite (vidéo + canvas)');
    return png;
  } catch (e) {
    journal.warn('média', 'Extraction par le navigateur impossible, repli sur ffmpeg.wasm', e instanceof Error ? e.message : e);
    const png = await lastFrameFFmpeg(blob, onStatus);
    journal.info('média', 'Dernière image extraite (ffmpeg.wasm)');
    return png;
  }
}
