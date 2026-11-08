// Traduction des erreurs ComfyUI en messages lisibles (OOM, nœud manquant, fichier absent, délai…).
import { HttpError } from '../core/http.ts';

export interface ReadableError {
  title: string;
  hint: string;
  detail?: string;
}

interface NodeErr {
  errors?: { type?: string; message?: string; details?: string; extra_info?: { input_name?: string; received_value?: unknown } }[];
  class_type?: string;
}

export function explainPromptRejection(body: { error?: { type?: string; message?: string; details?: string }; node_errors?: Record<string, NodeErr> }): ReadableError {
  const t = body.error?.type ?? '';
  if (t === 'missing_node_type') {
    return {
      title: 'Nœud manquant sur le serveur',
      hint: 'La version de ComfyUI de l’instance ne connaît pas un nœud du workflow. Vérifie la version (Réglages) ou recrée l’instance.',
      detail: body.error?.message,
    };
  }
  const parts: string[] = [];
  let missingFile = false;
  for (const [id, ne] of Object.entries(body.node_errors ?? {})) {
    for (const e of ne.errors ?? []) {
      if (e.type === 'value_not_in_list' && /\.(safetensors|ckpt|pt|pth|gguf)/.test(String(e.extra_info?.received_value ?? e.details ?? ''))) missingFile = true;
      parts.push(`${ne.class_type ?? 'nœud'} #${id} : ${e.message ?? e.type}${e.details ? ` (${e.details})` : ''}`);
    }
  }
  if (missingFile) {
    return {
      title: 'Fichier de modèle absent',
      hint: 'Les poids de ce modèle ne sont pas (encore) sur l’instance. Attends la fin du téléchargement ou active la famille dans les réglages puis redémarre.',
      detail: parts.join('\n'),
    };
  }
  return {
    title: 'Workflow refusé par ComfyUI',
    hint: 'Un réglage est hors limites ou incompatible. Le détail est dans le Journal.',
    detail: [body.error?.message, ...parts].filter(Boolean).join('\n'),
  };
}

export function explainExecutionError(d: { exception_type?: string; exception_message?: string; node_type?: string; node_id?: string }): ReadableError {
  const msg = `${d.exception_type ?? ''} ${d.exception_message ?? ''}`;
  if (/out of memory|OutOfMemory|OOM|CUDA error: out of memory|allocat/i.test(msg)) {
    return {
      title: 'Mémoire GPU insuffisante (OOM)',
      hint: 'Baisse la résolution ou la durée, ou désactive l’amélioration du prompt, puis relance.',
      detail: `${d.node_type ?? ''} #${d.node_id ?? ''} : ${d.exception_message ?? ''}`.trim(),
    };
  }
  if (/safetensors|header too small|No such file|FileNotFoundError/i.test(msg)) {
    return {
      title: 'Fichier de modèle illisible ou incomplet',
      hint: 'Le téléchargement des poids est peut-être incomplet. Consulte l’état des modèles dans Instance.',
      detail: `${d.node_type ?? ''} : ${d.exception_message ?? ''}`,
    };
  }
  return {
    title: `Erreur pendant la génération (${d.node_type ?? 'nœud inconnu'})`,
    hint: 'Le message complet est dans le Journal.',
    detail: `${d.exception_type ?? ''} : ${d.exception_message ?? ''}`.trim(),
  };
}

export function explainError(e: unknown): ReadableError {
  if (e instanceof HttpError) {
    if (e.kind === 'network') return { title: 'Instance injoignable', hint: 'Le tunnel est peut-être coupé ou l’instance arrêtée. Vérifie l’onglet Instance.', detail: e.message };
    if (e.kind === 'timeout') return { title: 'Délai dépassé', hint: 'Le serveur ne répond pas. Réessaie dans un instant.', detail: e.message };
    if (e.status === 401) return { title: 'Accès refusé par l’instance (401)', hint: 'Le jeton ComfyUI ne correspond pas. Recharge l’instance depuis l’onglet Instance.', detail: e.body.slice(0, 300) };
    if (e.status === 400) {
      const body = e.json<Parameters<typeof explainPromptRejection>[0]>();
      if (body && (body.error || body.node_errors)) return explainPromptRejection(body);
    }
    if (e.status === 502 || e.status === 530 || e.status === 524) {
      return { title: `Passerelle indisponible (HTTP ${e.status})`, hint: 'ComfyUI redémarre ou le tunnel est instable. Réessaie dans quelques secondes.', detail: e.body.slice(0, 300) };
    }
    return { title: `Erreur HTTP ${e.status}`, hint: 'Voir le Journal.', detail: e.body.slice(0, 500) };
  }
  if (e instanceof Error) return { title: e.message, hint: '' };
  return { title: String(e), hint: '' };
}
