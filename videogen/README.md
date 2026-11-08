# Videogen — génération vidéo sur GPU Vast.ai, pilotée depuis ton téléphone

Interface web statique (GitHub Pages) qui **loue, configure, surveille et arrête** une machine GPU sur
[Vast.ai](https://vast.ai), y installe **ComfyUI** et les modèles vidéo, puis te laisse générer des vidéos
**LTX-2.5**, **Wan 2.2** et **HunyuanVideo 1.5** depuis le navigateur.

Tes clés se saisissent **uniquement dans l'interface**, une fois. Elles restent chiffrées dans ton navigateur.
Au quotidien : **Démarrer → Générer → Arrêter**.

---

## Sommaire

1. [Architecture](#1-architecture)
2. [Contenu du dépôt](#2-contenu-du-dépôt)
3. [Première configuration (une seule fois)](#3-première-configuration-une-seule-fois)
4. [Checklist du premier test réel (sur mobile)](#4-checklist-du-premier-test-réel-sur-mobile)
5. [Usage quotidien](#5-usage-quotidien)
6. [Coûts](#6-coûts)
7. [Modèles disponibles et ajout d'un modèle](#7-modèles-disponibles-et-ajout-dun-modèle)
8. [Dépannage](#8-dépannage)
9. [Sécurité : risques et protections](#9-sécurité--risques-et-protections)
10. [Développement et tests](#10-développement-et-tests)
11. [Ce qui a été vérifié, ce qui ne l'a pas été](#11-ce-qui-a-été-vérifié-ce-qui-ne-la-pas-été)

---

## 1. Architecture

```
Téléphone ─ GitHub Pages (application statique, CSP stricte, aucun script tiers)
  │  coffre chiffré AES-GCM (clé dérivée PBKDF2 de ta phrase de passe) dans localStorage
  │
  ├─HTTPS→ Cloudflare Worker « videogen-vast-proxy » ─→ API REST Vast.ai (+ lecture des logs S3)
  │         (l'API Vast n'envoie pas d'en-têtes CORS : un navigateur ne peut pas l'appeler directement)
  │
  ├─HTTPS→ huggingface.co/api/whoami-v2 (test du token à la saisie)
  │
  └─HTTPS/WSS→ https://xxxx.trycloudflare.com   ← tunnel Cloudflare ouvert PAR l'instance
                 cloudflared → Caddy 127.0.0.1:28080 (exige « Authorization: Bearer <jeton> »
                                                     ou « ?token= » pour le WebSocket ; CORS = ton origine)
                    ├ /videogen/* → agent.py : étapes, % de téléchargement, suppression des sorties, watchdog
                    └ /*          → ComfyUI 127.0.0.1:28188 (--enable-cors-header <ton origine>)
```

**Le chemin d'un clic sur « Démarrer » :**

1. L'interface cherche une instance portant le label `videogen`.
   - **S'il y en a une arrêtée**, elle propose de la redémarrer : les modèles sont déjà sur son disque.
   - **Sinon**, elle cherche des offres (`POST /api/v0/bundles/`) selon tes réglages. Tu choisis une offre, l'interface affiche le prix et demande confirmation.
2. Location (`PUT /api/v0/asks/{id}/`) avec :
   - une image PyTorch CUDA 12.8+ ;
   - une **amorce `onstart`** de moins de 4 000 caractères ;
   - les variables d'environnement `HF_TOKEN`, `COMFY_ACCESS_TOKEN` (généré dans le navigateur avec `crypto.getRandomValues`), `ALLOWED_ORIGIN`, `IDLE_MINUTES`, `MAX_HOURS`, `MODELS` et `COMFY_VERSION`.
   - **Ta clé API Vast n'est jamais transmise à l'instance.**
3. L'amorce télécharge les scripts de `instance/` depuis ce dépôt (`raw.githubusercontent.com`), **au commit exact de l'interface déployée**. Elle vérifie leurs **empreintes SHA-256**, intégrées au build, avant d'exécuter quoi que ce soit.
4. `instance/onstart.sh` s'exécute ensuite :
   - il installe Caddy et cloudflared, téléchargés en versions figées et vérifiés par SHA-256 ;
   - il lance l'agent et Caddy, puis ouvre le tunnel ;
   - il publie l'URL dans les logs du conteneur (`VIDEOGEN_TUNNEL_URL=…`) ;
   - il installe ou met à jour ComfyUI (tag figé), le lance, puis télécharge **uniquement les poids manquants** avec `hf download`.
5. L'interface lit les logs via l'API Vast et récupère l'URL **sans copier-coller**. Elle affiche ensuite les étapes détaillées fournies par l'agent : machine louée, conteneur, tunnel, ComfyUI, modèles (%), prêt.
6. **Watchdog** (sur l'instance) : arrêt si la file ComfyUI est vide depuis `IDLE_MINUTES` (20 par défaut) ou si l'instance tourne depuis plus de `MAX_HOURS` (4 par défaut).
   - L'arrêt passe par la clé **restreinte** que Vast injecte dans chaque conteneur (`CONTAINER_API_KEY`). Elle ne peut que démarrer, arrêter ou détruire **cette** instance.
   - Si cette clé manque, le dernier recours est d'éteindre le conteneur (PID 1). Vast ne documente pas clairement si cela arrête la facturation du GPU : vérifie dans la console.
   - Le décompte d'inactivité ne commence qu'une fois les téléchargements terminés.

## 2. Contenu du dépôt

```
web/                     Interface (Vite + TypeScript, sans framework)
  index.html             CSP injectée au build
  src/core/              coffre chiffré (vault), Journal masqué, HTTP, réglages
  src/vast/              client Vast, offres, amorce onstart, cycle de vie de l'instance
  src/comfy/             client ComfyUI (REST + WebSocket), génération, erreurs lisibles
  src/workflows/         construction des requêtes /prompt à partir de models.json
  src/media/             galerie (Blob en mémoire), dernière image, ffmpeg.wasm
  src/ui/                écrans : Instance, Générer, Galerie, Journal, Clés
  public/workflows/      workflows ComfyUI au format API (convertis des templates officiels)
  public/models.json     correspondance nœuds/champs, options supportées, valeurs par défaut
worker/                  Cloudflare Worker (proxy Vast sans état) + wrangler.jsonc
instance/
  onstart.sh             installation et lancement sur la machine GPU
  agent.py               statut, progression, suppression des sorties, watchdog
  Caddyfile              reverse proxy : jeton obligatoire, CORS, jeton masqué dans les logs
  weights.json           poids à télécharger par famille (générés depuis les templates)
mocks/                   faux Vast + Hugging Face, faux ComfyUI + agent, vidéos de test
tests/unit/              Vitest : coffre, masquage, Worker, workflows, amorce onstart (exécutée)
tests/e2e/               Playwright (Pixel 7) : parcours complet et erreurs contre les mocks
tests/instance/          agent.py (faux Vast/HF/ComfyUI) et vrai Caddy
tools/                   conversion des templates officiels, validation contre un vrai ComfyUI
.github/workflows/       deploy.yml (Pages), ci.yml (tests + gitleaks), worker.yml (wrangler)
```

## 3. Première configuration (une seule fois)

Tout se fait depuis le navigateur du téléphone. Sur github.com, les **Réglages (Settings)** d'un dépôt ne
s'affichent parfois qu'en « version ordinateur » : dans le menu du navigateur, coche *Version pour ordinateur*.

### 3.1 Activer GitHub Pages

1. Dépôt → **Settings → Pages**.
2. *Build and deployment → Source* : choisis **GitHub Actions**.
3. Onglet **Actions** → workflow **« Déployer l'interface (GitHub Pages) »** → **Run workflow**. Il se lance aussi seul à chaque push sur `main`.
4. À la fin, l'adresse du site s'affiche, par exemple `https://yannouche-dev.github.io/Gen/`. Ajoute-la à ton écran d'accueil.

### 3.2 Déployer le proxy Vast (Cloudflare Worker)

1. Crée un compte gratuit sur [dash.cloudflare.com](https://dash.cloudflare.com). Ouvre une fois **Workers & Pages** : cela crée ton sous-domaine `xxx.workers.dev`, nécessaire au premier déploiement.
2. **Account ID** : visible dans **Workers & Pages** (colonne de droite) ou dans l'URL du tableau de bord.
3. **Jeton API** : *My Profile → API Tokens → Create Token*, modèle **« Edit Cloudflare Workers »**, ton compte, puis *Create Token*. Copie-le : il ne sera plus affiché.
4. Sur GitHub : dépôt → **Settings → Secrets and variables → Actions → New repository secret**.
   - `CLOUDFLARE_API_TOKEN` = le jeton ;
   - `CLOUDFLARE_ACCOUNT_ID` = l'Account ID.
5. **Actions → « Déployer le proxy Vast (Cloudflare Worker) » → Run workflow.**
6. Ouvre l'exécution terminée : le **résumé** affiche l'URL du proxy, du type `https://videogen-vast-proxy.xxx.workers.dev`. Garde-la pour l'écran Clés.
7. *Facultatif, plus strict :* ajoute une **variable** (onglet *Variables*, pas *Secrets*) `VAST_PROXY_URL` avec cette URL, puis relance le déploiement de l'interface. La CSP n'autorisera alors que ce Worker, au lieu de tout `*.workers.dev`.

Le Worker n'accepte que l'origine `https://<propriétaire>.github.io`. Il ne relaie que 7 routes Vast, plus la lecture des logs S3. Il ne journalise rien : l'observabilité est désactivée dans `worker/wrangler.jsonc`, et le code ne contient aucun `console.log`.

### 3.3 Clé API Vast.ai (restreinte, recommandé)

1. [cloud.vast.ai](https://cloud.vast.ai) → crédite ton compte (*Billing*).
2. *Keys* → **nouvelle clé API**. Coche seulement les permissions nécessaires :
   - **instance read** et **instance write** (louer, démarrer, arrêter, détruire, lire les logs) ;
   - **user read** (crédit) ;
   - **misc** (recherche d'offres).
3. Ne coche **pas** *billing*. Une clé volée dans le navigateur ne pourrait alors ni changer ta facturation ni créer d'autres clés.

### 3.4 Token Hugging Face

1. Va sur [huggingface.co/Lightricks/LTX-2.5](https://huggingface.co/Lightricks/LTX-2.5) et **accepte la licence**. Le dépôt est protégé : sans cette acceptation, le téléchargement échoue.
2. *Settings → Access Tokens → Create new token* → type **Fine-grained**. Coche **« Read access to contents of all public gated repos you can access »**. C'est tout ce dont l'instance a besoin.

### 3.5 Saisie dans l'interface

Ouvre le site → écran **Clés** :

1. **URL du proxy** (étape 3.2), **clé Vast**, **token Hugging Face**.
2. Touche **Tester** sur chaque ligne. Le résultat attendu :
   - pour Vast : « OK — compte …, crédit … $ » ;
   - pour Hugging Face : « OK — ton_nom … · accès à Lightricks/LTX-2.5 : OK ».
3. Choisis une **phrase de passe** (8 caractères minimum), puis **Enregistrer**.
   - **Mémoriser dans ce navigateur (chiffré)** coché : les clés sont chiffrées dans localStorage, et ta phrase de passe est demandée à chaque ouverture.
   - Décoché : les clés restent **en mémoire seulement** et disparaissent à la fermeture de l'onglet.

## 4. Checklist du premier test réel (sur mobile)

Coche au fur et à mesure. Si une étape échoue : onglet **Journal → Copier**, puis colle-moi le texte. Les clés
y sont masquées automatiquement.

**A. Clés**
- [ ] Le site s'ouvre. L'écran **Clés** affiche l'URL du proxy, ou tu la saisis.
- [ ] *Tester* (Vast) répond « OK — compte …, crédit … $ ».
- [ ] *Tester* (Hugging Face) répond « OK — … » et « accès à Lightricks/LTX-2.5 : OK ».
  - Si tu vois « non vérifiable depuis le navigateur », ce n'est pas bloquant : l'instance vérifiera elle-même.
- [ ] *Enregistrer*. L'onglet **Instance** s'affiche, avec « Aucune instance ».
- [ ] Ferme et rouvre le site : l'écran **Déverrouiller** demande ta phrase de passe.

**B. Démarrage**
- [ ] Dans **Réglages de location**, laisse les valeurs par défaut :
  - 1 GPU, RTX PRO 6000 puis RTX 5090 ;
  - fiabilité ≥ 99 % et débit ≥ 500 Mb/s ;
  - disque 150 Go et modèles **LTX-2.5** seulement ;
  - prix max 2,5 $/h, à ajuster.
- [ ] **Démarrer** : une liste d'offres apparaît, RTX PRO 6000 en tête si disponibles.
- [ ] Touche une offre. La fenêtre **Confirmer la location** affiche le prix, puis **Louer à …**.
- [ ] Le bandeau orange « Instance allumée · durée · coût » apparaît en haut.
- [ ] Les étapes avancent. Durées indicatives pour un **premier** démarrage, environ 20 à 40 min en tout :
  - ✓ Machine louée ;
  - ✓ Conteneur démarré (téléchargement de l'image, souvent 3 à 10 min) ;
  - ✓ Accès HTTPS sécurisé (tunnel) ;
  - ✓ ComfyUI installé et lancé (3 à 8 min) ;
  - Modèles téléchargés : **%** en direct, environ 52 Go pour LTX-2.5 ;
  - ✓ Prêt.

**C. Première génération (LTX-2.5, courte, 720p)**
- [ ] Onglet **Générer**. Modèle **LTX-2.5 · Texte → vidéo**. Wan et Hunyuan apparaissent « absent du serveur » : c'est normal, ils ne sont pas installés.
- [ ] Résolution **720p**, format **16:9** (1280 × 704), durée **3 s**, 24 i/s.
- [ ] Prompt, par exemple : `A red fox trotting through fresh snow at sunrise, cinematic tracking shot`.
- [ ] **Générer**. Le statut, la barre de progression, l'étape en cours et les aperçus s'affichent.
- [ ] La vidéo s'affiche dans le navigateur. **Télécharger** l'enregistre sur le téléphone.
- [ ] *(Facultatif)* **Prolonger** : la dernière image passe en I2V. **Galerie → Assembler** produit la vidéo complète.

**D. Arrêt**
- [ ] Onglet **Instance → Arrêter (garder le disque)** → confirmer. L'état passe à **Arrêtée** et le bandeau disparaît.
- [ ] Sur [cloud.vast.ai/instances](https://cloud.vast.ai/instances/), l'instance `videogen` est **Stopped**. Le GPU n'est plus facturé, le stockage l'est encore.
- [ ] *(Pour ne plus rien payer)* **Détruire l'instance** → confirmer. Dans la console Vast, l'instance disparaît.

## 5. Usage quotidien

1. Ouvre le site et saisis ta phrase de passe.
2. **Instance → Démarrer**. Si l'instance est arrêtée, elle redémarre et les modèles sont déjà là (quelques minutes). Sinon, choisis une offre.
3. **Générer** : choisis le modèle. Seules les options que ce modèle supporte s'affichent :
   - prompt, et prompt négatif s'il existe ;
   - résolution (480p à 1080p selon le modèle) et format 16:9, 9:16 ou 1:1 ;
   - durée et images par seconde ;
   - steps et CFG (Wan, Hunyuan) ; mode rapide LoRA 4 étapes (Wan) ; amélioration du prompt (LTX) ;
   - seed fixe ou aléatoire ;
   - image de début et/ou de fin.

   **Préréglages** : *Enregistrer* garde les réglages du formulaire, sans les images, dans ce navigateur.
4. **Annuler** interrompt la génération en cours sur le serveur.
5. **Galerie** :
   - miniatures, réglages et seed de chaque vidéo ;
   - **Rejouer** (mêmes réglages et même seed), **Prolonger**, **Télécharger**, **Supprimer** ;
   - **Timeline** : ordre réglable avec ↑ et ↓, puis **Assembler** avec ffmpeg.wasm, chargé à la demande depuis le site (≈ 32 Mo).
6. Les vidéos ne vivent **que dans l'onglet**, en mémoire : télécharge celles que tu veux garder. Les fichiers sont supprimés de l'instance dès qu'ils ont été récupérés.
7. **Arrête** quand tu as fini. Sinon le watchdog le fera après 20 min de file vide, ou après 4 h au maximum.
8. Si tu fermes l'onglet alors que l'instance tourne, le navigateur te le rappelle.

**Prolonger une vidéo** : la dernière image est extraite dans le navigateur, avec `<video>` + canvas, et ffmpeg.wasm en
repli (utile sur Safari iOS). Le modèle image → vidéo de la même famille est pré-rempli, ainsi que le prompt, la
résolution et la durée. Le résultat se place juste après l'original dans la timeline.

## 6. Coûts

| Poste | Quand | Ordre de grandeur |
|---|---|---|
| GPU + machine (`dph_total`) | à la seconde, **tant que l'instance tourne** (y compris pendant l'installation) | affiché sur chaque offre et dans la confirmation ; RTX PRO 6000 plus chère que RTX 5090 |
| Stockage du disque | **tout le temps** tant que l'instance existe, **même arrêtée** | affiché dans l'onglet Instance quand elle est arrêtée (≈ prix/Go/mois × taille ÷ 30 par jour) |
| Bande passante | selon l'hôte (certains facturent le téléchargement) | le 1er démarrage télécharge ≈ 52 Go (LTX-2.5), environ 70 Go de plus pour Wan, 45 Go pour Hunyuan |

- **Le bandeau de coût** en haut de l'écran donne la durée allumée et le coût estimé de la session (prix/h × durée).
- **Le crédit Vast restant** est affiché dans l'onglet Instance.
- **Arrêter** coupe le coût GPU et garde les modèles : le prochain démarrage est rapide, mais le stockage reste facturé. **Détruire** coupe tout, et le prochain démarrage retélécharge les modèles.
- **Le watchdog** (20 min de file vide, 4 h maximum) se règle dans *Réglages de location*. La valeur 0 le désactive (déconseillé).
- **Une instance arrêtée peut ne pas redémarrer** si quelqu'un d'autre loue le GPU entre-temps : elle reste en attente. Détruis-la et loue une autre offre.

## 7. Modèles disponibles et ajout d'un modèle

Les workflows sont **convertis des templates officiels ComfyUI** (paquet `comfyui-workflow-templates` 0.11.103,
installé avec ComfyUI v0.44.2), sans modification. La conversion passe par le frontend officiel (« Export API »).
Chaque combinaison d'options que l'interface peut produire a été **validée par un vrai ComfyUI v0.44.2**
(`tools/validate-workflows.mjs`, 65 variantes).

| Id | Template officiel | Famille (poids) |
|---|---|---|
| `ltx25-t2v` | `video_ltx2_5_t2v.json` | LTX-2.5 int8 (≈ 52 Go) : transformer 22B distillé int8, encodeur Gemma 4 12B int8, VAE vidéo et audio, upscaler x2, Gemma 4 E2B (amélioration du prompt) |
| `ltx25-i2v` | `video_ltx2_5_i2v.json` | LTX-2.5 |
| `ltx25-flf2v` | `video_ltx2_5_flf2v.json` | LTX-2.5 |
| `wan22-t2v` | `video_wan2_2_14B_t2v.json` | Wan 2.2 14B fp8 (≈ 70 Go) : high et low noise T2V et I2V, LoRA lightx2v, umt5, VAE 2.1 |
| `wan22-i2v` | `video_wan2_2_14B_i2v.json` | Wan 2.2 |
| `hy15-t2v` | `video_hunyuan_video_1.5_720p_t2v.json` | HunyuanVideo 1.5 720p (≈ 45 Go) : T2V et I2V fp16, Qwen2.5-VL 7B fp8, byT5, VAE, SigCLIP |
| `hy15-i2v` | `video_hunyuan_video_1.5_720p_i2v.json` | HunyuanVideo 1.5 |

Les noms de fichiers et les dépôts Hugging Face viennent des templates eux-mêmes (`instance/weights.json`). Pour
installer Wan ou Hunyuan, coche la famille dans *Réglages de location* **avant** de louer. Le disque est augmenté
automatiquement si besoin.

Sur une instance existante, les familles se fixent à la création. Pour en ajouter une : détruis l'instance, coche
la famille, puis loue de nouveau.

Un modèle est grisé (« absent du serveur ») si `/object_info` ne connaît pas l'un de ses nœuds ou ne liste pas l'un
de ses fichiers de poids.

**Ajouter un modèle (ex. Wan 2.2 First/Last-Frame) :**

1. Lance en local un ComfyUI **de la même version** que `COMFY_VERSION` (`instance/onstart.sh`), sur CPU :
   `python main.py --cpu --port 8188`.
2. Ajoute l'entrée dans `TEMPLATES`, en haut de `tools/convert-templates.mjs`, par exemple
   `'wan22-flf2v': ['video_wan2_2_14B_flf2v.json', 'wan22']`. Lance ensuite :
   ```
   COMFY=http://127.0.0.1:8188 TEMPLATES_DIR=<site-packages>/comfyui_workflow_templates_json/templates \
   COMFY_MODELS_DIR=<ComfyUI>/models node tools/convert-templates.mjs --placeholders
   ```
   Cela écrit `web/public/workflows/<id>.json`, met à jour `instance/weights.json` et `tests/fixtures/object_info.json`.
   `--placeholders` crée des fichiers de poids vides : aucun téléchargement n'est nécessaire.
3. Ouvre le workflow converti et repère les nœuds à piloter : primitives « Prompt », « Width », « Duration »… et `RandomNoise`, `SaveVideo`. Ajoute un bloc dans `web/public/models.json` (copie un modèle proche). Seules les options déclarées dans `params` s'affichent.
4. Vérifie avec `COMFY=http://127.0.0.1:8188 node tools/validate-workflows.mjs`, puis `npm test` et `npm run test:e2e`.
5. Pousse sur `main` : l'interface est redéployée et les nouveaux poids seront téléchargés par les **nouvelles** instances.

**Mettre à jour ComfyUI :** change `COMFY_VERSION` (`instance/onstart.sh`) et `comfyVersion`
(`web/src/core/settings.ts`, `web/public/models.json`). Reconvertis ensuite les templates (étape 2) et revalide
(étape 4). Une instance existante suit la version de son interface d'origine : détruis-la et recrée-la pour en profiter.

## 8. Dépannage

Commence toujours par **Journal → Copier** : il contient chaque requête (méthode, URL, code HTTP, durée), les
réponses d'erreur, les lignes de démarrage publiées par l'instance et, via **Logs de l'instance**, la fin de
`onstart.log`. Toute clé ou tout jeton y est masqué (ex. `vast_…a3f9`), y compris dans les URL et les en-têtes.

| Symptôme | Cause probable | Solution |
|---|---|---|
| Test Vast : « origine refusée (403) » | `ALLOWED_ORIGIN` du Worker ≠ adresse du site | Le site doit être servi depuis `https://<propriétaire>.github.io`. Relance le workflow du Worker. |
| Test Vast : « Clé refusée (401) » | clé erronée ou sans permission | Recrée la clé (§ 3.3). |
| Test Vast : « Serveur injoignable » | URL du proxy fausse, ou Worker non déployé | Vérifie l'URL (résumé du workflow Worker). |
| Aucune offre | filtres trop stricts (prix max, fiabilité, débit, CUDA ≥ 12.9) | Augmente le prix max ou baisse le débit dans *Réglages de location*. |
| « Cette offre vient d'être louée » | quelqu'un l'a prise entre-temps | Relance la recherche. |
| Bloqué sur « Conteneur démarré » | téléchargement de l'image (lent sur certains hôtes) | Patiente. Si l'état devient `exited` ou `offline` : **Détruire**, puis une autre offre. |
| Bloqué sur « Accès HTTPS (tunnel) » | QUIC (UDP) bloqué chez l'hôte : le script bascule seul en HTTP/2 ; ou logs Vast pas encore disponibles | Patiente 2 à 3 min. Le Journal montre `VIDEOGEN_STEP=tunnel:retry`. |
| Étape outils : « empreinte SHA-256 invalide » | scripts du dépôt modifiés après le build | Redéploie l'interface (push sur `main`), puis détruis et recrée l'instance. |
| Modèles : « accès refusé … accepte la licence » | licence LTX-2.5 non acceptée, ou token sans accès aux dépôts protégés | § 3.4, puis Arrêter et Démarrer (seuls les fichiers manquants sont repris). |
| Modèles : « disque insuffisant » | trop de familles pour la taille du disque | Détruis, augmente le disque, recrée. |
| « Mémoire GPU insuffisante (OOM) » | résolution ou durée trop grandes pour le GPU | Baisse la résolution ou la durée. |
| « Nœud manquant sur le serveur » | version de ComfyUI ≠ version des workflows | Remets `v0.44.2` dans les réglages, puis recrée l'instance. |
| « Instance injoignable » pendant l'usage | tunnel coupé (il change d'URL à chaque relance) | L'interface recherche seule la nouvelle URL. Sinon **Actualiser**. |
| Arrêtée toute seule | watchdog (inactivité ou durée max) | Normal. Le motif s'affiche dans l'onglet Instance. **Démarrer** pour reprendre. |
| Phrase de passe oubliée | le coffre est indéchiffrable sans elle | **Tout effacer**, puis ressaisis les clés. Tes instances Vast ne sont pas touchées. |

## 9. Sécurité : risques et protections

**Risques à connaître :**

- **Les clés vivent dans le navigateur.** Un script malveillant exécuté sur le site pourrait les lire une fois le
  coffre déverrouillé. Protections en place :
  - CSP stricte : `script-src 'self'`, aucun script tiers, aucun CDN, `connect-src` limité au proxy, à
    `huggingface.co` et à `*.trycloudflare.com` ;
  - aucune utilisation d'`innerHTML` ;
  - dépendances figées par `package-lock.json` : la seule dépendance livrée est ffmpeg.wasm ;
  - refus de s'exécuter dans une iframe ;
  - verrouillage manuel.

  Pour limiter les dégâts possibles, utilise une **clé Vast restreinte** et un **token HF en lecture seule**.
- **Même origine pour tous tes sites GitHub Pages.** Tous tes dépôts publiés sur `https://<toi>.github.io` partagent
  le même localStorage et la même origine autorisée par le Worker. Le coffre est chiffré, mais n'héberge pas de
  code non fiable sur un autre de tes sites Pages.
- **Le token Hugging Face est transmis à l'instance**, comme variable d'environnement. L'hôte Vast (un tiers) peut
  techniquement le lire, tout comme toute personne ayant ta clé Vast (`extra_env`). Utilise un token
  **fine-grained en lecture seule**, révocable à tout moment.
- **Le jeton ComfyUI** (256 bits, unique par instance) protège l'accès au tunnel. Il passe en paramètre `?token=`
  pour le WebSocket, faute de pouvoir mettre un en-tête dans un navigateur. Cloudflare termine le TLS du tunnel et
  voit donc ce paramètre. Caddy le retire avant ComfyUI et le masque dans ses journaux.
- **Le Worker voit passer ta clé Vast** (en-tête `Authorization`) à chaque appel. Il ne la stocke ni ne la
  journalise. Les membres de ton compte Cloudflare pourraient en revanche activer un suivi en direct
  (`wrangler tail`) : garde ce compte pour toi.
- **Les vidéos** ne transitent que par ton instance et ton navigateur. Elles sont supprimées de l'instance dès
  leur récupération, et purgées au-delà de 2 h. Aucune statistique ni analyse d'audience.

**Ce que fait le projet pour te protéger :**

- Ta **clé Vast principale n'est jamais envoyée à l'instance** : le watchdog utilise la clé restreinte injectée par Vast.
- Les **scripts exécutés sur la machine GPU** sont vérifiés par SHA-256, au commit exact de l'interface, ainsi que Caddy et cloudflared.
- **Aucun secret dans le dépôt** : le scan gitleaks tourne en CI à chaque push, avec une exception uniquement pour les valeurs factices des tests.

## 10. Développement et tests

Prérequis : Node 22, Python 3.10+, Chromium de Playwright.

```
npm ci
npm run typecheck          # TypeScript strict
npm test                   # Vitest : coffre, masquage, Worker, offres, workflows, amorce onstart exécutée
npm run test:e2e           # build de test + Playwright (Pixel 7) contre les mocks
python3 -m unittest discover -s tests/instance -v   # agent.py ; Caddy réel si CADDY_BIN est défini
npm run build:test && npm run mocks                 # essai manuel sur http://127.0.0.1:4173
```

Avec les mocks :
- clé Vast de test : `test-vast-key-0123456789abcdef` ;
- token Hugging Face de test : `hf_TestToken0123456789abcdef` ;
- mots-clés dans le prompt : `#oom` (manque de mémoire GPU), `#missing` (nœud manquant), `#slow` (génération longue, pour tester l'annulation).

Les tests de bout en bout couvrent :
- clés et coffre : saisie, test et chiffrement des clés ; phrase de passe fausse ; verrouillage ; « ne pas mémoriser » ; tout effacer ;
- location : offres triées ; prix confirmé ; offre déjà louée ; corps de création sans clé principale ;
- démarrage : étapes jusqu'à « Prêt » ; modèles grisés ;
- génération : T2V, puis prolongation I2V à partir de la dernière image ; suppression des fichiers sur l'instance ;
- galerie : timeline réordonnée et assemblage ffmpeg.wasm ;
- erreurs : manque de mémoire GPU (OOM), nœud manquant, annulation ;
- Journal : aucun secret en clair ;
- instance : arrêt, redémarrage, destruction, reprise d'une instance arrêtée ;
- rappel avant de fermer l'onglet.

## 11. Ce qui a été vérifié, ce qui ne l'a pas été

**Vérifié pendant le développement :**

- **Documentation à jour (novembre 2026)** : routes et champs de l'API Vast.ai, `server.py` de ComfyUI v0.44, CLI `hf`, cloudflared, Caddy et ffmpeg.wasm.
- **Workflows** : les 7 workflows et 65 variantes d'options sont acceptés par un vrai ComfyUI v0.44.2. Seuls des fichiers de poids vides ont été utilisés, sans GPU.
- **Caddyfile** : testé avec le vrai Caddy 2.11.9 (jeton, CORS, en-têtes retirés, jeton masqué dans les logs).
- **Amorce `onstart`** : exécutée réellement (téléchargement, vérification SHA-256, refus d'un fichier modifié).
- **Agent** (`agent.py`) : téléchargements, erreur de licence, watchdog et arrêt via la clé restreinte, testés contre de faux serveurs.
- **Worker** : configuration validée par `wrangler deploy --dry-run`.
- **Interface** : parcours complet testé contre les mocks.

**Non vérifiable sans tes comptes (ton premier test réel le fera) :**

- **Vast.ai réel** : le comportement de l'API, l'injection de `CONTAINER_API_KEY` dans l'image choisie, et l'exécution de `onstart` à chaque redémarrage.
- **Hugging Face depuis le navigateur** : la réponse CORS de `huggingface.co`. Si elle bloque le test, l'interface le signale et l'instance vérifie le token elle-même.
- **Génération sur GPU** : vitesse réelle et consommation mémoire des modèles sur RTX PRO 6000 ou RTX 5090.
- **Tunnel** : la stabilité des tunnels `trycloudflare.com` sur la durée.

Si quelque chose échoue, colle-moi le **Journal** (bouton **Copier**) : je corrigerai à partir de là.
