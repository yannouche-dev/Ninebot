// Client ComfyUI (via le tunnel HTTPS et Caddy). Routes vérifiées dans server.py de ComfyUI v0.44 :
// /prompt, /ws, /history/{id}, /view, /upload/image, /object_info, /interrupt, /queue, /system_stats.
// Plus les routes de l'agent videogen : /videogen/status, /videogen/log, /videogen/files/delete.
import { request, requestJson, HttpError } from '../core/http.ts';
import { journal } from '../core/journal.ts';

export interface FileRef {
  filename: string;
  subfolder: string;
  type: string;
}

export interface AgentStatus {
  version: number;
  now: number;
  steps: Record<string, { state: string; msg?: string; ts?: number }>;
  models: {
    state: string;
    families: string[];
    total_bytes: number;
    done_bytes: number;
    error: string | null;
    files: { family: string; repo: string; name: string; size: number | null; done: number; state: string; error: string | null }[];
  } | null;
  tunnel_url: string | null;
  comfy_ready: boolean;
  comfy_version?: string;
  watchdog: { idle_minutes: number; max_hours: number; boot_ts: number; idle_since: number | null; stop_at: number | null; triggered: boolean; reason: string | null };
  disk: { free_bytes: number; total_bytes: number } | null;
}

export type ObjectInfo = Record<string, { input: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> }; [k: string]: unknown }>;

export interface PromptResponse {
  prompt_id: string;
  number: number;
  node_errors: Record<string, unknown>;
}

export interface HistoryEntry {
  prompt: unknown[];
  outputs: Record<string, Record<string, unknown>>;
  status: { status_str: string; completed: boolean; messages: [string, Record<string, unknown>][] };
}

export class ComfyClient {
  readonly base: string;
  private token: string;
  constructor(base: string, token: string) {
    this.base = base.replace(/\/+$/, '');
    this.token = token;
  }
  private h(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  agentStatus(quiet = true): Promise<AgentStatus> {
    return requestJson(`${this.base}/videogen/status`, { cat: 'instance', headers: this.h(), quiet, timeoutMs: 15000 });
  }
  agentLog(tail = 200): Promise<{ lines: string[] }> {
    return requestJson(`${this.base}/videogen/log?tail=${tail}`, { cat: 'instance', headers: this.h() });
  }
  deleteFiles(files: FileRef[]): Promise<{ deleted: string[]; missing: string[]; refused: string[] }> {
    return requestJson(`${this.base}/videogen/files/delete`, { cat: 'comfy', headers: this.h(), json: { files } });
  }

  systemStats(): Promise<{ system: Record<string, unknown>; devices: { name: string; vram_total: number; vram_free: number }[] }> {
    return requestJson(`${this.base}/system_stats`, { cat: 'comfy', headers: this.h() });
  }
  objectInfo(): Promise<ObjectInfo> {
    return requestJson(`${this.base}/object_info`, { cat: 'comfy', headers: this.h(), timeoutMs: 60000 });
  }
  queue(quiet = true): Promise<{ queue_running: unknown[][]; queue_pending: unknown[][] }> {
    return requestJson(`${this.base}/queue`, { cat: 'comfy', headers: this.h(), quiet });
  }
  async history(promptId: string, quiet = true): Promise<HistoryEntry | null> {
    const res = await requestJson<Record<string, HistoryEntry>>(`${this.base}/history/${encodeURIComponent(promptId)}`, {
      cat: 'comfy',
      headers: this.h(),
      quiet,
    });
    return res[promptId] ?? null;
  }

  async prompt(prompt: unknown, clientId: string): Promise<PromptResponse> {
    return requestJson(`${this.base}/prompt`, {
      cat: 'comfy',
      headers: this.h(),
      json: { prompt, client_id: clientId, extra_data: { preview_method: 'auto' } },
      timeoutMs: 60000,
    });
  }

  interrupt(promptId: string): Promise<Response> {
    return request(`${this.base}/interrupt`, { cat: 'comfy', headers: this.h(), json: { prompt_id: promptId } });
  }
  removeFromQueue(promptIds: string[]): Promise<Response> {
    return request(`${this.base}/queue`, { cat: 'comfy', headers: this.h(), json: { delete: promptIds } });
  }

  async uploadImage(blob: Blob, filename: string): Promise<FileRef> {
    const fd = new FormData();
    fd.append('image', blob, filename);
    fd.append('type', 'input');
    fd.append('subfolder', 'videogen');
    fd.append('overwrite', 'true');
    const res = await requestJson<{ name: string; subfolder: string; type: string }>(`${this.base}/upload/image`, {
      cat: 'comfy',
      method: 'POST',
      headers: this.h(),
      body: fd,
      timeoutMs: 120000,
    });
    return { filename: res.name, subfolder: res.subfolder, type: res.type };
  }

  async view(f: FileRef): Promise<Blob> {
    const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder, type: f.type });
    const res = await request(`${this.base}/view?${q}`, { cat: 'comfy', headers: this.h(), timeoutMs: 300000 });
    return res.blob();
  }

  /** WebSocket de progression (le navigateur ne peut pas y mettre d'en-tête : jeton en paramètre). */
  openSocket(clientId: string): WebSocket {
    const u = new URL(this.base);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws';
    u.search = new URLSearchParams({ clientId, token: this.token }).toString();
    const ws = new WebSocket(u.toString());
    ws.binaryType = 'arraybuffer';
    return ws;
  }
}

/** Liste des valeurs d'une entrée « combo » dans /object_info (formats ancien et V3). */
export function comboOptions(spec: unknown[] | undefined): string[] | null {
  if (!spec || !spec.length) return null;
  if (Array.isArray(spec[0])) return spec[0] as string[];
  if (spec[0] === 'COMBO' && spec[1] && typeof spec[1] === 'object') {
    const opts = (spec[1] as { options?: unknown[] }).options;
    if (Array.isArray(opts) && opts.every((o) => typeof o === 'string')) return opts as string[];
  }
  return null;
}

export { HttpError, journal };
