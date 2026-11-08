"""Generate a short AI video from request.json.

    python generate.py --engine hf  --request request.json --out OUT_DIR
    python generate.py --engine cpu --request request.json --out OUT_DIR

Engines
  hf   Calls a free Hugging Face Space running on ZeroGPU (LTX-Video by default)
       through gradio_client. Best quality; uses the daily free GPU quota of
       the account behind HF_TOKEN (a few short clips per day).
  cpu  Runs AnimateDiff-Lightning (Stable Diffusion 1.5) on the GitHub Actions
       runner CPU. Unlimited and needs no account, but slower and simpler.

Produces OUT_DIR/video.mp4 (H.264 + faststart, plays in every browser),
OUT_DIR/poster.jpg and OUT_DIR/meta.json.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

VIDEO_EXT = (".mp4", ".webm", ".mov", ".mkv", ".gif", ".avi")
RATIOS = {"landscape": (16, 9), "portrait": (9, 16), "square": (1, 1)}

# "space_id" or "space_id:/api_name", tried in order. Override with the
# AI_VIDEO_HF_SPACES repository variable (comma separated).
DEFAULT_HF_SPACES = ",".join([
    "Lightricks/LTX-2.5:/run",                         # LTX-2.5 distilled, video + audio
    "Lightricks/LTX-2-3:/generate_video",              # LTX-2.3, video + audio
    "Lightricks/ltx-video-distilled:/text_to_video",   # LTX-Video 0.9.x, silent
])


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def frame_size(fmt: str, long_side: int, multiple: int) -> tuple[int, int]:
    rw, rh = RATIOS.get(fmt, RATIOS["landscape"])
    snap = lambda v: max(multiple, int(round(v / multiple)) * multiple)  # noqa: E731
    if rw >= rh:
        return snap(long_side), snap(long_side * rh / rw)
    return snap(long_side * rw / rh), snap(long_side)


def ffmpeg_exe() -> str:
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        exe = shutil.which("ffmpeg")
        if not exe:
            raise RuntimeError("ffmpeg introuvable (pip install imageio-ffmpeg)")
        return exe


# ============================================================ Hugging Face Space
def _param_key(p: dict) -> str:
    return f"{p.get('parameter_name') or ''} {p.get('label') or ''}".lower()


def _choose_enum(enum: list, key: str, fmt: str, size: tuple[int, int], default):
    """Pick a choice of a Radio/Dropdown parameter."""
    texts = [str(e) for e in enum]
    # Generation mode: prefer text-to-video.
    for i, t in enumerate(texts):
        if re.search(r"text.?(to|2).?video|\bt2v\b", t, re.I):
            return enum[i]
    # Orientation words.
    words = {
        "landscape": r"landscape|paysage|horizontal|wide|16:9",
        "portrait": r"portrait|vertical|9:16|tall",
        "square": r"square|carr|1:1",
    }
    for i, t in enumerate(texts):
        if re.search(words[fmt], t, re.I):
            return enum[i]
    # Resolutions / aspect ratios like "768x512" or "16:9".
    target = size[0] / size[1]
    best, best_score = None, None
    for i, t in enumerate(texts):
        m = re.search(r"(\d+)\s*[x×:*]\s*(\d+)", t)
        if not m or int(m.group(2)) == 0:
            continue
        ratio = int(m.group(1)) / int(m.group(2))
        score = abs(ratio - target)
        if best_score is None or score < best_score - 1e-6:
            best, best_score = enum[i], score
    if best is not None:
        return best
    return default if default is not None else enum[0]


def _bounds(p: dict) -> tuple[float, float] | None:
    """Slider limits, from the "numeric value between A and B" API description."""
    text = " ".join(
        str((p.get(k) or {}).get("description") or "") for k in ("type", "python_type") if isinstance(p.get(k), dict)
    )
    m = re.search(r"between\s+(-?\d+(?:\.\d+)?)\s+and\s+(-?\d+(?:\.\d+)?)", text)
    return (float(m.group(1)), float(m.group(2))) if m else None


def _clamp(p: dict, value):
    b = _bounds(p)
    if b is None or not isinstance(value, (int, float)):
        return value
    clamped = min(max(value, b[0]), b[1])
    return int(clamped) if isinstance(value, int) else clamped


def _hf_size(params: list, fmt: str) -> tuple[int, int]:
    """Frame size for the request format, raised to the Space's minimum side."""
    long_side = int(os.environ.get("AI_VIDEO_HF_LONG_SIDE") or (640 if fmt == "square" else 768))
    w, h = frame_size(fmt, long_side, 32)
    mins = [b[0] for p in params if re.search(r"height|width", _param_key(p)) and (b := _bounds(p))]
    if mins and min(w, h) < max(mins):
        f = max(mins) / min(w, h)
        w, h = (math.ceil(v * f / 32 - 1e-6) * 32 for v in (w, h))
    return w, h


def _fill_param(p: dict, req: dict, size: tuple[int, int]):
    key = _param_key(p)
    ptype = str((p.get("python_type") or {}).get("type") or "")
    component = str(p.get("component") or "").lower()
    schema = p.get("type") or {}
    enum = schema.get("enum") if isinstance(schema, dict) else None
    has_default = p.get("parameter_has_default", False)
    default = p.get("parameter_default") if has_default else None

    is_file = component in ("image", "video", "audio", "file", "imageeditor", "gallery") or "filepath" in ptype
    is_bool = component == "checkbox" or ptype == "bool"
    is_num = component in ("slider", "number") or ptype in ("int", "float", "int | float", "float | int")
    seed = req.get("seed")

    if is_file:
        return default
    if is_bool:
        if "random" in key and "seed" in key:
            return seed is None
        if "enhance" in key and "prompt" in key or re.search(r"\bdo_enhance\b", key):
            return bool(req.get("enhance", True))
        return default
    if enum:
        return _choose_enum(enum, key, req["format"], size, default)
    if "negative" in key:
        return req.get("negative_prompt") or default or ""
    if "prompt" in key and not is_num:
        return req.get("prompt_en") or req["prompt"]
    if is_num:
        if "height" in key:
            return _clamp(p, size[1])
        if "width" in key:
            return _clamp(p, size[0])
        if "duration" in key or re.search(r"\bseconds?\b|duration_s", key):
            return _clamp(p, req["duration"])
        if "seed" in key:
            return seed if seed is not None else (default if default is not None else 0)
    return default


def _pick_endpoint(endpoints: dict, wanted: str | None) -> str:
    if wanted:
        if wanted in endpoints:
            return wanted
        raise RuntimeError(f"endpoint {wanted} absent ({', '.join(endpoints)})")
    names = list(endpoints)
    for pattern in (r"text.?to.?video|t2v", r"generate|infer|run|predict"):
        for name in names:
            if re.search(pattern, name, re.I):
                return name
    for name in names:
        if any("prompt" in _param_key(p) for p in endpoints[name].get("parameters", [])):
            return name
    raise RuntimeError("aucun endpoint de génération trouvé")


def _find_video(value):
    if isinstance(value, str):
        if value.lower().endswith(VIDEO_EXT) and os.path.exists(value):
            return value
        return None
    if isinstance(value, dict):
        for k in ("video", "path", "value", "name"):
            found = _find_video(value.get(k))
            if found:
                return found
        return None
    if isinstance(value, (list, tuple)):
        for item in value:
            found = _find_video(item)
            if found:
                return found
    return None


def _find_text(value):
    """A long text output (e.g. the enhanced prompt actually sent to the model)."""
    if isinstance(value, (list, tuple)):
        for item in value:
            if isinstance(item, str) and len(item) > 30 and not os.path.exists(item):
                return item
    return None


def _find_seed(value):
    if isinstance(value, (list, tuple)):
        for item in value:
            if isinstance(item, int) and not isinstance(item, bool):
                return item
    return None


def run_hf(req: dict, work: Path) -> dict:
    from gradio_client import Client

    token = os.environ.get("HF_TOKEN") or None
    if not token:
        log("Pas de secret HF_TOKEN : quota anonyme (très faible). Ajoute un token gratuit !")
    spaces = os.environ.get("AI_VIDEO_HF_SPACES") or DEFAULT_HF_SPACES
    errors = []
    for entry in [s.strip() for s in spaces.split(",") if s.strip()]:
        space, _, api_name = entry.partition(":")
        try:
            log(f"Space {space} …")
            client = Client(space, token=token, verbose=False, download_files=str(work / "hf"))
            endpoints = client.view_api(print_info=False, return_format="dict")["named_endpoints"]
            api_name = _pick_endpoint(endpoints, api_name or None)
            params = endpoints[api_name].get("parameters", [])
            size = _hf_size(params, req["format"])
            args = [_fill_param(p, req, size) for p in params]
            for p, a in zip(params, args):
                shown = a if not isinstance(a, str) or len(a) < 80 else a[:77] + "..."
                log(f"  {p.get('parameter_name') or p.get('label')} = {shown!r}")
            started = time.time()
            result = client.predict(*args, api_name=api_name)
            video = _find_video(result)
            if not video:
                raise RuntimeError(f"pas de vidéo dans la réponse: {str(result)[:300]}")
            log(f"Vidéo reçue en {time.time() - started:.0f}s : {video}")
            return {
                "file": video,
                "engine": "hf",
                "model": space,
                "endpoint": api_name,
                "seed": _find_seed(result) if req.get("seed") is None else req["seed"],
                "prompt_used": _find_text(result),
                "width": size[0],
                "height": size[1],
            }
        except Exception as exc:  # noqa: BLE001
            msg = f"{space}: {type(exc).__name__}: {str(exc)[:500]}"
            log(msg)
            errors.append(msg)
            if re.search(r"quota|exceeded your|GPU limit", str(exc), re.I):
                # Every ZeroGPU Space draws on the same per-account daily quota.
                log("→ Quota GPU gratuit épuisé (il se recharge 24 h après la 1re utilisation).")
                break
    raise RuntimeError("Tous les Spaces ont échoué:\n" + "\n".join(errors))


# =========================================================== CPU (AnimateDiff)
CPU_QUALITY = "masterpiece, best quality, highly detailed, cinematic lighting, smooth motion"
FR_HINTS = set(
    "le la les un une des du de d l qui sur sous dans avec et au aux en est son sa ses par pour "
    "vers entre chat chien voiture ciel nuit mer plage ville forêt montagne coucher soleil".split()
)


def looks_french(text: str) -> bool:
    words = re.findall(r"[a-zàâçéèêëîïôûùüÿœ]+", text.lower())
    score = sum(w in FR_HINTS for w in words) + len(re.findall(r"[àâçéèêëîïôûùüÿœ]", text.lower()))
    return score >= 2


def to_english(text: str) -> str:
    """Stable Diffusion 1.5 only understands English: translate French prompts locally."""
    if not looks_french(text):
        return text
    try:
        from transformers import MarianMTModel, MarianTokenizer

        name = "Helsinki-NLP/opus-mt-fr-en"
        tok = MarianTokenizer.from_pretrained(name)
        model = MarianMTModel.from_pretrained(name)
        batch = tok([text], return_tensors="pt", truncation=True, max_length=256)
        out = model.generate(**batch, max_new_tokens=160)
        english = tok.decode(out[0], skip_special_tokens=True).strip()
        del model, tok
        log(f"Traduction : {english}")
        return english or text
    except Exception as exc:  # noqa: BLE001
        log(f"Traduction impossible ({exc}), prompt d'origine utilisé.")
        return text


def run_cpu(req: dict, work: Path) -> dict:
    import torch
    from diffusers import AnimateDiffPipeline, EulerDiscreteScheduler, MotionAdapter
    from huggingface_hub import hf_hub_download
    from PIL import Image
    from safetensors.torch import load_file

    torch.set_num_threads(os.cpu_count() or 4)
    steps = int(os.environ.get("AI_VIDEO_CPU_STEPS", 4))  # 1, 2, 4 or 8
    base = os.environ.get("AI_VIDEO_CPU_BASE", "emilianJR/epiCRealism")
    # One 16-frame window takes ~5 min on a 4-vCPU runner; more frames use
    # FreeNoise windows and multiply the time. The clip is then slowed down
    # (up to 2x) and motion-interpolated to 24 fps to reach the duration.
    frames = int(os.environ.get("AI_VIDEO_CPU_FRAMES", 16))
    play_fps = min(8.0, max(4.0, frames / req["duration"]))
    long_side = int(os.environ.get("AI_VIDEO_CPU_LONG_SIDE") or (512 if req["format"] == "square" else 640))
    width, height = frame_size(req["format"], long_side, 64)
    seed = req.get("seed")
    if seed is None:
        seed = int.from_bytes(os.urandom(4), "little")

    subject = to_english(req["prompt"]) if req.get("enhance", True) else req["prompt"]
    prompt = f"{subject}, {CPU_QUALITY}"

    log(f"Chargement AnimateDiff-Lightning {steps} étapes + {base}")
    ckpt = hf_hub_download("ByteDance/AnimateDiff-Lightning", f"animatediff_lightning_{steps}step_diffusers.safetensors")
    adapter = MotionAdapter()
    adapter.load_state_dict(load_file(ckpt, device="cpu"))
    pipe = AnimateDiffPipeline.from_pretrained(base, motion_adapter=adapter, torch_dtype=torch.float32)
    pipe.scheduler = EulerDiscreteScheduler.from_config(
        pipe.scheduler.config, timestep_spacing="trailing", beta_schedule="linear"
    )
    if frames > 16:
        pipe.enable_free_noise(context_length=16, context_stride=8)

    log(f"Génération {frames} images {width}x{height}, seed {seed} : {prompt}")
    started = time.time()
    with torch.inference_mode():
        out = pipe(
            prompt=prompt,
            guidance_scale=1.0,
            num_inference_steps=steps,
            num_frames=frames,
            width=width,
            height=height,
            generator=torch.Generator("cpu").manual_seed(seed),
            output_type="latent",
        )
        log(f"Diffusion terminée en {time.time() - started:.0f}s, décodage image par image…")
        # Decoding all frames in one batch needs >16 GB of RAM: do it one by one.
        latents = out.frames
        vae = pipe.vae
        pipe.unet = None
        frames_dir = work / "frames"
        frames_dir.mkdir(parents=True, exist_ok=True)
        for i in range(latents.shape[2]):
            img = vae.decode(latents[:, :, i] / vae.config.scaling_factor).sample[0]
            arr = ((img.float() / 2 + 0.5).clamp(0, 1) * 255).round().to(torch.uint8).permute(1, 2, 0).numpy()
            Image.fromarray(arr).save(frames_dir / f"{i:04d}.png")
    log(f"Images prêtes en {time.time() - started:.0f}s")

    raw = work / "cpu_raw.mp4"
    subprocess.run(
        [ffmpeg_exe(), "-y", "-loglevel", "error", "-framerate", f"{play_fps:.3f}", "-i", str(frames_dir / "%04d.png"),
         "-vf", "minterpolate=fps=24:mi_mode=mci:mc_mode=aobmc:vsbmc=1",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", str(raw)],
        check=True,
    )
    return {
        "file": str(raw),
        "engine": "cpu",
        "model": f"ByteDance/AnimateDiff-Lightning ({steps} steps) + {base}",
        "prompt_used": subject if subject != req["prompt"] else None,
        "seed": seed,
        "width": width,
        "height": height,
    }


# ===================================================================== output
def finalize(result: dict, req: dict, out: Path) -> dict:
    ff = ffmpeg_exe()
    video = out / "video.mp4"
    subprocess.run(
        [ff, "-y", "-loglevel", "error", "-i", result["file"],
         "-map", "0:v:0", "-map", "0:a:0?",
         "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
         "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(video)],
        check=True,
    )
    subprocess.run(
        [ff, "-y", "-loglevel", "error", "-ss", "0.5", "-i", str(video), "-frames:v", "1",
         "-vf", "scale='min(640,iw)':-2", "-q:v", "4", str(out / "poster.jpg")],
        check=False,
    )
    seconds = None
    try:
        import imageio_ffmpeg

        _, seconds = imageio_ffmpeg.count_frames_and_secs(str(video))
    except Exception:  # noqa: BLE001
        pass
    probe = subprocess.run([ff, "-hide_banner", "-i", str(video)], capture_output=True, text=True)
    has_audio = "Audio:" in probe.stderr

    meta = {
        "id": req["id"],
        "created": req["created"],
        "prompt": req["prompt"],
        "prompt_used": result.get("prompt_used"),
        "engine": result["engine"],
        "model": result["model"],
        "seed": result.get("seed"),
        "format": req["format"],
        "width": result.get("width"),
        "height": result.get("height"),
        "duration": round(seconds, 2) if seconds else req["duration"],
        "audio": has_audio,
        "size": video.stat().st_size,
        "file": f"{req['id']}.mp4",
        "poster": f"{req['id']}.jpg" if (out / "poster.jpg").exists() else None,
        "run": _run_url(),
        "issue": req.get("issue"),
    }
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    return meta


def _run_url() -> str | None:
    server, repo, run = (os.environ.get(k) for k in ("GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID"))
    return f"{server}/{repo}/actions/runs/{run}" if server and repo and run else None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", choices=("hf", "cpu"), required=True)
    parser.add_argument("--request", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    req = json.loads(Path(args.request).read_text())
    out = Path(args.out)
    work = out / "_work"
    work.mkdir(parents=True, exist_ok=True)

    started = time.time()
    result = (run_hf if args.engine == "hf" else run_cpu)(req, work)
    meta = finalize(result, req, out)
    shutil.rmtree(work, ignore_errors=True)
    log(f"OK en {time.time() - started:.0f}s → {out / 'video.mp4'} ({meta['size'] / 1e6:.1f} Mo)")
    print(json.dumps(meta, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
