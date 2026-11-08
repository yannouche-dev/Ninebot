# 🎬 Studio vidéo IA gratuit (GitHub Pages + GitHub Actions)

Décrivez une scène sur une page GitHub Pages ; un workflow GitHub Actions génère
la vidéo, la publie dans une galerie sur la même page et vous répond.
Coût : **0 €**. Pas de serveur, pas de carte bancaire.

```
GitHub Pages (formulaire + galerie)
        │  issue « [video] … » pré-remplie   (ou API workflow_dispatch avec un token)
        ▼
GitHub Actions : ai-video-generate.yml
        ├─ 1. GPU gratuit : Space Hugging Face ZeroGPU (LTX-2.5 → LTX-2.3 → LTX-Video)
        └─ 2. repli CPU   : AnimateDiff-Lightning sur le runner (illimité)
        ▼
branche ai-videos (mp4 + vignette + métadonnées) ──► déploiement GitHub Pages
```

## Pourquoi cette architecture

| Brique | Rôle | Gratuité |
|---|---|---|
| **GitHub Pages** | Interface + galerie (site statique : il ne peut pas exécuter de modèle) | Gratuit pour un dépôt public |
| **GitHub Actions** | Orchestration, encodage, publication | Minutes **illimitées** sur un dépôt public (runner 4 vCPU / 16 Go, **sans GPU**) |
| **Spaces Hugging Face ZeroGPU** | Le calcul GPU : LTX-2.5 / LTX-2.3 de Lightricks, vidéo **avec son** | Quota GPU quotidien gratuit (quelques minutes/jour, soit plusieurs clips) |
| **AnimateDiff-Lightning (CPU)** | Repli quand le quota GPU est épuisé | Illimité, mais ~10–20 min par clip et qualité inférieure |

Les runners gratuits de GitHub n'ont pas de GPU : exécuter un vrai modèle vidéo
moderne directement dans Actions prendrait des heures. La solution consiste donc à
utiliser Actions comme chef d'orchestre et à emprunter le GPU gratuit des Spaces
Hugging Face via `gradio_client`, avec un moteur CPU en secours pour ne jamais
rester bloqué.

## Mise en route (5 minutes)

1. **Fusionner** cette branche dans `main` (les workflows `workflow_dispatch` et
   `issues` ne s'exécutent que depuis la branche par défaut).
2. **Activer Pages** : *Settings → Pages → Build and deployment → Source :
   **GitHub Actions***.
3. **Token Hugging Face (recommandé)** : créez un compte gratuit sur
   huggingface.co, puis *Settings → Access Tokens → New token* (type **Read**).
   Dans le dépôt GitHub : *Settings → Secrets and variables → Actions → New
   repository secret*, nom **`HF_TOKEN`**. Sans token, le quota anonyme est minime.
4. **Premier déploiement** : onglet *Actions → « Vidéo IA – site GitHub Pages » →
   Run workflow* (il se lance aussi tout seul après chaque vidéo).
5. Ouvrez `https://<utilisateur>.github.io/<dépôt>/` — ici
   **https://yannouche-dev.github.io/Ninebot/**.

## Utilisation

- **Depuis la page** : remplissez le formulaire et cliquez sur *Générer la vidéo*.
  Une issue pré-remplie s'ouvre sur GitHub ; cliquez sur *Create*. Le workflow
  commente l'issue au démarrage, puis poste la vidéo et ferme l'issue.
- **Mode direct (optionnel)** : collez dans la page un token *fine-grained* limité à
  ce dépôt avec la permission *Actions : Read and write*. Le bouton lance alors le
  workflow sans issue et la page affiche la progression. Le token reste dans le
  `localStorage` du navigateur et n'est envoyé qu'à `api.github.com`.
- **Depuis GitHub** : *Actions → « Vidéo IA – générer » → Run workflow*, ou une
  issue dont le titre commence par `[video]` (le corps ou le titre = la description).
- La vidéo est aussi téléchargeable comme artefact du workflow (30 jours).

Seuls le propriétaire du dépôt et ses collaborateurs peuvent déclencher une
génération via une issue : un inconnu ne peut pas consommer votre quota.

## Moteurs

| | `hf` (GPU, par défaut) | `cpu` (repli) |
|---|---|---|
| Modèle | LTX-2.5, sinon LTX-2.3, sinon LTX-Video 0.9 (Lightricks) | AnimateDiff-Lightning 4 étapes + epiCRealism (SD 1.5) |
| Son | Oui (LTX-2.x) | Non |
| Résolution | 768×448 à 896×512 (16:9), 640×640 | 640×384, 512×512 |
| Durée | 2–8 s | 2–6 s (8 images/s interpolées à 24) |
| Temps | ~30 s à 2 min | ~10–20 min |
| Limite | Quota ZeroGPU du compte HF (recharge 24 h après la 1re utilisation) | Aucune (timeout 90 min) |
| Prompt | Enrichi par l'« enhancer » du Space ; le français est accepté | Traduit en anglais en local (opus-mt-fr-en) |

En mode `auto`, si tous les Spaces échouent (quota épuisé, Space en panne), le
workflow bascule automatiquement sur le CPU.

## Personnalisation

Variables de dépôt (*Settings → Secrets and variables → Actions → Variables*) :

- `AI_VIDEO_HF_SPACES` : liste ordonnée de Spaces, séparés par des virgules, au
  format `propriétaire/space` ou `propriétaire/space:/endpoint`
  (défaut : `Lightricks/LTX-2.5:/run,Lightricks/LTX-2-3:/generate_video,Lightricks/ltx-video-distilled:/text_to_video`).
  Les paramètres (prompt, largeur, hauteur, durée, seed…) sont reconnus
  automatiquement par leur nom, donc d'autres Spaces texte→vidéo fonctionnent
  souvent tels quels.

Pour trouver un Space de remplacement et voir ses paramètres :

```bash
pip install -r ai-video/requirements-hf.txt
python ai-video/scripts/probe_spaces.py --discover            # liste + API
python ai-video/scripts/probe_spaces.py Lightricks/LTX-2.5    # un Space précis
```

Variables d'environnement reconnues par `generate.py` : `AI_VIDEO_HF_LONG_SIDE`,
`AI_VIDEO_CPU_STEPS` (1, 2, 4 ou 8), `AI_VIDEO_CPU_BASE` (modèle SD 1.5),
`AI_VIDEO_CPU_LONG_SIDE`.

## Stockage

Les vidéos sont commitées sur la branche **`ai-videos`** (pas sur `main`, dont
l'historique reste propre). GitHub Pages est limité à 1 Go : supprimez les
anciennes vidéos de `ai-videos/videos/` (les trois fichiers `.mp4`, `.jpg` et
`.json` d'un même identifiant) puis relancez le workflow du site.

## Fichiers

```
.github/workflows/ai-video-generate.yml  génération (dispatch + issues)
.github/workflows/ai-video-pages.yml     assemblage + déploiement GitHub Pages
ai-video/site/                           page (HTML/CSS/JS, sans dépendance)
ai-video/scripts/request.py              lecture de la demande (inputs ou issue)
ai-video/scripts/generate.py             moteurs hf / cpu, encodage H.264, vignette
ai-video/scripts/publish.sh              commit sur la branche ai-videos
ai-video/scripts/build_index.py          index JSON de la galerie
ai-video/scripts/probe_spaces.py         inspection des Spaces Hugging Face
```

## Dépannage

- **« quota » / « ZeroGPU » dans les logs** : quota GPU du jour épuisé. Attendez
  la recharge, laissez le mode `auto` passer sur le CPU, ou utilisez un autre
  compte HF. (Un abonnement HF PRO multiplie le quota, mais n'est pas nécessaire.)
- **Space en `RUNTIME_ERROR` / `PAUSED`** : le Space est en panne ; le suivant de
  la liste est essayé. Mettez à jour `AI_VIDEO_HF_SPACES` si besoin.
- **Le site ne se met pas à jour** : vérifiez que Pages utilise la source
  « GitHub Actions » et regardez le job *pages* du workflow.
- **Rien ne se passe après l'issue** : le titre doit commencer par `[video]` et
  l'auteur doit être propriétaire ou collaborateur du dépôt.

Licences des modèles : LTX-2 (Lightricks, licence LTX-2 Community),
AnimateDiff-Lightning (CreativeML OpenRAIL-M), epiCRealism (CreativeML OpenRAIL-M).
Vérifiez-les avant un usage commercial.
