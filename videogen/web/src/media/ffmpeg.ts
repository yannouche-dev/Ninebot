// ffmpeg.wasm chargé à la demande (≈ 32 Mo), depuis notre propre site (copié au build, pas de CDN).
// Version mono-thread : GitHub Pages ne permet pas les en-têtes COOP/COEP nécessaires au multi-thread.
import { journal } from '../core/journal.ts';

interface FFmpegLike {
  load(cfg: { coreURL: string; wasmURL: string }): Promise<boolean>;
  writeFile(path: string, data: Uint8Array | string): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array | string>;
  deleteFile(path: string): Promise<boolean>;
  exec(args: string[], timeout?: number): Promise<number>;
  on(event: 'log', cb: (e: { type: string; message: string }) => void): void;
  on(event: 'progress', cb: (e: { progress: number; time: number }) => void): void;
  off(event: 'progress', cb: (e: { progress: number; time: number }) => void): void;
}

let instance: Promise<FFmpegLike> | null = null;
let lastLog: string[] = [];

export function vendorUrl(rel: string): string {
  return new URL(`vendor/${rel}`, document.baseURI).href;
}

export function getFFmpeg(onStatus?: (t: string) => void): Promise<FFmpegLike> {
  if (!instance) {
    instance = (async () => {
      onStatus?.('Chargement de ffmpeg.wasm (≈ 32 Mo, une seule fois)…');
      journal.info('assemblage', 'Chargement de ffmpeg.wasm depuis le site');
      const mod = (await import(/* @vite-ignore */ vendorUrl('ffmpeg/index.js'))) as { FFmpeg: new () => FFmpegLike };
      const ff = new mod.FFmpeg();
      ff.on('log', (e) => {
        lastLog.push(e.message);
        if (lastLog.length > 200) lastLog = lastLog.slice(-200);
      });
      await ff.load({ coreURL: vendorUrl('ffmpeg-core/ffmpeg-core.js'), wasmURL: vendorUrl('ffmpeg-core/ffmpeg-core.wasm') });
      journal.info('assemblage', 'ffmpeg.wasm prêt');
      return ff;
    })().catch((e) => {
      instance = null;
      journal.error('assemblage', 'Chargement de ffmpeg.wasm impossible', e);
      throw e;
    });
  }
  return instance;
}

async function bytes(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer());
}

async function run(ff: FFmpegLike, args: string[]): Promise<void> {
  lastLog = [];
  const code = await ff.exec(args);
  if (code !== 0) {
    const tail = lastLog.slice(-15).join('\n');
    journal.error('assemblage', `ffmpeg a échoué (code ${code})`, `ffmpeg ${args.join(' ')}\n${tail}`);
    throw new Error(`ffmpeg a échoué (code ${code})`);
  }
}

/**
 * Assemble des segments vidéo dans l'ordre. Essaie d'abord sans ré-encodage (concat, -c copy) ; si les
 * segments diffèrent (codec, taille, fps, audio), ré-encode avec le filtre concat (H.264 + AAC).
 */
export async function concatVideos(
  segments: { blob: Blob; hasAudio: boolean }[],
  target: { width: number; height: number; fps: number },
  onStatus?: (t: string) => void,
  onProgress?: (p: number) => void,
): Promise<Blob> {
  const ff = await getFFmpeg(onStatus);
  const names: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const n = `seg${i}.mp4`;
    await ff.writeFile(n, await bytes(segments[i].blob));
    names.push(n);
  }
  const progress = (e: { progress: number }) => onProgress?.(Math.max(0, Math.min(1, e.progress)));
  ff.on('progress', progress);
  try {
    await ff.writeFile('list.txt', names.map((n) => `file '${n}'`).join('\n') + '\n');
    try {
      onStatus?.('Assemblage sans ré-encodage…');
      await run(ff, ['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', '-movflags', '+faststart', 'out.mp4']);
    } catch {
      onStatus?.('Segments différents : ré-encodage (plus long)…');
      journal.warn('assemblage', 'Concaténation directe impossible, ré-encodage en H.264');
      // L'audio n'est conservé que si tous les segments en ont un.
      const withAudio = segments.every((s) => s.hasAudio);
      const W = target.width - (target.width % 2);
      const H = target.height - (target.height % 2);
      const v = names.map(
        (_, i) =>
          `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${target.fps},format=yuv420p[v${i}]`,
      );
      const chain = names.map((_, i) => `[v${i}]${withAudio ? `[${i}:a]` : ''}`).join('');
      const filter = `${v.join(';')};${chain}concat=n=${names.length}:v=1:a=${withAudio ? 1 : 0}[outv]${withAudio ? '[outa]' : ''}`;
      const maps = ['-map', '[outv]', ...(withAudio ? ['-map', '[outa]', '-c:a', 'aac', '-b:a', '160k'] : [])];
      await run(ff, [...names.flatMap((n) => ['-i', n]), '-filter_complex', filter, ...maps, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', 'out.mp4']);
    }
    const data = await ff.readFile('out.mp4');
    return new Blob([data as Uint8Array<ArrayBuffer>], { type: 'video/mp4' });
  } finally {
    ff.off('progress', progress);
    for (const n of [...names, 'list.txt', 'out.mp4']) await ff.deleteFile(n).catch(() => undefined);
  }
}

/** Dernière image d'une vidéo via ffmpeg (repli si la méthode <video> + canvas échoue, ex. Safari). */
export async function lastFrameFFmpeg(video: Blob, onStatus?: (t: string) => void): Promise<Blob> {
  const ff = await getFFmpeg(onStatus);
  await ff.writeFile('in.mp4', await bytes(video));
  try {
    await run(ff, ['-sseof', '-0.5', '-i', 'in.mp4', '-update', '1', '-q:v', '1', '-frames:v', '100', 'last.png']);
    const data = await ff.readFile('last.png');
    return new Blob([data as Uint8Array<ArrayBuffer>], { type: 'image/png' });
  } finally {
    await ff.deleteFile('in.mp4').catch(() => undefined);
    await ff.deleteFile('last.png').catch(() => undefined);
  }
}
