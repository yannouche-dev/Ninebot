// Recherche et classement des offres Vast.ai selon les réglages de l'interface.
import type { Settings } from '../core/settings.ts';
import { GPU_PRO6000 } from '../core/settings.ts';
import type { VastOffer } from './api.ts';

/** Corps de POST /api/v0/bundles/ (opérateurs eq, gte, lte, in…). */
export function buildOfferQuery(s: Settings): Record<string, unknown> {
  return {
    verified: { eq: true },
    rentable: { eq: true },
    rented: { eq: false },
    external: { eq: false },
    gpu_name: { in: s.gpuNames },
    num_gpus: { eq: s.numGpus },
    reliability: { gte: s.minReliability },
    inet_down: { gte: s.minInetDown },
    disk_space: { gte: s.diskGB },
    dph_total: { lte: s.maxPrice },
    cuda_max_good: { gte: s.minCuda },
    type: 'on-demand',
    order: [['dph_total', 'asc']],
    limit: 64,
    allocated_storage: s.diskGB,
  };
}

export function reliabilityOf(o: VastOffer): number {
  return Number(o.reliability ?? o.reliability2 ?? 0);
}

/** Rang de préférence d'un GPU : 0 = RTX PRO 6000, 1 = RTX 5090, puis l'ordre des réglages. */
export function gpuRank(name: string, s: Settings): number {
  if (GPU_PRO6000.includes(name)) return 0;
  const idx = s.gpuNames.indexOf(name);
  return idx < 0 ? 99 : 1 + idx;
}

/** Filtre (au cas où l'API ignorerait un critère) et trie : GPU préféré d'abord, puis prix croissant. */
export function rankOffers(offers: VastOffer[], s: Settings): VastOffer[] {
  return offers
    .filter(
      (o) =>
        s.gpuNames.includes(o.gpu_name) &&
        o.num_gpus === s.numGpus &&
        reliabilityOf(o) >= s.minReliability &&
        o.inet_down >= s.minInetDown &&
        o.dph_total <= s.maxPrice,
    )
    .sort((a, b) => gpuRank(a.gpu_name, s) - gpuRank(b.gpu_name, s) || a.dph_total - b.dph_total);
}

export function formatPrice(dph: number): string {
  return `${dph.toFixed(3).replace('.', ',')} $/h`;
}
