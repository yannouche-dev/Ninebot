// Analyse des lignes publiées par l'instance dans ses logs (lus via l'API Vast) :
//   VIDEOGEN_BOOT=<horodatage>              début d'un démarrage du conteneur
//   VIDEOGEN_STEP=<étape>:<état>[ message]  progression (tools, tunnel, comfy_install, comfy_start, models, ready, auto_stop)
//   VIDEOGEN_TUNNEL_URL=https://…           URL HTTPS publique (tunnel Cloudflare)

export interface BootInfo {
  bootTs: number | null;
  steps: Record<string, { state: string; msg: string }>;
  tunnelUrl: string | null;
  autoStop: string | null;
  lines: string[];
}

const TUNNEL_RE = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;

export function isTunnelUrl(u: string, allowLocal = false): boolean {
  if (TUNNEL_RE.test(u)) return true;
  return allowLocal && /^http:\/\/127\.0\.0\.1:\d+$/.test(u);
}

export function parseBootLog(text: string, allowLocal = false): BootInfo {
  const all = text.split(/\r?\n/);
  let start = 0;
  let bootTs: number | null = null;
  all.forEach((l, i) => {
    const m = l.match(/VIDEOGEN_BOOT=(\d+)/);
    if (m) {
      start = i;
      bootTs = Number(m[1]);
    }
  });
  const lines = all.slice(start).filter((l) => l.includes('VIDEOGEN_'));
  const info: BootInfo = { bootTs, steps: {}, tunnelUrl: null, autoStop: null, lines };
  for (const l of lines) {
    const step = l.match(/VIDEOGEN_STEP=([a-z_]+):([a-z_0-9]+)(?:\s+(.*))?$/);
    if (step) {
      const [, name, state, msg = ''] = step;
      if (name === 'auto_stop') info.autoStop = msg ? `${state} ${msg}` : state;
      else info.steps[name] = { state, msg };
      if (name === 'tunnel' && state === 'lost') info.tunnelUrl = null;
    }
    const t = l.match(/VIDEOGEN_TUNNEL_URL=(\S+)/);
    if (t && isTunnelUrl(t[1], allowLocal)) info.tunnelUrl = t[1];
  }
  return info;
}

/** URL de tunnel éventuellement recopiée par l'instance dans son label (« videogen https://… »). */
export function tunnelFromLabel(label: string | null | undefined, allowLocal = false): string | null {
  const m = (label || '').match(/(https?:\/\/\S+)/);
  return m && isTunnelUrl(m[1], allowLocal) ? m[1] : null;
}
