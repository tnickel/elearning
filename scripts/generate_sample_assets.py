"""Generate realistic images and audio for Sample Minikurs."""

import os
import sys
import httpx
from dotenv import load_dotenv

# Ensure root dir in path
current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(current_dir)
if root_dir not in sys.path:
    sys.path.insert(0, root_dir)

load_dotenv(os.path.join(root_dir, ".env"))

from src.course_factory.image_generator import (
    call_openrouter_image_api,
    resize_and_save_image,
    get_image_api_key,
)

cues_to_generate = [
    {
        "filename": "minikurs_kleister_cue0.png",
        "prompt": "Professionelle Nahaufnahme einer geordneten Handwerker-Werkbank: Eimer mit Tapetenkleister, Dose Holzleim, breiter Pinsel und Rührstab, natürliches Werkstattlicht, extrem detailreich, fotorealistisch, keine Schriftzüge.",
    },
    {
        "filename": "minikurs_kleister_cue1.png",
        "prompt": "Erfahrener Maler streicht mit einem Quast zügig und gleichmäßig transparenten Kleister auf eine ausgebreitete Tapetenbahn, Werkstattumgebung, fotorealistisch, keine Texte.",
    },
    {
        "filename": "minikurs_kleister_cue2.png",
        "prompt": "Gegenüberstellung im Makro-Detail: links transparenter Methylcellulose-Tapetenkleister, rechts zähflüssiger weißer Holzleim auf hellem Holz, fotorealistisch, keine Beschriftung.",
    },
]

out_dir = os.path.join(root_dir, "public", "images")
os.makedirs(out_dir, exist_ok=True)

api_key = get_image_api_key()
print(f"Generating images using OpenRouter API (Key present: {bool(api_key)})...")

for item in cues_to_generate:
    target_path = os.path.join(out_dir, item["filename"])
    print(f"Generating {item['filename']}...")
    img_bytes = call_openrouter_image_api(
        prompt=item["prompt"],
        api_key=api_key,
        model="google/gemini-2.5-flash-image",
    )
    resize_and_save_image(img_bytes, target_path, target_size=(512, 256))
    print(f"[OK] Saved {target_path} (512x256)")

# Now generate ElevenLabs Audio
eleven_key = os.getenv("ELEVENLABS_API_KEY", "")
voice_id = os.getenv("ELEVENLABS_VOICE_ID", "l2LQHKd2l5T7VWaA31ma")
spoken_script = (
    "Willkommen zu diesem kompakten Minikurs über Klebetechnik im Handwerk! "
    "Hier siehst du die wichtigsten Kleisterarten direkt auf der Werkbank... "
    "Beim Tapezieren verwenden wir meist Methylcellulose. Achte darauf, wie der Kleister mit dem breiten Quast gleichmäßig auf die Bahnen aufgetragen wird... "
    "Im direkten Vergleich erkennst du den Unterschied: Links der transparente, quellfähige Tapetenkleister für diffusionsoffene Wände, "
    "und rechts der weiße, zähe Holzleim für hochfeste Holzverbindungen. "
    "Damit hast du die Grundlagen der Klebetechnik sofort im Blick!"
)

audio_dir = os.path.join(root_dir, "public", "audio")
os.makedirs(audio_dir, exist_ok=True)
audio_path = os.path.join(audio_dir, "minikurs_kleister.mp3")

if eleven_key and not eleven_key.startswith("mock"):
    print("Synthesizing narration via ElevenLabs...")
    tts_res = httpx.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
        headers={
            "xi-api-key": eleven_key,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
        json={
            "text": spoken_script,
            "model_id": "eleven_multilingual_v2",
            "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
        },
        timeout=45.0,
    )
    if tts_res.status_code == 200:
        with open(audio_path, "wb") as f:
            f.write(tts_res.content)
        print(f"[OK] ElevenLabs Audio saved to {audio_path} ({len(tts_res.content)} bytes)")
    else:
        print(f"[Warning] ElevenLabs returned {tts_res.status_code}: {tts_res.text}")
else:
    print("No ElevenLabs key, creating silent MP3 placeholder")

print("Asset generation complete!")
