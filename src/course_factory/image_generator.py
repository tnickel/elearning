"""AI Image Generator for Course Factory Interactive Slides.

Generates photorealistic slide illustration cues using:
- OpenRouter Image API (POST https://openrouter.ai/api/v1/images/generations)
  Default model: google/gemini-2.5-flash-image (fast, cost-effective).
- Strict API key check in live mode: fails if no API key is set.
- Mock mode for offline testing: generates crisp placeholder PNGs with PIL.
- PIL Resizing to target resolution (default 512x256).
- Parallel generation using ThreadPoolExecutor.
"""

import base64
import concurrent.futures
import io
import json
import os
import sys
from typing import Optional, Callable, List, Tuple
from PIL import Image, ImageDraw, ImageFont

from .schemas import VideoScriptSchema, Slide, ImageCue

# Add src/ai_service to sys.path so config can be imported directly
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_src = os.path.dirname(current_dir)
ai_service_path = os.path.join(parent_src, "ai_service")
if ai_service_path not in sys.path:
    sys.path.insert(0, ai_service_path)

try:
    import config
except ImportError:
    config = None


def get_image_api_key() -> str:
    """Retrieves OpenRouter or Gemini API key from config or environment."""
    key = ""
    if config is not None:
        try:
            key = config.get_openrouter_api_key()
        except Exception:
            key = ""
    if not key:
        key = os.getenv("OPENROUTER_API_KEY", "") or os.getenv("GEMINI_API_KEY", "")
    return key.strip()


def get_image_model() -> str:
    """Retrieves the configured image generation model name."""
    return os.getenv("OPENROUTER_IMAGE_MODEL", "google/gemini-2.5-flash-image")


def create_mock_cue_image(
    output_path: str,
    slide_num: int,
    cue_ts: int,
    prompt: str,
    target_size: Tuple[int, int] = (512, 256),
):
    """Creates a clean mock placeholder image using PIL for offline tests."""
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    w, h = target_size
    img = Image.new("RGB", (w, h), color=(18, 24, 38))
    draw = ImageDraw.Draw(img)

    # Decorative accent gradient / rectangle
    draw.rectangle([0, 0, w, 6], fill=(59, 130, 246))
    draw.rectangle([10, 10, w - 10, h - 10], outline=(40, 50, 75), width=2)

    # Draw informative text
    header = f"Folie {slide_num} • Cue {cue_ts}%"
    prompt_short = (prompt[:60] + "...") if len(prompt) > 60 else prompt
    note = "[Mock-Modus: Bildgenerierung]"

    draw.text((24, 28), header, fill=(147, 197, 253))
    draw.text((24, 60), prompt_short, fill=(203, 213, 225))
    draw.text((24, h - 36), note, fill=(100, 116, 139))

    img.save(output_path, "PNG", optimize=True)


def call_openrouter_image_api(
    prompt: str,
    api_key: str,
    model: str = "google/gemini-2.5-flash-image",
    timeout: float = 45.0,
) -> bytes:
    """Calls OpenRouter images/generations endpoint and returns raw image bytes."""
    import httpx

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://elearning-platform.local",
        "X-Title": "Course Factory Interactive Slides",
    }
    payload = {
        "model": model,
        "prompt": prompt,
    }

    url = os.getenv("OPENROUTER_IMAGE_URL", "https://openrouter.ai/api/v1/images/generations")
    response = httpx.post(url, headers=headers, json=payload, timeout=timeout)

    if response.status_code != 200:
        raise RuntimeError(
            f"OpenRouter Image API failed with HTTP {response.status_code}: {response.text}"
        )

    data = response.json()
    items = data.get("data", [])
    if not items:
        raise RuntimeError(f"OpenRouter Image API returned empty data array: {data}")

    first_item = items[0]
    if "b64_json" in first_item:
        return base64.b64decode(first_item["b64_json"])
    elif "url" in first_item:
        img_url = first_item["url"]
        img_res = httpx.get(img_url, timeout=timeout)
        if img_res.status_code != 200:
            raise RuntimeError(f"Failed to download image from URL {img_url}: {img_res.status_code}")
        return img_res.content
    else:
        raise RuntimeError(f"Unknown image response format from OpenRouter: {first_item}")


def resize_and_save_image(
    image_bytes: bytes,
    output_path: str,
    target_size: Tuple[int, int] = (512, 256),
):
    """Resizes image to target resolution (512x256) and saves as optimized PNG."""
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    img = Image.open(io.BytesIO(image_bytes))
    if img.mode != "RGB":
        img = img.convert("RGB")

    # Resize to exact requested resolution
    resized = img.resize(target_size, Image.Resampling.LANCZOS)
    resized.save(output_path, "PNG", optimize=True)


def format_web_image_url(output_path: str) -> str:
    """Converts a local filesystem path to a web URL starting with /course_output/ if applicable."""
    norm_path = output_path.replace("\\", "/")
    marker = "course_output/"
    if marker in norm_path:
        idx = norm_path.find(marker)
        return "/" + norm_path[idx:]
    return norm_path


def generate_single_cue_image(
    cue: ImageCue,
    slide_num: int,
    visual_style: Optional[str],
    output_dir: str,
    force_mock: bool,
    api_key: str,
    model: str,
    target_size: Tuple[int, int] = (512, 256),
) -> str:
    """Generates an image for a single ImageCue, saves it, and returns the web URL."""
    images_dir = os.path.join(output_dir, "images")
    filename = f"slide_{slide_num}_cue_{cue.timestamp_percent}.png"
    output_path = os.path.join(images_dir, filename)

    if force_mock:
        create_mock_cue_image(
            output_path=output_path,
            slide_num=slide_num,
            cue_ts=cue.timestamp_percent,
            prompt=cue.prompt,
            target_size=target_size,
        )
    else:
        if not api_key or api_key in ["mock-key", "mock-openrouter-key"]:
            raise RuntimeError(
                "Kein gültiger OPENROUTER_API_KEY konfiguriert! Bildgenerierung erfordert einen gültigen API-Key."
            )

        full_prompt = cue.prompt
        if visual_style:
            full_prompt = f"{full_prompt}. Stil: {visual_style}. Keine Texte, Beschriftungen oder Wasserzeichen."

        img_bytes = call_openrouter_image_api(prompt=full_prompt, api_key=api_key, model=model)
        resize_and_save_image(image_bytes=img_bytes, output_path=output_path, target_size=target_size)

    web_url = format_web_image_url(output_path)
    cue.image_url = web_url
    return web_url


def generate_slide_images(
    video_script: VideoScriptSchema,
    output_dir: str,
    force_mock: bool = False,
    max_workers: int = 4,
    target_size: Tuple[int, int] = (512, 256),
    on_progress: Optional[Callable[[str], None]] = None,
) -> VideoScriptSchema:
    """Generates all illustration cues for a VideoScriptSchema in parallel.

    Updates each ImageCue.image_url, resaves slides.json in output_dir, and returns updated schema.
    """
    api_key = get_image_api_key()
    model = get_image_model()

    # Collect all cues that need generation
    cue_tasks = []
    for slide in video_script.slides:
        if slide.image_cues:
            for cue in slide.image_cues:
                cue_tasks.append((slide.slide_number, cue))

    total_cues = len(cue_tasks)
    if total_cues == 0:
        if on_progress:
            on_progress("Keine Image-Cues in den Folien definiert.")
        return video_script

    if on_progress:
        mode_str = "Mock" if force_mock else f"OpenRouter ({model})"
        on_progress(f"🎨 Starte Bildgenerierung ({total_cues} Bilder via {mode_str}, {target_size[0]}x{target_size[1]})...")

    # Generate in parallel with ThreadPoolExecutor
    completed = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_cue = {
            executor.submit(
                generate_single_cue_image,
                cue=cue,
                slide_num=slide_num,
                visual_style=video_script.visual_style,
                output_dir=output_dir,
                force_mock=force_mock,
                api_key=api_key,
                model=model,
                target_size=target_size,
            ): (slide_num, cue)
            for slide_num, cue in cue_tasks
        }

        for future in concurrent.futures.as_completed(future_to_cue):
            slide_num, cue = future_to_cue[future]
            try:
                web_url = future.result()
                completed += 1
                if on_progress:
                    on_progress(
                        f"🎨 Bild {completed}/{total_cues} fertig: Folie {slide_num} (Cue {cue.timestamp_percent}%)"
                    )
            except Exception as exc:
                if force_mock:
                    print(f"[ImageGenerator] Warning generating mock image for slide {slide_num}: {exc}")
                else:
                    raise RuntimeError(
                        f"Fehler bei Bildgenerierung für Folie {slide_num} (Cue {cue.timestamp_percent}%): {exc}"
                    ) from exc

    # Resave slides.json with populated image_urls
    slides_path = os.path.join(output_dir, "slides.json")
    if os.path.exists(output_dir):
        with open(slides_path, "w", encoding="utf-8") as f:
            json.dump(video_script.model_dump(), f, indent=2, ensure_ascii=False)

    if on_progress:
        on_progress(f"✅ Alle {completed} Folienbilder erfolgreich generiert und in slides.json verknüpft.")

    return video_script
