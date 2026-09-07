"""Video Script Agent for Course Factory (Micro Generation).

Generates:
- slides.json: Visual slide definitions (Layout, Visual Description, On-Slide Text).
- elevenlabs_script.txt: Spoken script optimized for natural TTS narration.
"""

import json
import os
from typing import List, Optional
from ..schemas import (
    VideoScriptSchema,
    Slide,
    SlideOnSlideText,
    ImageCue,
)
from ..llm_client import call_structured_llm


def create_mock_video_script(ue_title: str, learning_objective: str, content_outline: List[str]) -> VideoScriptSchema:
    """Generates a high-quality mock VideoScriptSchema for testing or offline mode."""
    outline = content_outline or ["Grundlagen", "Praxisbezug", "Zusammenfassung"]
    slides = [
        Slide(
            slide_number=1,
            layout_type="Title_Slide",
            visual_description="Minimalistischer Titelscreen mit neonblauem Titel und dezentem Netzwerk-Hintergrund",
            on_slide_text=SlideOnSlideText(
                heading=ue_title[:30],
                bullet_points_or_code=["Konzept & Überblick", "Praxisbezug"],
            ),
            elevenlabs_script=(
                f"Willkommen zu dieser Lerneinheit! Heute widmen wir uns einem spannenden Thema: {ue_title}. "
                f"Unser Ziel für die nächsten Minuten: {learning_objective} ... "
                f"Legen wir direkt los und schauen uns die Grundlagen an!"
            ),
            image_cues=[
                ImageCue(
                    timestamp_percent=0,
                    prompt="Fotorealistische Makro-Aufnahme eines organisierten Arbeitsplatzes mit Notizen und Laptop, weiches Licht",
                    transition="fade",
                ),
                ImageCue(
                    timestamp_percent=50,
                    prompt="Fokussierte Arbeitsgruppe bei der Projektplanung vor einem großen Bildschirm, fotorealistisch",
                    transition="slide_left",
                ),
            ],
        ),
        Slide(
            slide_number=2,
            layout_type="Diagram",
            visual_description="Mermaid.js Architekturdiagramm: Datenfluss von Client über Gateway zu Microservices",
            on_slide_text=SlideOnSlideText(
                heading="Architektur & Kernprinzip",
                bullet_points_or_code=["Client -> Gateway", "Auth & Validation", "Worker Queue"],
            ),
            elevenlabs_script=(
                "Schauen wir uns hier das Architekturdiagramm an... Wie du siehst, läuft jede Anfrage "
                "zunächst über das zentrale Gateway. Warum ist das so wichtig? "
                "Weil wir hier Validierung und Authentifizierung kapseln, bevor der Worker aktiv wird."
            ),
            image_cues=[
                ImageCue(
                    timestamp_percent=0,
                    prompt="Fotorealistischer Serverraum mit leuchtenden LED-Racks und sauber verlegten Kabelsträngen",
                    transition="fade",
                ),
            ],
        ),
        Slide(
            slide_number=3,
            layout_type="Code_Snippet",
            visual_description="Python-Codeblock mit Syntax-Highlighting für API-Call und Fehlerbehandlung",
            on_slide_text=SlideOnSlideText(
                heading="Code-Implementierung",
                bullet_points_or_code=[
                    "client = LLMClient()",
                    "response = client.call(prompt)",
                    "assert response.ok",
                ],
            ),
            elevenlabs_script=(
                "Kommen wir zum konkreten Code... Achte besonders auf den Client-Aufruf: "
                "In der Produktionsumgebung ist Fehlerbehandlung überlebenswichtig!"
            ),
            image_cues=[
                ImageCue(
                    timestamp_percent=0,
                    prompt="Nahaufnahme von Händen an einer mechanischen Tastatur vor einem Monitor mit Code, fotorealistisch",
                    transition="fade",
                ),
            ],
        ),
        Slide(
            slide_number=4,
            layout_type="Icon_Grid",
            visual_description="Drei Icons: Input, Processing, Output",
            on_slide_text=SlideOnSlideText(
                heading="Drei Bausteine",
                bullet_points_or_code=outline[:3] if len(outline) >= 3 else outline + ["Vertiefung"] * (3 - len(outline)),
            ),
            elevenlabs_script=(
                f"Die inhaltlichen Schwerpunkte heute: {', '.join(outline[:3])}. "
                "Merke dir die Reihenfolge — sie spiegelt den Lernpfad wider."
            ),
            image_cues=[
                ImageCue(
                    timestamp_percent=0,
                    prompt="Drei moderne modulare Bausteine auf einem Schreibtisch, Studio-Beleuchtung, fotorealistisch",
                    transition="fade",
                ),
            ],
        ),
        Slide(
            slide_number=5,
            layout_type="Comparison",
            visual_description="Zweispalten-Gegenüberstellung: Do's (grün) vs. Don'ts (rot)",
            on_slide_text=SlideOnSlideText(
                heading="Best Practices vs. Anti-Patterns",
                bullet_points_or_code=["Do: Typisierte Schemas", "Don't: Ungeprüfter String-Cast"],
            ),
            elevenlabs_script=(
                "Zum Vergleich: Links Best Practices mit typisierten Schemas. "
                "Rechts vermeide unvalidierte Casts..."
            ),
            image_cues=[
                ImageCue(
                    timestamp_percent=0,
                    prompt="Gegenüberstellung: Links ordentliches modernes Werkzeug, rechts chaotische Baustelle, fotorealistisch",
                    transition="fade",
                ),
            ],
        ),
        Slide(
            slide_number=6,
            layout_type="Diagram",
            visual_description="Sequenzdiagramm Request-Response mit Retry",
            on_slide_text=SlideOnSlideText(
                heading="Fehler & Retries",
                bullet_points_or_code=["Timeout", "Backoff", "Circuit Breaker"],
            ),
            elevenlabs_script=(
                "Fehler gehören dazu. Mit Retry und Backoff bleibt das System resilient."
            ),
            image_cues=[
                ImageCue(
                    timestamp_percent=0,
                    prompt="Techniker überprüft Netzwerk-Switch mit Diagnosegerät im Rechenzentrum, fotorealistisch",
                    transition="fade",
                ),
            ],
        ),
        Slide(
            slide_number=7,
            layout_type="Code_Snippet",
            visual_description="Kurzer Validierungs-Snippet",
            on_slide_text=SlideOnSlideText(
                heading="Validierung",
                bullet_points_or_code=["schema.validate(data)", "raise on error"],
            ),
            elevenlabs_script=(
                "Validierung vor dem Speichern verhindert kaputte Downstream-Prozesse."
            ),
            image_cues=[
                ImageCue(
                    timestamp_percent=0,
                    prompt="Präzisionswaage oder Prüfwerkzeug im Qualitätssicherungs-Labor, fotorealistisch",
                    transition="fade",
                ),
            ],
        ),
        Slide(
            slide_number=8,
            layout_type="Title_Slide",
            visual_description="Abschlussfolie mit Call-to-Action zur Praxisübung",
            on_slide_text=SlideOnSlideText(
                heading="Nächster Schritt",
                bullet_points_or_code=["Praxisübung", "Quiz am Tagesende"],
            ),
            elevenlabs_script=(
                "Damit hast du das Rüstzeug für die anstehende Praxisübung. "
                "Setze das Gelernte jetzt selbst um — viel Erfolg!"
            ),
            image_cues=[
                ImageCue(
                    timestamp_percent=0,
                    prompt="Einladender moderner Arbeitsplatz mit vorbereitetem Übungsprojekt auf dem Bildschirm, warmes Sonnenlicht",
                    transition="fade",
                ),
            ],
        ),
    ]

    return VideoScriptSchema(
        ue_title=ue_title,
        estimated_video_duration_minutes=12,
        visual_style="Fotorealistisch, hochwertige Ausleuchtung, realistische Szenen, kein Text im Bild",
        slides=slides,
    )


def save_video_artifacts(video_script: VideoScriptSchema, output_dir: str):
    """Saves slides.json and elevenlabs_script.txt into the specified output directory."""
    os.makedirs(output_dir, exist_ok=True)

    # 1. slides.json
    slides_path = os.path.join(output_dir, "slides.json")
    with open(slides_path, "w", encoding="utf-8") as f:
        json.dump(video_script.model_dump(), f, indent=2, ensure_ascii=False)

    # 2. elevenlabs_script.txt (pure natural spoken text, formatted for audio reader)
    script_path = os.path.join(output_dir, "elevenlabs_script.txt")
    script_sections = []
    for s in video_script.slides:
        script_sections.append(
            f"--- [Folie {s.slide_number}: {s.on_slide_text.heading}] ---\n\n{s.elevenlabs_script}\n"
        )

    with open(script_path, "w", encoding="utf-8") as f:
        f.write("\n".join(script_sections))

    print(f"[Video Script Agent] Artifacts saved to: {output_dir}")


def generate_video_script(
    course_title: str,
    ue_title: str,
    learning_objective: str,
    content_outline: List[str],
    output_dir: Optional[str] = None,
    force_mock: bool = False,
) -> VideoScriptSchema:
    """Generates slides and spoken script for a theory unit using the self-healing LLM client."""
    from ..prompt_manager import get_prompt

    outline_str = "\n".join(f"- {pt}" for pt in content_outline)
    system_prompt, user_prompt = get_prompt(
        "video_script",
        course_title=course_title,
        ue_title=ue_title,
        learning_objective=learning_objective,
        content_outline_formatted=outline_str,
    )

    mock_fallback = create_mock_video_script(ue_title, learning_objective, content_outline)

    video_script = call_structured_llm(
        prompt=user_prompt,
        system_prompt=system_prompt,
        response_schema=VideoScriptSchema,
        mock_fallback=mock_fallback,
        force_mock=force_mock,
    )

    if output_dir:
        save_video_artifacts(video_script, output_dir)

    return video_script
