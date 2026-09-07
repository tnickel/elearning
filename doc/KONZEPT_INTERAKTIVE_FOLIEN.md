# Konzept: Interaktive Folien mit KI-generierten Illustrationen

> **Ziel:** Die reinen Text+Audio-Folien um dynamisch generierte, kontextuelle Bilder anreichern, die synchron zum Sprechertext eingeblendet werden.  
> **Ergebnis:** Statt statischer Bulletpoint-Folien sieht der Lernende passende Illustrationen, Fotos und Diagramme, die den gesprochenen Inhalt visuell unterstützen.

---

## 1. Problem & Motivation

### Ist-Zustand
Aktuell generiert der **Video-Script-Agent** pro Folie:
- `on_slide_text` (Heading + Bulletpoints, max. 5–7 Wörter)
- `elevenlabs_script` (gesprochener Text für TTS)
- `visual_description` (Textbeschreibung, was man sehen *sollte* — aber **kein Bild wird generiert**)
- `layout_type` (Title_Slide, Code_Snippet, Diagram, Icon_Grid, Comparison)

Das `visual_description`-Feld ist ein toter Wert: Es beschreibt, was visuell passieren soll, aber niemand setzt es um. Die Folien bestehen aktuell aus Text auf dunklem Hintergrund.

### Soll-Zustand
- **Jede Folie** bekommt ein oder mehrere KI-generierte Bilder, die zum Sprechertext passen
- Bei langen Sprechertexten werden **mehrere Bilder zeitversetzt** eingeblendet (wie ein visuelles Storyboard)
- Die Bilder unterstützen den gesprochenen Inhalt: Wenn über „Kleister" gesprochen wird, erscheinen verschiedene Kleistertypen, Anwendungsszenen, Werkzeuge etc.

---

## 2. Architekturvarianten

### Variante A: In-Script Image Cues (empfohlen ⭐)
**Idee:** Das bestehende Slide-Schema wird um ein `image_cues`-Array erweitert. Der Video-Script-Agent generiert pro Folie neben dem ausführlichen Sprechertext (120–250 Wörter) 1–3 gezielte Bildanweisungen mit weit auseinanderliegenden Zeitmarkern.
**Wichtig:** *Keine hektische Slideshow!* Jedes Bild muss mindestens 20–35 Sekunden stehen bleiben, damit die Lernenden Bild und gesprochene Erklärung in Ruhe verarbeiten können. Bildwechsel erfolgen nur bei didaktischen Hauptabschnitten.

```json
{
  "slide_number": 3,
  "layout_type": "Illustrated",
  "on_slide_text": { "heading": "Kleisterarten", "bullet_points_or_code": ["Tapetenkleister", "Holzleim"] },
  "elevenlabs_script": "Es gibt verschiedene Kleisterarten, die sich grundlegend unterscheiden...",
  "image_cues": [
    {
      "timestamp_percent": 0,
      "prompt": "Professionelle Nahaufnahme verschiedener Kleistersorten in Eimern, Werkstatt-Setting, natürliches Licht, fotorealistisch",
      "transition": "fade"
    },
    {
      "timestamp_percent": 35,
      "prompt": "Handwerker trägt Tapetenkleister mit breitem Pinsel auf Rückseite einer Tapetenbahn auf, Werkstatt",
      "transition": "slide_left"
    },
    {
      "timestamp_percent": 70,
      "prompt": "Vergleich: Links Tapetenkleister (transparent, dünnflüssig), rechts Holzleim (weiß, dickflüssig), Split-Screen Stil",
      "transition": "fade"
    }
  ]
}
```

**Vorteile:**
- Ein einziger LLM-Call pro Folie (Text + Bildcues zusammen)
- Konsistenz zwischen Sprechertext und Bildwahl garantiert
- `timestamp_percent` erlaubt präzise Synchronisation mit dem Audio
- Rückwärtskompatibel: Folien ohne `image_cues` funktionieren wie bisher

**Nachteile:**
- Prompt wird komplexer (muss Text UND Bildanweisungen erzeugen)

---

### Variante B: Separates Visual-Script (zweites Skript)
**Idee:** Nach der Text+Audio-Generierung wird ein zweiter Agent-Pass durchgeführt, der das fertige Skript analysiert und ein separates `visual_script.json` erzeugt.

```
video_script_agent.py  →  slides.json + elevenlabs_script.txt
                                ↓
visual_script_agent.py →  visual_script.json (Bildprompts + Timing)
```

**Vorteile:**
- Bestehende Pipeline bleibt unverändert
- Spezialisierter Prompt nur für Bildideen → potenziell bessere Bildqualität
- Kann nachträglich auf bestehende Kurse angewandt werden

**Nachteile:**
- Zweiter LLM-Call pro UE (Kosten + Latenz)
- Synchronisationsproblem: Der zweite Agent muss das Audio-Timing schätzen

---

### Variante C: Hybrid (Two-Pass mit Rückintegration)
**Idee:** Pass 1 erzeugt Text + grobe `visual_description` (wie jetzt). Pass 2 nimmt die `visual_description` und macht daraus konkrete Bild-Prompts mit Timing.

**Bewertung:** Unnötig komplex. Variante A ist einfacher und liefert bessere Ergebnisse, weil der LLM den Kontext zwischen Sprechertext und Bildbedarf in einem Schritt herstellt.

---

## 3. Empfohlene Umsetzung: Variante A (In-Script Image Cues)

### 3.1 Schema-Erweiterung (`schemas.py`)

```python
class ImageCue(BaseModel):
    """Ein Bildwechsel-Signal innerhalb einer Folie."""
    timestamp_percent: int = Field(
        ..., ge=0, le=100,
        description="Zeitpunkt im Sprechertext (0% = Start, 100% = Ende)"
    )
    prompt: str = Field(
        ..., min_length=20, max_length=500,
        description="Detaillierter Bild-Prompt für Gemini Imagen (englisch oder deutsch)"
    )
    transition: Literal["fade", "slide_left", "slide_right", "zoom_in", "cut"] = Field(
        default="fade",
        description="Übergangseffekt zum nächsten Bild"
    )

class Slide(BaseModel):
    slide_number: int = Field(...)
    layout_type: Literal["Title_Slide", "Code_Snippet", "Diagram", 
                          "Icon_Grid", "Comparison", "Illustrated"] = ...
    visual_description: str = ...
    on_slide_text: SlideOnSlideText = ...
    elevenlabs_script: str = ...
    image_cues: Optional[List[ImageCue]] = Field(
        default=None,
        description="2-4 Bildwechsel-Signale für KI-generierte Illustrationen"
    )
```

### 3.2 Bildgenerierung: Neuer `image_generator.py` Service

```
Pipeline pro Folie:
1. Slide hat image_cues[] mit Prompts
2. image_generator.py ruft Gemini Imagen API auf (1 Bild pro Cue)
3. Bilder werden als PNG unter course_output/week_X/day_Y/ue_Z/images/ gespeichert
4. Pfade werden in slides.json zurückgeschrieben als image_cue.image_url
```

**API-Anbindung (Gemini Imagen 3):**
```python
import google.genai as genai

client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

response = client.models.generate_images(
    model="imagen-3.0-generate-002",
    prompt=cue.prompt,
    config=genai.types.GenerateImagesConfig(
        number_of_images=1,
        aspect_ratio="16:9",        # Passend für Slide-Layout
        safety_filter_level="BLOCK_MEDIUM_AND_ABOVE",
        person_generation="DONT_ALLOW",  # Für Bildungscontent meist sicherer
    )
)

# Bild speichern
image_bytes = response.generated_images[0].image.image_bytes
with open(output_path, "wb") as f:
    f.write(image_bytes)
```

**Alternative: OpenRouter + DALL-E 3 / Flux:**
Falls kein Gemini-API-Key verfügbar ist, kann über OpenRouter auch DALL-E 3 oder Flux angebunden werden. Die Prompt-Struktur bleibt identisch.

### 3.3 Integration in die Orchestrator-Pipeline

```
Bisheriger Ablauf:
  Makro → Meso → Switchboard → video_script_agent → slides.json + audio

Neuer Ablauf (Erweiterung):
  Makro → Meso → Switchboard → video_script_agent → slides.json (mit image_cues)
                                                         ↓
                                                  image_generator (Gemini Imagen)
                                                         ↓
                                                  slides.json (mit image_urls)
                                                         ↓
                                                  ElevenLabs TTS → Audio
```

Im `orchestrator.py` wird nach dem Video-Script-Agent ein neuer Schritt eingefügt:

```python
# Nach video_script_agent:
if video_script and video_script.slides:
    for slide in video_script.slides:
        if slide.image_cues:
            for cue in slide.image_cues:
                image_path = await generate_image(
                    prompt=cue.prompt,
                    output_dir=os.path.join(ue_dir, "images"),
                    filename=f"slide_{slide.slide_number}_cue_{cue.timestamp_percent}.png"
                )
                cue.image_url = image_path  # Relativer Pfad
```

### 3.4 Frontend-Player: Bildwechsel synchron zum Audio

Der Slide-Player im Frontend bekommt einen neuen Layout-Modus `"Illustrated"`, der Bilder zeitgesteuert einblendet:

```
┌─────────────────────────────────────────────┐
│                                             │
│           [KI-generiertes Bild]             │
│           (wechselt synchron               │
│            zum Sprechertext)                │
│                                             │
├─────────────────────────────────────────────┤
│  Heading: "Kleisterarten"                   │
│  • Tapetenkleister                          │
│  • Holzleim                                 │
├─────────────────────────────────────────────┤
│  ▶ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 2:15/3:30 │
│    Bild 1/3  ▸▸  Bild 2/3  ▸▸  Bild 3/3   │
└─────────────────────────────────────────────┘
```

**Synchronisationslogik:**
```javascript
// Im Audio-Player timeupdate Event:
audioEl.addEventListener('timeupdate', () => {
  const percent = (audioEl.currentTime / audioEl.duration) * 100;
  const cues = currentSlide.image_cues || [];
  
  // Finde das aktuelle Bild basierend auf timestamp_percent
  let activeCue = cues[0];
  for (const cue of cues) {
    if (percent >= cue.timestamp_percent) {
      activeCue = cue;
    }
  }
  
  if (activeCue && activeCue.image_url !== currentDisplayedImage) {
    transitionToImage(activeCue.image_url, activeCue.transition);
    currentDisplayedImage = activeCue.image_url;
  }
});
```

### 3.5 Video-Export: Bilder in MP4 einkodieren

Der `videoExport.ts` wird erweitert, um bei Folien mit `image_cues` statt eines statischen Standbilds mehrere Bilder mit Übergängen zu rendern:

```
Bisherig:  1 Folie = 1 Standbild + 1 Audio → ffmpeg segment
Neu:       1 Folie = N Bilder (zeitlich aufgeteilt) + 1 Audio → ffmpeg mit Crossfade-Filter
```

ffmpeg kann Bildwechsel mit dem `overlay`- und `fade`-Filter realisieren:
```bash
ffmpeg -y \
  -loop 1 -t 5 -i bild1.png \
  -loop 1 -t 5 -i bild2.png \
  -i audio.mp3 \
  -filter_complex "[0:v]fade=t=out:st=4:d=1[v0];[1:v]fade=t=in:st=0:d=1[v1];[v0][v1]concat=n=2:v=1[v]" \
  -map "[v]" -map 2:a -shortest output.mp4
```

---

## 4. Prompt-Strategie für hochwertige Bildprompts

### 4.1 Prompt-Template für den Video-Script-Agent (erweitert)

Der bestehende Video-Script-Prompt bekommt einen zusätzlichen Abschnitt:

```
REGELN FÜR BILD-CUES (image_cues):
1. Jede Folie mit layout_type "Illustrated" MUSS 2-4 image_cues haben.
2. Code- und Diagramm-Folien brauchen KEINE image_cues (dort rendert der Code/Mermaid selbst).
3. Prompts müssen KONKRET und VISUELL sein:
   - SCHLECHT: "Ein Bild über Netzwerke"
   - GUT: "Fotorealistisches Rechenzentrum mit beleuchteten Server-Racks, blaues LED-Licht, 
           Glasfront, perspektivische Aufnahme von unten"
4. Stil konsistent halten: Alle Bilder einer UE im selben visuellen Stil 
   (z.B. "clean illustration, flat design, blue tones").
5. Keine Texte im Bild generieren lassen (KI-Bildgeneratoren erzeugen schlechten Text).
6. timestamp_percent verteilen: 0%, 30-40%, 60-70%, optional 90-100%.
```

### 4.2 Stilkonsistenz über eine UE hinweg

Um einen einheitlichen visuellen Stil zu gewährleisten, wird ein `visual_style`-Feld auf UE-Ebene eingeführt:

```json
{
  "ue_title": "Tapezieren für Anfänger",
  "visual_style": "Fotorealistisch, warme Töne, Werkstatt-Setting, natürliches Seitenlicht",
  "slides": [...]
}
```

Jeder `image_cue.prompt` wird vor der Bildgenerierung mit dem `visual_style` als Suffix ergänzt:
```python
full_prompt = f"{cue.prompt}. Stil: {video_script.visual_style}"
```

---

## 5. Kosten- und Performance-Abschätzung

### 5.1 Bildgenerierung pro Kurs

| Kurstyp | Theorie-UEs | Folien/UE | Bilder/Folie | Gesamt Bilder | Gemini Imagen Kosten* |
|---------|------------|-----------|-------------|---------------|----------------------|
| Tageskurs (8 UE) | 3–4 | 10 | 3 | ~90–120 | ~$2–3 |
| 2-Wochen (80 UE) | ~30 | 10 | 3 | ~900 | ~$18–23 |
| 8-Wochen (320 UE) | ~130 | 10 | 3 | ~3.900 | ~$78–100 |

*Geschätzt auf Basis Gemini Imagen 3 Pricing (~$0.02–0.025/Bild bei 1024×576 / 16:9).

### 5.2 Latenz

- Gemini Imagen: ~3–5 Sekunden pro Bild
- Pro Folie (3 Bilder): ~10–15 Sekunden
- Pro UE (10 Folien): ~2–3 Minuten
- **Parallelisierung möglich**: Bilder sind voneinander unabhängig → `asyncio.gather()` auf bis zu 5 parallele Requests

### 5.3 Speicherbedarf

- ~200–400 KB pro Bild (PNG, 1024×576)
- Pro 8-Wochen-Kurs: ~1–1.5 GB Bilder
- Empfehlung: WebP-Komprimierung auf ~50–80 KB/Bild → ~200–300 MB

---

## 6. Umsetzungsplan (Schritte)

### Phase 1: Schema & Pipeline (Backend)
1. `ImageCue` + `visual_style` zu `schemas.py` hinzufügen
2. `image_generator.py` mit Gemini Imagen API implementieren
3. Video-Script-Prompt um Bild-Cue-Regeln erweitern
4. `orchestrator.py`: Bildgenerierungs-Schritt nach Video-Script einfügen
5. `progress.json` um Bild-Fortschritt erweitern

### Phase 2: Frontend-Player
6. Neuer Layout-Modus `"Illustrated"` im Slide-Player
7. Audio-synchrone Bildwechsel mit CSS-Transitions
8. Slide-Vorschau im Wizard um Bildanzeige erweitern

### Phase 3: Video-Export
9. `videoExport.ts` für Multi-Image-Slides mit ffmpeg-Crossfades erweitern

### Phase 4: Studio-Integration
10. Wizard Step 2 zeigt Bild-Thumbnails + Regenerierungs-Button pro Bild
11. Admin kann einzelne Bilder manuell ersetzen (Upload)

---

## 7. Getroffene Entscheidungen

| Frage | Entscheidung |
|-------|-------------|
| **Architekturvariante** | **Variante A** (In-Script Image Cues) |
| **API für Bildgenerierung** | **OpenRouter Image API** (`POST /api/v1/images`) – der bestehende `OPENROUTER_API_KEY` wird wiederverwendet. Über 30 Modelle verfügbar (Google Imagen, Flux, DALL-E etc.) |
| **Bildstil** | **Fotorealistisch** – alle Bilder im selben realistischen Stil |
| **Code-/Diagram-Folien** | **Ja**, alle Layout-Typen bekommen Bilder – alles schön grafisch, aber stilistisch konsistent |
| **Fallback ohne API-Key** | **Kein Fallback** – Key muss konfiguriert sein, sonst Fehler |
| **Bildauflösung** | **512×256** (16:9, ressourcenschonend) |

> [!TIP]
> **Kein zusätzlicher API-Key nötig.** OpenRouter bietet eine [Unified Image API](https://openrouter.ai/docs/api-reference/images) unter `POST https://openrouter.ai/api/v1/images`. Der bestehende `OPENROUTER_API_KEY` funktioniert direkt. Verfügbare Modelle können über `GET /api/v1/images/models` abgefragt werden. Preise sind pro Bild (modellabhängig).


