// Amorce « onstart » transmise à Vast (limite ≈ 4 000 caractères) et variables d'environnement.
// L'amorce télécharge les scripts de l'instance depuis le dépôt, AU COMMIT EXACT de l'interface déployée,
// et vérifie leurs empreintes SHA-256 (intégrées au build) avant d'exécuter quoi que ce soit.

export interface BuildInfo {
  test: boolean;
  repo: string;
  ref: string;
  instanceBase: string;
  instanceFiles: Record<string, string>;
  proxyUrl: string;
  hfBase: string;
  builtAt: string;
}

export const ONSTART_LIMIT = 4000;

export function instanceBaseUrl(b: BuildInfo): string {
  return b.instanceBase || `https://raw.githubusercontent.com/${b.repo}/${b.ref}/instance`;
}

export function buildOnstart(b: BuildInfo): string {
  const base = instanceBaseUrl(b);
  const files = Object.keys(b.instanceFiles);
  const sums = files.map((f) => `${b.instanceFiles[f]}  ${f}.new`).join('\n');
  const script = `#!/bin/bash
# videogen : amorce générée par l'interface (${b.ref.slice(0, 12)})
H=\${VG_HOME:-/workspace/videogen}
D=$H/src
mkdir -p "$D" "$H/logs" && cd "$D" || exit 1
say() { echo "$1"; echo "$1" >/proc/1/fd/1 2>/dev/null; }
U=${base}
for f in ${files.join(' ')}; do
  curl -fsSL --retry 5 --retry-delay 3 -o "$f.new" "$U/$f" || { say "VIDEOGEN_STEP=tools:error téléchargement de $f impossible"; exit 1; }
done
cat >SHA256SUMS.new <<'EOF'
${sums}
EOF
if ! sha256sum -c --quiet SHA256SUMS.new; then say "VIDEOGEN_STEP=tools:error empreinte SHA-256 invalide"; exit 1; fi
for f in ${files.join(' ')}; do mv -f "$f.new" "$f"; done
chmod +x onstart.sh
setsid nohup bash onstart.sh >>"$H/logs/onstart.log" 2>&1 </dev/null &
`;
  if (script.length > ONSTART_LIMIT) throw new Error(`Amorce onstart trop longue (${script.length} > ${ONSTART_LIMIT})`);
  return script;
}

export interface EnvInput {
  hfToken: string;
  comfyToken: string;
  allowedOrigin: string;
  idleMinutes: number;
  maxHours: number;
  families: string[];
  comfyVersion: string;
}

/** Variables d'environnement de l'instance. Jamais la clé API Vast. Aucune valeur ne contient « ; »
 *  (Vast ignore silencieusement ces valeurs). */
export function buildEnv(e: EnvInput): Record<string, string> {
  const env: Record<string, string> = {
    HF_TOKEN: e.hfToken,
    COMFY_ACCESS_TOKEN: e.comfyToken,
    ALLOWED_ORIGIN: e.allowedOrigin,
    IDLE_MINUTES: String(Math.max(0, Math.round(e.idleMinutes))),
    MAX_HOURS: String(Math.max(0, e.maxHours)),
    MODELS: e.families.join(','),
    COMFY_VERSION: e.comfyVersion,
  };
  for (const [k, v] of Object.entries(env)) {
    if (v.includes(';')) throw new Error(`Valeur interdite (« ; ») dans ${k}`);
    if (v.length > 255) throw new Error(`Valeur trop longue pour ${k}`);
  }
  return env;
}
