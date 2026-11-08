(() => {
  "use strict";

  const cfg = window.AI_VIDEO_CONFIG || {};
  const repo = detectRepo();
  const WORKFLOW = cfg.workflow || "ai-video-generate.yml";
  const API = "https://api.github.com";
  const TOKEN_KEY = "aiVideoToken";

  const $ = (id) => document.getElementById(id);
  const form = $("form");
  const promptEl = $("prompt");
  const durationEl = $("duration");
  const message = $("message");
  const gallery = $("gallery");
  const queue = $("queue");
  const queueSection = $("queueSection");

  let pollTimer = null;
  let knownRunning = new Set();

  // ------------------------------------------------------------------ helpers
  function detectRepo() {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
    if (m) {
      const seg = location.pathname.split("/").filter(Boolean)[0];
      return { owner: m[1], repo: seg || `${m[1]}.github.io` };
    }
    return { owner: cfg.owner, repo: cfg.repo };
  }

  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
    del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
  };

  const token = () => storage.get(TOKEN_KEY) || "";

  function say(text, kind = "") {
    message.textContent = text;
    message.className = `message ${kind}`;
  }

  async function gh(path, options = {}) {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    };
    if (token()) headers.Authorization = `Bearer ${token()}`;
    const res = await fetch(`${API}${path}`, { ...options, headers });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).message || ""; } catch { /* ignore */ }
      const err = new Error(`GitHub ${res.status}${detail ? ` : ${detail}` : ""}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  function fmtDate(iso) {
    try {
      return new Date(iso).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
    } catch { return iso || ""; }
  }

  function since(iso) {
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
  }

  // ------------------------------------------------------------------ request
  function readForm() {
    const seed = $("seed").value.trim();
    return {
      prompt: promptEl.value.trim(),
      engine: $("engine").value,
      format: form.querySelector("input[name=format]:checked").value,
      duration: Number(durationEl.value),
      seed: seed === "" ? null : Number(seed),
      enhance: $("enhance").checked,
      negative_prompt: $("negative").value.trim(),
    };
  }

  function issueUrl(req) {
    const short = req.prompt.length > 70 ? `${req.prompt.slice(0, 67)}…` : req.prompt;
    const body = [
      "Demande envoyée depuis le studio vidéo IA (GitHub Pages).",
      "Validez l'issue : le workflow génère la vidéo, la publie dans la galerie puis répond ici.",
      "",
      "```json",
      JSON.stringify(req, null, 2),
      "```",
      "",
    ].join("\n");
    const q = `title=${encodeURIComponent(`[video] ${short}`)}&body=${encodeURIComponent(body)}`;
    return `https://github.com/${repo.owner}/${repo.repo}/issues/new?${q}`;
  }

  async function dispatch(req) {
    await gh(`/repos/${repo.owner}/${repo.repo}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: cfg.ref || "main",
        inputs: {
          prompt: req.prompt,
          engine: req.engine,
          format: req.format,
          duration: String(req.duration),
          seed: req.seed === null ? "" : String(req.seed),
          enhance: String(req.enhance),
        },
      }),
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const req = readForm();
    if (!req.prompt) { promptEl.focus(); return; }
    const button = $("submit");
    button.disabled = true;
    try {
      if (token()) {
        say("Envoi au workflow…");
        await dispatch(req);
        say("✅ Génération lancée. Suivi ci-dessous ; la vidéo arrive dans la galerie en quelques minutes.", "ok");
        setTimeout(() => refreshQueue(true), 4000);
      } else {
        const url = issueUrl(req);
        const win = window.open(url, "_blank");
        if (win) win.opener = null; else location.href = url;
        say("Une issue pré-remplie s'ouvre sur GitHub : cliquez sur « Create » pour lancer la génération.", "ok");
        setTimeout(() => refreshQueue(true), 20000);
      }
    } catch (err) {
      const hint = err.status === 401 || err.status === 403 || err.status === 404
        ? " Vérifiez que le token a la permission « Actions : Read and write » sur ce dépôt."
        : "";
      say(`❌ ${err.message}.${hint}`, "err");
    } finally {
      button.disabled = false;
    }
  });

  // -------------------------------------------------------------------- queue
  async function refreshQueue(force = false) {
    let runs = [];
    try {
      const data = await gh(`/repos/${repo.owner}/${repo.repo}/actions/workflows/${WORKFLOW}/runs?per_page=10`);
      runs = data.workflow_runs || [];
    } catch (err) {
      if (force) console.warn("Suivi indisponible :", err.message);
      return schedulePoll(knownRunning.size > 0);
    }

    const recent = runs.filter((r) =>
      r.status !== "completed" ||
      (r.conclusion !== "skipped" && Date.now() - new Date(r.updated_at).getTime() < 15 * 60 * 1000));
    const active = recent.filter((r) => r.status !== "completed");

    // A run we were watching just finished: reload the gallery.
    const activeIds = new Set(active.map((r) => r.id));
    if ([...knownRunning].some((id) => !activeIds.has(id))) loadGallery();
    knownRunning = activeIds;

    queue.replaceChildren(...recent.map(renderRun));
    queueSection.hidden = recent.length === 0;
    schedulePoll(active.length > 0);
  }

  function renderRun(run) {
    const li = document.createElement("li");
    const title = document.createElement("a");
    title.className = "title";
    title.href = run.html_url;
    title.target = "_blank";
    title.rel = "noopener";
    title.textContent = (run.display_title || run.name || "").replace(/^🎬\s*/, "");
    const badge = document.createElement("span");
    const states = {
      queued: ["En file d'attente", ""],
      waiting: ["En attente", ""],
      in_progress: [`En cours · ${since(run.run_started_at || run.created_at)}`, "warn"],
      success: ["Terminé ✓", "ok"],
      failure: ["Échec", "err"],
      cancelled: ["Annulé", "err"],
    };
    const key = run.status === "completed" ? run.conclusion : run.status;
    const [label, kind] = states[key] || [key, ""];
    badge.className = `badge ${kind}`;
    badge.textContent = label;
    li.append(title, badge);
    return li;
  }

  function schedulePoll(active) {
    clearTimeout(pollTimer);
    if (!active) return;
    // Unauthenticated API calls are limited to 60/hour: poll slowly without token.
    pollTimer = setTimeout(refreshQueue, token() ? 15000 : 75000);
  }

  // ------------------------------------------------------------------ gallery
  async function loadGallery() {
    let videos = [];
    try {
      const res = await fetch(`videos/index.json?t=${Date.now()}`, { cache: "no-store" });
      if (res.ok) videos = (await res.json()).videos || [];
    } catch { /* first deploy: no index yet */ }

    $("count").textContent = videos.length ? `(${videos.length})` : "";
    if (!videos.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "Aucune vidéo pour l'instant — lancez votre première génération !";
      gallery.replaceChildren(empty);
      return;
    }
    gallery.replaceChildren(...videos.map(renderVideo));
  }

  function renderVideo(v) {
    const node = $("cardTpl").content.firstElementChild.cloneNode(true);
    const video = node.querySelector("video");
    video.src = `videos/${v.file}`;
    if (v.poster) video.poster = `videos/${v.poster}`;
    if (v.width && v.height) video.style.aspectRatio = `${v.width} / ${v.height}`;
    if (v.audio) video.muted = false;

    node.querySelector(".prompt").textContent = v.prompt;
    if (v.prompt_used && v.prompt_used !== v.prompt) node.querySelector(".prompt").title = `Prompt envoyé : ${v.prompt_used}`;

    const engine = v.engine === "hf" ? "GPU" : "CPU";
    const model = String(v.model || "").split("/").pop().split(" ")[0];
    const bits = [
      `${engine} · ${model}`,
      v.duration ? `${v.duration} s` : "",
      v.audio ? "🔊 son" : "",
      v.width ? `${v.width}×${v.height}` : "",
      fmtDate(v.created),
    ].filter(Boolean);
    node.querySelector(".meta").textContent = bits.join(" · ");

    const dl = node.querySelector(".dl");
    dl.href = `videos/${v.file}`;
    dl.setAttribute("download", v.file);

    const run = node.querySelector(".run");
    if (v.run) run.href = v.run; else run.remove();

    node.querySelector(".reuse").addEventListener("click", () => {
      promptEl.value = v.prompt;
      const radio = form.querySelector(`input[name=format][value=${v.format}]`);
      if (radio) radio.checked = true;
      if (v.seed !== null && v.seed !== undefined) $("seed").value = v.seed;
      promptEl.scrollIntoView({ behavior: "smooth", block: "center" });
      promptEl.focus({ preventScroll: true });
    });
    return node;
  }

  // ----------------------------------------------------------------- settings
  function updateModeHint() {
    $("modeHint").textContent = token()
      ? "Mode direct : le workflow démarre immédiatement (token enregistré dans ce navigateur)."
      : "Ouvre une issue pré-remplie sur GitHub (connexion requise) : validez-la pour lancer la génération.";
    $("token").value = token() ? "••••••••••••" : "";
  }

  $("saveToken").addEventListener("click", () => {
    const value = $("token").value.trim();
    if (value && !value.startsWith("•")) storage.set(TOKEN_KEY, value);
    updateModeHint();
    refreshQueue(true);
  });
  $("clearToken").addEventListener("click", () => { storage.del(TOKEN_KEY); updateModeHint(); });

  durationEl.addEventListener("input", () => { $("durationOut").textContent = `${durationEl.value} s`; });
  $("refresh").addEventListener("click", () => { loadGallery(); refreshQueue(true); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshQueue(); });

  $("repoLink").href = `https://github.com/${repo.owner}/${repo.repo}`;
  if (!repo.owner || !repo.repo) say("Renseignez owner/repo dans config.js.", "err");

  updateModeHint();
  loadGallery();
  refreshQueue(true);
})();
