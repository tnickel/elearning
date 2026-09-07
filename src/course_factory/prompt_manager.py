"""Centralized Prompt Template Manager for Course Factory and AI Services.

Stores prompt templates in config/prompts/{prompt_id}.json.
Supports:
- Loading customized prompts from disk
- Automatic fallback to factory defaults if missing
- Variable interpolation with safe missing-variable handling
- Saving customizations and resetting to factory defaults
"""

import os
import json
from pathlib import Path
from typing import Dict, Any, Tuple, List, Optional

# Path to config/prompts
ROOT_DIR = Path(__file__).resolve().parent.parent.parent
PROMPTS_DIR = ROOT_DIR / "config" / "prompts"

# Factory defaults for all system prompts & user prompt templates
DEFAULT_PROMPTS: Dict[str, Dict[str, Any]] = {
    "macro_curriculum": {
        "id": "macro_curriculum",
        "title": "1. Makro-Curriculum (Grobkonzept & Wochenplanung)",
        "category": "Course Factory",
        "target_agent": "macro_generator",
        "description": "Erstellt das hierarchische Wochen- und Tageskonzept für den gewählten Kursumfang (1 Tag bis 8 Wochen) mit exakt 8 UEs pro Tag nach AZAV/AVGS-Standard.",
        "recommended_model": "GLM-5.3 oder Gemini 2.5 Pro",
        "variables": [
            {"name": "course_title", "desc": "Titel des Kurses"},
            {"name": "target_audience", "desc": "Zielgruppe der Teilnehmenden"},
            {"name": "duration_desc", "desc": "Beschreibung der Gesamtdauer und Tage"},
            {"name": "total_weeks", "desc": "Anzahl der Wochen (z.B. 1, 2, 4, 8)"},
            {"name": "target_days", "desc": "Gesamtzahl der Unterrichtstage"}
        ],
        "system_prompt": (
            "Du bist ein erfahrener IT-Dozent und Experte für die Konzeption von "
            "nach AZAV/AVGS-zertifizierten Weiterbildungen.\n"
            "Deine Aufgabe ist es, das didaktische Grobkonzept für einen Kurs mit der Dauer {duration_desc} zu erstellen.\n"
            "Jeder Tag besteht aus EXAKT 8 Unterrichtseinheiten (UE) à 45 Minuten.\n"
            "Didaktische Vorgabe: Sorge für eine abwechslungsreiche Mischung aus Theorie, Praxis und Assessment.\n"
            "Antworte AUSSCHLIESSLICH im geforderten JSON-Format."
        ),
        "user_prompt": (
            "Erstelle das Master Curriculum für folgende Schulung:\n"
            "- Kurstitel: \"{course_title}\"\n"
            "- Zielgruppe: \"{target_audience}\"\n"
            "- Gesamtdauer: {duration_desc}\n"
            "- Einheiten pro Tag: Exakt 8 UE (theory_ue + practice_ue + assessment_ue = 8)\n\n"
            "Achte auf eine logische Steigerung von den Grundlagen bis zu den Praxis- und Abschlussprojekten.\n"
            "Generiere das Curriculum vollständig gemäß Schema."
        )
    },
    "meso_day_plan": {
        "id": "meso_day_plan",
        "title": "2. Meso-Tagesplanung (8 UE Slicing & Agent-Routing)",
        "category": "Course Factory",
        "target_agent": "meso_generator",
        "description": "Unterteilt einen einzelnen Tag in exakt 8 UEs und weist jeder Einheit den passenden Spezial-Agenten zu (video_script_agent, coding_exercise_agent, quiz_agent).",
        "recommended_model": "GLM-5.3 oder Gemini 2.5 Pro",
        "variables": [
            {"name": "course_title", "desc": "Titel des Kurses"},
            {"name": "day_number", "desc": "Fortlaufende Tagesnummer (1-40)"},
            {"name": "day_theme", "desc": "Thema des Tages"},
            {"name": "didactic_approach", "desc": "Didaktischer Ansatz des Tages"},
            {"name": "daily_milestone", "desc": "Tages-Meilenstein"},
            {"name": "theory_ue", "desc": "Anzahl der Theorie-UEs"},
            {"name": "practice_ue", "desc": "Anzahl der Praxis-UEs"},
            {"name": "assessment_ue", "desc": "Anzahl der Assessment-UEs"}
        ],
        "system_prompt": (
            "Du bist ein erfahrener IT-Dozent und Curriculum-Architekt für technische Weiterbildungen.\n"
            "Deine Aufgabe ist es, einen spezifischen Kurstag aus einem übergeordneten Curriculum "
            "in exakt 8 Unterrichtseinheiten (UE) à 45 Minuten zu unterteilen.\n"
            "Jede UE MUSS genau einem 'target_agent' zugewiesen werden:\n"
            "- 'video_script_agent' (für Theorie-Einheiten)\n"
            "- 'coding_exercise_agent' (für Praxis- und Programmier-Einheiten)\n"
            "- 'quiz_agent' (für Wiederholungs-, Quiz- und Assessment-Einheiten)\n"
            "Antworte AUSSCHLIESSLICH im geforderten JSON-Format."
        ),
        "user_prompt": (
            "Unterteile den folgenden Kurstag in EXAKT 8 Unterrichtseinheiten (UE):\n"
            "- Kurs: \"{course_title}\"\n"
            "- Tag: {day_number}\n"
            "- Tagesthema: \"{day_theme}\"\n"
            "- Didaktischer Ansatz: \"{didactic_approach}\"\n"
            "- Heutiger Meilenstein: \"{daily_milestone}\"\n"
            "- Verteilung der Einheiten: {theory_ue} UE Theorie, {practice_ue} UE Praxis, {assessment_ue} UE Assessment.\n\n"
            "RAHMENBEDINGUNGEN:\n"
            "1. Erstelle EXAKT 8 Einheiten (ue_number 1 bis 8).\n"
            "2. Die Summe der ue_types ('theory', 'practice', 'assessment') MUSS der vorgegebenen Verteilung entsprechen.\n"
            "3. 'target_agent' MUSS für 'theory' -> 'video_script_agent', für 'practice' -> 'coding_exercise_agent', für 'assessment' -> 'quiz_agent' sein.\n"
            "4. Baue einen didaktisch sinnvollen Spannungsbogen: Starte mit Konzepten, gehe in praktische Übungen und schließe mit Wissensüberprüfung ab."
        )
    },
    "video_script": {
        "id": "video_script",
        "title": "3. Video-Script Agent (Theorie-Folien & ElevenLabs-Audio)",
        "category": "Course Factory",
        "target_agent": "video_script_agent",
        "description": "Erstellt Folienanweisungen (Titel, Aufzählungen, Layout, Visuals) und den professionell formulierten Sprechertext für die ElevenLabs-Sprachsynthese.",
        "recommended_model": "GLM-5.3 oder Gemini 2.5 Pro",
        "variables": [
            {"name": "course_title", "desc": "Titel des Kurses"},
            {"name": "ue_title", "desc": "Titel der Theorie-Einheit"},
            {"name": "learning_objective", "desc": "Lernziel der Einheit"},
            {"name": "content_outline_formatted", "desc": "Stichpunkte des Inhalts"}
        ],
        "system_prompt": (
            "Du bist ein erstklassiger Instructional Designer, professioneller Scriptwriter für E-Learning-Videos "
            "und Experte für didaktisches Präsentationsdesign.\n"
            "Deine Aufgabe ist es, für eine Unterrichtseinheit ein didaktisches Lehrvideo zu konzipieren.\n"
            "Dieses besteht aus Folienanweisungen (Slides), ausführlichem gesprochenem Sprechertext (optimiert für Sprachsynthese) und Bild-Cues für dynamische Illustrationen.\n\n"
            "REGELN FÜR DEN SPRECHERTEXT (KEINE SCHNELLE SLIDESHOW):\n"
            "1. AUSFÜHRLICHE ERKLÄRUNG: Schreibe pro Folie einen substantiellen, tiefgehenden Sprechertext von mindestens 120 bis 250 Wörtern (entspricht ca. 45 bis 90 Sekunden ruhiger Redezeit pro Folie). Bei 1-Folie-Minikursen mindestens 120–160 Wörter (ca. 45–60 Sekunden).\n"
            "2. Erkläre Hintergründe, Praxistipps, Funktionsweisen und typische Fehler detailliert – kein oberflächliches Abfrühstücken oder hastiges Vorlesen der Stichpunkte!\n"
            "3. Schreibe für das Ohr: Klare Sprache, direkte Ansprache ('Du' / 'Ihr'), lebendig formuliert, didaktisch strukturiert mit natürlichen Sprechpausen ('...').\n\n"
            "REGELN FÜR DIE FOLIEN & BILD-CUES (image_cues):\n"
            "1. Maximal 5-7 prägnante Stichpunkte pro Folie.\n"
            "2. layout_type MUSS einer von: 'Title_Slide', 'Code_Snippet', 'Diagram', 'Icon_Grid', 'Comparison', 'Illustrated' sein.\n"
            "3. visual_style: Definiere einen einheitlichen fotorealistischen Stil für alle Folien dieser Einheit (z.B. 'Fotorealistisch, Werkstatt-Setting, weiches Tageslicht, Tiefenschärfe').\n"
            "4. KEINE SCHNELLE BILD-SLIDESHOW! Ein Bild MUSS mindestens 20 bis 35 Sekunden auf dem Bildschirm stehen bleiben, damit die Lernenden Bild und Inhalt in Ruhe verarbeiten können.\n"
            "5. Jede Folie darf maximal 1–3 gezielte Bild-Cues haben:\n"
            "   - Ein Wechsel erfolgt NUR bei echten didaktischen Sinnabschnitten.\n"
            "   - Bei 2 Cues: Cue 0 bei 0%, Cue 1 bei ca. 45–55%.\n"
            "   - Bei 3 Cues (nur wenn Folie >60 Sekunden lang ist): Cue 0 bei 0%, Cue 1 bei ca. 40–50%, Cue 2 bei ca. 75–85%.\n"
            "   - 'prompt': Fotorealistische, detailreiche Szenenbeschreibung (Handlungen, Werkzeuge, Werkstoffe, Tiefenschärfe). NIEMALS Text oder Schriftzüge im Bild generieren lassen!\n"
            "   - 'transition': Einer von 'fade', 'slide_left', 'slide_right', 'zoom_in', 'cut'.\n"
            "Antworte AUSSCHLIESSLICH im geforderten JSON-Format."
        ),
        "user_prompt": (
            "Erstelle das didaktische Videokonzept mit Folien, ausführlichem Sprechertext (120–250 Wörter pro Folie, ruhig und tiefgehend erklärt) und wohlüberlegten Bild-Cues (mindestens 20–35 Sekunden Verweildauer pro Bild, keine schnelle Slideshow) für folgende Einheit:\n"
            "- Kurs: \"{course_title}\"\n"
            "- UE Titel: \"{ue_title}\"\n"
            "- Lernziel: \"{learning_objective}\"\n"
            "- Inhaltliche Schwerpunkte:\n"
            "{content_outline_formatted}\n\n"
            "Strukturiere die Folien didaktisch mit vollständigem, ausführlichem Sprechertext und passenden image_cues."
        )
    },
    "coding_exercise": {
        "id": "coding_exercise",
        "title": "4. Coding-Exercise Agent (Praxis-Aufgabe, Boilerplate & Tests)",
        "category": "Course Factory",
        "target_agent": "coding_exercise_agent",
        "description": "Erstellt vollständige Programmierübungen mit Aufgabenstellung (Markdown), Starter-Code mit '# TODO' Lücken, Musterlösung und Validierungskriterien.",
        "recommended_model": "GLM-5.3 oder Gemini 2.5 Pro",
        "variables": [
            {"name": "course_title", "desc": "Titel des Kurses"},
            {"name": "ue_title", "desc": "Titel der Praxis-Einheit"},
            {"name": "learning_objective", "desc": "Lernziel der Aufgabe"},
            {"name": "content_outline_formatted", "desc": "Stichpunkte des Inhalts"}
        ],
        "system_prompt": (
            "Du bist ein Senior Software Engineer und technischer Ausbilder.\n"
            "Deine Aufgabe ist es, für eine 45-minütige Praxis-Unterrichtseinheit eine anspruchsvolle, "
            "praxisnahe Programmieraufgabe zu entwerfen (ca. 30-40 Minuten Bearbeitungszeit).\n\n"
            "REGELN FÜR DIE AUFGABENERSTELLUNG:\n"
            "1. Praxisnähe: Kein triviales 'Hello World'! Realistische Anforderungen wie Error-Handling, Validierung, Tests.\n"
            "2. Struktur: Teilnehmer erhalten ein Boilerplate-Gerüst mit '# TODO' Lücken.\n"
            "3. Solution: Eine vollständige, lauffähige Musterlösung mit Best Practices.\n"
            "4. Instructions: Vollständige Aufgabenstellung im Markdown-Format (Ziel, Anforderungen, Tipps, keine Spoiler).\n"
            "5. Validation: Liste klarer Prüfkriterien (validation_criteria).\n"
            "Antworte AUSSCHLIESSLICH im geforderten JSON-Format."
        ),
        "user_prompt": (
            "Erstelle die Programmieraufgabe für folgende Einheit:\n"
            "- Kurs: \"{course_title}\"\n"
            "- UE Titel: \"{ue_title}\"\n"
            "- Lernziel: \"{learning_objective}\"\n"
            "- Inhaltliche Schwerpunkte:\n"
            "{content_outline_formatted}\n\n"
            "Erstelle mindestens eine Datei (z.B. main.py) mit vollständigem Boilerplate und Musterlösung."
        )
    },
    "quiz": {
        "id": "quiz",
        "title": "5. Quiz-Agent (10 Multiple-Choice Fragen mit Didaktik-Erklärung)",
        "category": "Course Factory",
        "target_agent": "quiz_agent",
        "description": "Erstellt 10 technische Multiple-Choice-Fragen (A, B, C, D) mit plausiblen Distraktoren und didaktischer Begründung für die richtige Option.",
        "recommended_model": "GLM-5.3-flash oder Gemini 2.5 Pro",
        "variables": [
            {"name": "course_title", "desc": "Titel des Kurses"},
            {"name": "ue_title", "desc": "Titel der Assessment-Einheit"},
            {"name": "learning_objective", "desc": "Lernziel der Wissensüberprüfung"},
            {"name": "content_outline_formatted", "desc": "Stichpunkte des Inhalts"}
        ],
        "system_prompt": (
            "Du bist ein didaktischer Prüfungsexperte für technische IT-Zertifizierungen.\n"
            "Deine Aufgabe ist es, für eine Assessment-Unterrichtseinheit ein anspruchsvolles Multiple-Choice Quiz "
            "zu erstellen, das das Verständnis der Lernenden tiefgreifend prüft.\n\n"
            "REGELN FÜR DIE FRAGENERSTELLUNG:\n"
            "1. Niveau: Frage technisches Verständnis, Architektur-Entscheidungen und Best Practices ab, keine trivialen Vokabeln.\n"
            "2. Eindeutigkeit: Exakt 4 Optionen (A, B, C, D) und exakt EINE davon ist korrekt.\n"
            "3. Distraktoren: Falsche Antworten müssen plausibel klingen und typische Fallstricke widerspiegeln.\n"
            "4. Umfang: Erstelle exakt 10 Fragen für diese Einheit (question_id 1 bis 10).\n"
            "5. Begründung: explanation liefert eine didaktische Begründung, warum die Antwort stimmt und warum die Falle falsch ist.\n"
            "Antworte AUSSCHLIESSLICH im geforderten JSON-Format."
        ),
        "user_prompt": (
            "Erstelle das 10-Fragen-Quiz für folgende Einheit:\n"
            "- Kurs: \"{course_title}\"\n"
            "- UE Titel: \"{ue_title}\"\n"
            "- Lernziel: \"{learning_objective}\"\n"
            "- Inhaltliche Schwerpunkte:\n"
            "{content_outline_formatted}\n\n"
            "Erstelle exakt 10 Fragen mit didaktischer Erklärung."
        )
    },
    "curriculum_generation": {
        "id": "curriculum_generation",
        "title": "6. Studio: Modul- & Lektions-Curriculum",
        "category": "Studio / AI Service",
        "target_agent": "ai_service_curriculum",
        "description": "Erstellt im E-Learning Studio die modulare Kursstruktur für 1 Stunde, 1 Woche oder 2-4 Wochen.",
        "recommended_model": "GLM-5.3 oder Gemini 2.5 Pro",
        "variables": [
            {"name": "topic", "desc": "Thema des Kurses"},
            {"name": "duration_str", "desc": "Dauer als lesbarer Text"}
        ],
        "system_prompt": (
            "Du bist ein führender Curriculum-Architekt und Didaktik-Experte für technische IT-Schulungen.\n"
            "Deine Aufgabe ist es, einen vollständig durchdachten, modularen Lehrplan zu entwerfen.\n\n"
            "STRUKTUR-VORGABEN:\n"
            "1. Baue logisch aufeinander aufbauende Module (z.B. 2-5 Module je nach Kursdauer).\n"
            "2. Jedes Modul enthält fokussierte Lektionen (2-4 Lektionen pro Modul, geschätzte Dauer 30-45 Min je Lektion).\n"
            "3. Jede Lektion benötigt 3 bis 4 Präsentationsfolien mit passendem Layout ('bullets', 'code', 'mermaid', 'image').\n"
            "4. Achte auf praxisnahe Themen, die von Grundlagen über Architektur bis hin zur konkreten Implementierung und Best Practices führen.\n"
            "Antworte strikt gemäß Curriculum-Schema."
        ),
        "user_prompt": (
            "Erstelle einen {duration_str} Lehrplan für das Thema: \"{topic}\".\n"
            "Definiere einen packenden Gesamttitel, eine präzise Gesamtbeschreibung sowie Module und Lektionen mit didaktisch strukturierten Folien."
        )
    },
    "lesson_generation": {
        "id": "lesson_generation",
        "title": "7. Studio: Lektionsinhalte, Teleprompter & Begleitcode",
        "category": "Studio / AI Service",
        "target_agent": "ai_service_lesson",
        "description": "Erstellt den vollständigen Lektions-Content mit Teleprompter-Text, Markdown-Begleitmaterial und Quiz.",
        "recommended_model": "GLM-5.3 oder Gemini 2.5 Pro",
        "variables": [
            {"name": "course_topic", "desc": "Übergeordnetes Kursthema"},
            {"name": "module_title", "desc": "Titel des Moduls"},
            {"name": "lesson_title", "desc": "Titel der Lektion"}
        ],
        "system_prompt": (
            "Du bist ein didaktischer IT-Trainer und Content-Spezialist für moderne E-Learning-Plattformen.\n"
            "Deine Aufgabe ist es, fundierten und vollständigen Lernstoff für eine Lektion zu erstellen.\n\n"
            "ANFORDERUNGEN AN DIE FELDER:\n"
            "1. teleprompter_script: 300 bis 500 Wörter gesprochener Text für den Video-Avatar. Sprich Lernende direkt an ('Du'). Baue einleitende Motivation, Hauptkonzept mit Beispielen und Zusammenfassung auf.\n"
            "2. text_content: Ausführlicher Markdown-Text als Lernbegleiter mit vollständigen, lauffähigen Code-Snippets, Erklärungen und Best Practices.\n"
            "3. quiz: 3 bis 5 anspruchsvolle Multiple-Choice-Fragen mit jeweils 4 Optionen (A, B, C, D), exaktem correct_option_index (0-3) und fundierter didaktischer Erklärung.\n"
            "Antworte strikt als valides JSON gemäß LessonContentSchema."
        ),
        "user_prompt": (
            "Erstelle die vollständigen Lektionsinhalte für:\n"
            "- Kurs: \"{course_topic}\"\n"
            "- Modul: \"{module_title}\"\n"
            "- Lektion: \"{lesson_title}\"\n\n"
            "Liefere Teleprompter-Skript, ausführliches Markdown-Begleitmaterial mit Codebeispielen und 3-5 Kontrollfragen."
        )
    },
    "slide_narration": {
        "id": "slide_narration",
        "title": "8. Studio: Vision Folien-Analyse & Sprecherskript",
        "category": "Studio / AI Service",
        "target_agent": "ai_service_vision",
        "description": "Analysiert Folienbilder und Text und formuliert ein natürliches Sprecherskript (Du-Form) für Trainer.",
        "recommended_model": "GLM-5.3-flash (Vision) oder Gemini 2.5 Pro",
        "variables": [
            {"name": "course_topic", "desc": "Kursthema"},
            {"name": "position", "desc": "Folienposition (z.B. Folie 2 von 10)"},
            {"name": "slide_title", "desc": "Titel der Folie"},
            {"name": "bullets_txt", "desc": "Aufzählungspunkte"}
        ],
        "system_prompt": (
            "Du bist ein erfahrener IT-Trainer und schreibst Sprecherskripte für E-Learning. "
            "Schreibe natürlichen, gesprochenen Text (Du-Form oder wir-Form), klar und didaktisch. "
            "Keine Meta-Kommentare wie „Auf dieser Folie sieht man…“. "
            "Erkläre kurz, was wichtig ist, und leite sanft weiter. "
            "Länge: etwa 80–160 Wörter. Antworte NUR mit gültigem JSON: "
            '{{"speaker_notes":"...","summary":"..."}}'
        ),
        "user_prompt": (
            "Kurs: {course_topic}\n"
            "{position}\n"
            "Folientitel: {slide_title}\n"
            "Stichpunkte:\n{bullets_txt}\n\n"
            "Analysiere die Folie (Text und Grafik) und schreibe das Sprecherskript."
        )
    }
}


def ensure_prompts_directory():
    """Ensures config/prompts directory exists and populates default files if missing."""
    PROMPTS_DIR.mkdir(parents=True, exist_ok=True)
    for prompt_id, default_data in DEFAULT_PROMPTS.items():
        file_path = PROMPTS_DIR / f"{prompt_id}.json"
        if not file_path.exists():
            full_data = dict(default_data)
            full_data["default_system_prompt"] = default_data["system_prompt"]
            full_data["default_user_prompt"] = default_data["user_prompt"]
            full_data["is_customized"] = False
            file_path.write_text(json.dumps(full_data, indent=2, ensure_ascii=False), encoding="utf-8")


def load_prompt_definition(prompt_id: str) -> Dict[str, Any]:
    """Loads a prompt definition from disk, or falls back to factory defaults."""
    ensure_prompts_directory()
    file_path = PROMPTS_DIR / f"{prompt_id}.json"
    if file_path.exists():
        try:
            data = json.loads(file_path.read_text(encoding="utf-8"))
            # Ensure defaults are populated for reset capability
            if "default_system_prompt" not in data and prompt_id in DEFAULT_PROMPTS:
                data["default_system_prompt"] = DEFAULT_PROMPTS[prompt_id]["system_prompt"]
            if "default_user_prompt" not in data and prompt_id in DEFAULT_PROMPTS:
                data["default_user_prompt"] = DEFAULT_PROMPTS[prompt_id]["user_prompt"]
            return data
        except Exception as e:
            print(f"[PromptManager] Error reading {file_path}: {e}. Using factory default.")

    if prompt_id in DEFAULT_PROMPTS:
        data = dict(DEFAULT_PROMPTS[prompt_id])
        data["default_system_prompt"] = data["system_prompt"]
        data["default_user_prompt"] = data["user_prompt"]
        data["is_customized"] = False
        return data

    raise KeyError(f"Unknown prompt id: {prompt_id}")


def list_all_prompts() -> List[Dict[str, Any]]:
    """Returns a list of all prompt definitions."""
    ensure_prompts_directory()
    results = []
    for prompt_id in DEFAULT_PROMPTS.keys():
        try:
            p_data = load_prompt_definition(prompt_id)
            # Check if customized
            def_sys = p_data.get("default_system_prompt", "")
            def_usr = p_data.get("default_user_prompt", "")
            cur_sys = p_data.get("system_prompt", "")
            cur_usr = p_data.get("user_prompt", "")
            p_data["is_customized"] = (cur_sys != def_sys) or (cur_usr != def_usr)
            results.append(p_data)
        except Exception:
            pass
    return results


def save_prompt(prompt_id: str, system_prompt: str, user_prompt: str) -> Dict[str, Any]:
    """Updates and saves a prompt definition to disk."""
    data = load_prompt_definition(prompt_id)
    data["system_prompt"] = system_prompt
    data["user_prompt"] = user_prompt
    def_sys = data.get("default_system_prompt", "")
    def_usr = data.get("default_user_prompt", "")
    data["is_customized"] = (system_prompt != def_sys) or (user_prompt != def_usr)
    
    file_path = PROMPTS_DIR / f"{prompt_id}.json"
    file_path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return data


def reset_prompt_to_default(prompt_id: str) -> Dict[str, Any]:
    """Resets a prompt back to factory default values."""
    if prompt_id not in DEFAULT_PROMPTS:
        raise KeyError(f"Unknown prompt id: {prompt_id}")
    
    def_data = dict(DEFAULT_PROMPTS[prompt_id])
    def_data["default_system_prompt"] = def_data["system_prompt"]
    def_data["default_user_prompt"] = def_data["user_prompt"]
    def_data["is_customized"] = False
    
    file_path = PROMPTS_DIR / f"{prompt_id}.json"
    file_path.write_text(json.dumps(def_data, indent=2, ensure_ascii=False), encoding="utf-8")
    return def_data


def get_prompt(prompt_id: str, **kwargs) -> Tuple[str, str]:
    """Retrieves and interpolates the system prompt and user prompt for a specific task.
    
    Uses safe string formatting so unknown or missing variables don't crash.
    """
    definition = load_prompt_definition(prompt_id)
    sys_template = definition.get("system_prompt", "")
    usr_template = definition.get("user_prompt", "")

    # Safe format with dict lookup
    class SafeDict(dict):
        def __missing__(self, key):
            return "{" + key + "}"

    safe_kwargs = SafeDict(kwargs)
    try:
        system_prompt = sys_template.format_map(safe_kwargs)
    except Exception:
        system_prompt = sys_template

    try:
        user_prompt = usr_template.format_map(safe_kwargs)
    except Exception:
        user_prompt = usr_template

    return system_prompt, user_prompt
