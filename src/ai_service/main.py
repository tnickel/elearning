import os
import sys
import re
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import List, Optional
import uvicorn
import config

src_path = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if src_path not in sys.path:
    sys.path.insert(0, src_path)

try:
    from course_factory.prompt_manager import get_prompt
except ImportError:
    get_prompt = None

app = FastAPI(title="Zero-Ops AI E-Learning Service")

@app.get("/health")
@app.get("/")
def health_check():
    return {"status": "ok", "service": "ai_service"}

# Pydantic Schemas for Instructor
class SlideSchema(BaseModel):
    title: str = Field(..., description="Titel der Folie")
    layout: str = Field("bullets", description="Layout-Typ der Folie: 'bullets' (Text-Aufzählung), 'mermaid' (Mermaid-Diagramm), 'code' (Code-Beispiel), 'image' (vollflächiges Bild)")
    bullets: Optional[List[str]] = Field(None, description="Stichpunkte (für 'bullets' und 'code' Layouts)")
    mermaid_code: Optional[str] = Field(None, description="Mermaid-Diagramm-Code (für 'mermaid' Layout; z.B. flowcharts, timelines)")
    code_snippet: Optional[str] = Field(None, description="Code-Ausschnitt (für 'code' Layout)")
    code_language: Optional[str] = Field("javascript", description="Programmiersprache des Code-Ausschnitts (z.B. 'yaml', 'dockerfile', 'python')")
    image_prompt: Optional[str] = Field(None, description="Beschreibung des Bildes für die Generierung (für 'image' und 'bullets' Layouts)")
    image_url: Optional[str] = Field(None, description="Lokaler Pfad zum Bild (z.B. /images/...)")

class LessonSchema(BaseModel):
    title: str = Field(..., description="Titel der Lektion")
    description: str = Field(..., description="Kurzbeschreibung der Lektion")
    estimated_duration_minutes: int = Field(..., description="Geschätzte Dauer in Minuten")
    slides: List[SlideSchema] = Field(..., description="3 bis 4 Präsentationsfolien für diese Lektion")

class ModuleSchema(BaseModel):
    title: str = Field(..., description="Titel des Moduls")
    lessons: List[LessonSchema] = Field(..., description="Liste der Lektionen im Modul")

class CurriculumSchema(BaseModel):
    course_title: str = Field(..., description="Gesamttitel des Kurses")
    course_description: str = Field(..., description="Gesamtbeschreibung des Kurses")
    modules: List[ModuleSchema] = Field(..., description="Liste der Module")

class QuizQuestion(BaseModel):
    question: str = Field(..., description="Die Quizfrage")
    options: List[str] = Field(..., description="4 Antwortmöglichkeiten")
    correct_option_index: int = Field(..., description="Index der korrekten Antwort (0-3)")
    explanation: str = Field(..., description="Erklärung, warum diese Antwort richtig ist")

class LessonContentSchema(BaseModel):
    teleprompter_script: str = Field(..., description="Ausführliches Skript für den Video-Avatar (HeyGen), ca. 300-500 Wörter")
    text_content: str = Field(..., description="Ausführlicher Begleittext und Erläuterungen mit Code-Beispielen im Markdown-Format")
    quiz: List[QuizQuestion] = Field(..., description="3 bis 5 Kontrollfragen zur Überprüfung des Wissens")

# Request Schemas
class CurriculumRequest(BaseModel):
    topic: str
    tenant_id: str
    duration: Optional[str] = "2_weeks"
    custom_prompt: Optional[str] = None

class LessonContentRequest(BaseModel):
    course_topic: str
    module_title: str
    lesson_title: str
    tenant_id: str
    custom_prompt: Optional[str] = None

class EmbeddingRequest(BaseModel):
    text: str
    tenant_id: str

class AnswerRequest(BaseModel):
    prompt: str
    tenant_id: str

class SlideNarrationRequest(BaseModel):
    course_topic: str
    slide_title: str = ""
    slide_bullets: List[str] = []
    slide_index: int = 0
    total_slides: int = 1
    image_base64: Optional[str] = None  # PNG/JPEG without data: prefix
    image_mime: str = "image/png"
    tenant_id: str = ""
    custom_prompt: Optional[str] = None

class SlideNarrationSchema(BaseModel):
    speaker_notes: str = Field(..., description="Gesprochener Text für diese Folie, 80-160 Wörter, natürliche Trainer-Sprache")
    summary: str = Field("", description="Kurze Inhaltszusammenfassung der Folie in einem Satz")

# Must match src/db/schema.ts EMBEDDING_DIMENSIONS / vector(384)
EMBEDDING_DIMENSIONS = 384

# Lazy local model loader
_embedding_model = None

def _ensure_embedding_dim(emb: List[float], source: str) -> List[float]:
    """Reject wrong-sized vectors. Never zero-pad (destroys cosine similarity)."""
    if len(emb) != EMBEDDING_DIMENSIONS:
        raise ValueError(
            f"{source} returned {len(emb)} dims, expected {EMBEDDING_DIMENSIONS}. "
            "Zero-padding is disabled — re-index with a matching model or set EMBEDDING_PROVIDER=local."
        )
    return emb

def get_local_embeddings(text: str) -> List[float]:
    global _embedding_model
    if _embedding_model is None:
        print("Loading SentenceTransformer model 'all-MiniLM-L6-v2' (384-d)...")
        from sentence_transformers import SentenceTransformer
        _embedding_model = SentenceTransformer("all-MiniLM-L6-v2")

    emb = _embedding_model.encode(text).tolist()
    return _ensure_embedding_dim(emb, "all-MiniLM-L6-v2")

def get_zhipu_embeddings(text: str) -> List[float]:
    import openai
    key = config.get_zhipu_api_key()
    if not key or key == "mock-zhipu-key":
        return get_local_embeddings(text)
    try:
        client = openai.OpenAI(
            base_url=config.get_zhipu_base_url(),
            api_key=key
        )
        model = config.get_zhipu_embedding_model() or "embedding-3"
        try:
            response = client.embeddings.create(
                input=[text],
                model=model,
                dimensions=EMBEDDING_DIMENSIONS,
            )
        except Exception:
            response = client.embeddings.create(
                input=[text],
                model=model,
            )
        emb = response.data[0].embedding
        return _ensure_embedding_dim(emb, f"Zhipu/{model}")
    except ValueError:
        raise
    except Exception as e:
        print(f"Error generating Zhipu embeddings: {e}. Falling back to local MiniLM.")
        return get_local_embeddings(text)

def get_remote_embeddings(text: str) -> List[float]:
    import openai

    key = config.get_openrouter_api_key()
    is_mock = not key or key == "mock-openrouter-key"
    if is_mock:
        return get_local_embeddings(text)

    try:
        client = openai.OpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=key
        )
        # Request 384-d matryoshka truncation when the model supports it.
        try:
            response = client.embeddings.create(
                input=[text],
                model="openai/text-embedding-3-small",
                dimensions=EMBEDDING_DIMENSIONS,
            )
        except Exception:
            response = client.embeddings.create(
                input=[text],
                model="openai/text-embedding-3-small",
            )
        return _ensure_embedding_dim(response.data[0].embedding, "OpenRouter/text-embedding-3-small")
    except ValueError:
        raise
    except Exception as e:
        print(f"Error generating remote embeddings: {e}. Falling back to local MiniLM.")
        return get_local_embeddings(text)

def is_provider_mock() -> bool:
    provider = config.get_llm_provider()
    if provider in ["glm", "zhipu", "zai"]:
        key = config.get_glm_api_key()
        return not key or key in ["mock-zhipu-key", "mock-glm-key"]
    elif provider == "vllm":
        return False
    else:
        key = config.get_openrouter_api_key()
        return not key or key == "mock-openrouter-key"

def get_llm_client(is_instructor: bool = False, is_vision: bool = False):
    from openai import OpenAI
    import httpx
    
    provider = config.get_llm_provider()
    if provider in ["glm", "zhipu", "zai"]:
        base_url = config.get_glm_base_url()
        api_key = config.get_glm_api_key()
        model_name = config.get_glm_vision_model() if is_vision else config.get_glm_model()
    elif provider == "vllm":
        base_url = config.get_vllm_base_url()
        api_key = "token"
        model_name = config.get_vllm_model()
    else:
        base_url = "https://openrouter.ai/api/v1"
        api_key = config.get_openrouter_api_key()
        model_name = config.get_openrouter_model()
        
    http_client = httpx.Client(timeout=180.0)
    raw_client = OpenAI(base_url=base_url, api_key=api_key or "mock-key", http_client=http_client)
    if is_instructor:
        import instructor
        if provider in ["glm", "zhipu", "zai"]:
            client = instructor.from_openai(raw_client)
        else:
            client = instructor.from_openai(raw_client, mode=instructor.Mode.MD_JSON)
    else:
        client = raw_client
        
    return client, model_name


from concept_generator import ConceptRequest, FullConceptResponse, generate_staged_concept

@app.post("/generate-concept", response_model=FullConceptResponse)
def generate_concept(req: ConceptRequest):
    """Generates a pure didactic concept framework (Option C) with staged GLM-5.3 calls and PDF output."""
    try:
        return generate_staged_concept(req)
    except Exception as e:
        print(f"[generate_concept] Error: {e}", flush=True)
        raise HTTPException(status_code=500, detail=f"Concept generation failed: {str(e)}")


@app.post("/generate-curriculum", response_model=CurriculumSchema)
def generate_curriculum(req: CurriculumRequest):
    if is_provider_mock():
        if req.duration in ["1_slide", "1slide", "mini", "minikurs"]:
            return CurriculumSchema(
                course_title=f"Minikurs (1 Folie): {req.topic}",
                course_description=f"Ein ultrakompakter Minikurs mit genau einer Folie zum schnellen Testen von {req.topic}.",
                modules=[
                    ModuleSchema(
                        title="Schnelltest Modul",
                        lessons=[
                            LessonSchema(
                                title=f"Kompakt-Folie: {req.topic}", 
                                description="Didaktischer Schnelltest mit einer interaktiven Folie", 
                                estimated_duration_minutes=5,
                                slides=[
                                    SlideSchema(
                                        title=f"Überblick: {req.topic[:25]}",
                                        bullets=["Kernbotschaft und Einstieg", "Praktische Anwendung", "Zusammenfassung"]
                                    )
                                ]
                            )
                        ]
                    )
                ]
            )
        if req.duration == "1_hour":
            return CurriculumSchema(
                course_title=f"Minikurs: {req.topic}",
                course_description=f"Ein kompakter Minikurs zur schnellen Einführung in {req.topic}.",
                modules=[
                    ModuleSchema(
                        title="Schnellstart Grundlagen",
                        lessons=[
                            LessonSchema(
                                title="Einführung und Kernkonzepte", 
                                description="Die wichtigsten Grundlagen und Konzepte im Schnelldurchlauf", 
                                estimated_duration_minutes=15,
                                slides=[
                                    SlideSchema(title="Willkommen", bullets=["Einführung in das Thema", "Warum dieses Thema wichtig ist", "Was dich in diesem Kurs erwartet"]),
                                    SlideSchema(title="Kernkonzepte", bullets=["Die wichtigsten Begriffe", "Wie die Zahnräder ineinandergreifen", "Typische Anwendungsfälle"])
                                ]
                            )
                        ]
                    )
                ]
            )
        if req.duration in ["1_day", "1day"]:
            return CurriculumSchema(
                course_title=f"Tageskurs (8 UE): {req.topic}",
                course_description=f"Intensiver 1-Tages-Workshop mit 8 Unterrichtseinheiten zu {req.topic}.",
                modules=[
                    ModuleSchema(
                        title="Vormittag: Grundlagen & Praxis-Setup (4 UE)",
                        lessons=[
                            LessonSchema(
                                title="Einführung & Orientierung", 
                                description="Ziele des Tages und Kernkonzepte", 
                                estimated_duration_minutes=45,
                                slides=[
                                    SlideSchema(title="Tagesziele", bullets=["Überblick gewinnen", "Erste Hands-on Schritte", "Reale Problemstellungen"]),
                                    SlideSchema(title="Architektur", bullets=["Systemüberblick", "Wichtige Begriffe", "Best Practices"])
                                ]
                            ),
                            LessonSchema(
                                title="Hands-On Praxiseinstieg", 
                                description="Direkte praktische Umsetzung", 
                                estimated_duration_minutes=45,
                                slides=[
                                    SlideSchema(title="Praxis-Labor", bullets=["Umgebung einrichten", "Code ausführen", "Ergebnisse prüfen"]),
                                    SlideSchema(title="Troubleshooting", bullets=["Häufige Fehler", "Quick Fixes", "Checkliste"])
                                ]
                            )
                        ]
                    ),
                    ModuleSchema(
                        title="Nachmittag: Vertiefung & Abschlussprojekt (4 UE)",
                        lessons=[
                            LessonSchema(
                                title="Fortgeschrittene Anwendung", 
                                description="Reale Anwendungsfälle meistern", 
                                estimated_duration_minutes=45,
                                slides=[
                                    SlideSchema(title="Erweiterte Patterns", bullets=["Design Patterns", "Skalierung", "Sicherheit"]),
                                    SlideSchema(title="Optimierung", bullets=["Performance Tuning", "Workflow-Automatisierung", "Tipps für den Alltag"])
                                ]
                            ),
                            LessonSchema(
                                title="Tages-Abschlussprojekt & Review", 
                                description="Eigenständiges Projekt und Zusammenfassung", 
                                estimated_duration_minutes=45,
                                slides=[
                                    SlideSchema(title="Mini-Projekt", bullets=["Aufgabenstellung", "Implementierung", "Peer-Review"]),
                                    SlideSchema(title="Zusammenfassung", bullets=["Key Takeaways", "Nächste Schritte", "Weiterführende Ressourcen"])
                                ]
                            )
                        ]
                    )
                ]
            )
        return CurriculumSchema(
            course_title=f"Einführung in {req.topic}",
            course_description=f"Ein umfassender Lehrplan zur Beherrschung von {req.topic}.",
            modules=[
                ModuleSchema(
                    title="Grundlagen & Konzepte",
                    lessons=[
                        LessonSchema(
                            title="Einführung und Geschichte", 
                            description="Erste Schritte und Überblick", 
                            estimated_duration_minutes=15,
                            slides=[
                                SlideSchema(title="Überblick", bullets=["Woher kommt die Technologie?", "Wer hat sie erfunden?", "Welches Problem wird gelöst?"]),
                                SlideSchema(title="Erste Schritte", bullets=["Installation", "Erstes Ausführen", "Typische Hürden für Anfänger"])
                            ]
                        ),
                        LessonSchema(
                            title="Grundlegende Architektur", 
                            description="Wie die Core-Komponenten funktionieren", 
                            estimated_duration_minutes=25,
                            slides=[
                                SlideSchema(title="Architektur", bullets=["Client-Server Prinzip", "Datenströme und Verzeichnisse", "Die Registry"]),
                                SlideSchema(title="Kernkomponenten", bullets=["Engine", "APIs", "Plugins und Extensions"])
                            ]
                        )
                    ]
                ),
                ModuleSchema(
                    title="Fortgeschrittene Anwendung",
                    lessons=[
                        LessonSchema(
                            title="Praxisnahe Implementierung", 
                            description="Hands-on Übungen", 
                            estimated_duration_minutes=30,
                            slides=[
                                SlideSchema(title="Praxis-Setup", bullets=["Projektstruktur erstellen", "Erste eigene Konfiguration", "Deployment"]),
                                SlideSchema(title="Debugging", bullets=["Logs lesen", "Fehler eingrenzen", "Häufige Fehlermeldungen"])
                            ]
                        ),
                        LessonSchema(
                            title="Optimierung & Performance", 
                            description="Best Practices für Produktion", 
                            estimated_duration_minutes=20,
                            slides=[
                                SlideSchema(title="Performance", bullets=["Caching-Strategien", "Ressourcen-Limits setzen", "Monitoring"]),
                                SlideSchema(title="Best Practices", bullets=["Sicherheit", "Wartbarkeit", "Updates einspielen"])
                            ]
                        )
                    ]
                )
            ]
        )

    try:
        client, model_name = get_llm_client(is_instructor=True)

        duration_mapping = {
            "1_day": "eintägigen (8 UE Testkurs)",
            "1day": "eintägigen (8 UE Testkurs)",
            "1_week": "einwöchigen (40 UE)",
            "1week": "einwöchigen (40 UE)",
            "2_weeks": "zweiwöchigen (80 UE)",
            "2weeks": "zweiwöchigen (80 UE)",
            "4_weeks": "vierwöchigen / 1-monatigen (160 UE)",
            "4weeks": "vierwöchigen / 1-monatigen (160 UE)",
            "6_weeks": "sechswöchigen (240 UE)",
            "6weeks": "sechswöchigen (240 UE)",
            "8_weeks": "achtwöchigen / 2-monatigen (320 UE Bootcamp)",
            "8weeks": "achtwöchigen / 2-monatigen (320 UE Bootcamp)",
            "2_months": "achtwöchigen / 2-monatigen (320 UE Bootcamp)",
            "crash_course": "kompakten Crashkurs-"
        }
        
        system_prompt = "Du bist ein didaktischer Experte für IT-Schulungen. Erstelle einen strukturierten Lehrplan. Achte exakt auf die Vorgaben der Kurslänge."
        
        if req.duration in ["1_slide", "1slide", "mini", "minikurs"]:
            duration_str = "ultrakompakten Minikurs (genau 1 einziges Modul mit genau 1 Lektion und genau 1 einzigen Folie mit 3 Stichpunkten zum schnellen Testen)"
        elif req.duration == "1_hour":
            duration_str = "einstündigen Minikurs (genau 1 einziges Modul mit 1 Lektion)"
        elif req.duration in ["1_day", "1day"]:
            duration_str = "eintägigen Intensivkurs (8 Unterrichtseinheiten / 8 UE, genau 2 Module)"
        else:
            m = re.match(r"^(\d+)_weeks$", req.duration or "")
            if m:
                w = int(m.group(1))
                duration_str = f"{w}-wöchigen ({w * 40} UE)"
            else:
                duration_str = duration_mapping.get(req.duration, "achtwöchigen / 2-monatigen (320 UE Bootcamp)")

        if req.custom_prompt:
            prompt_content = req.custom_prompt
        elif get_prompt is not None:
            system_prompt, prompt_content = get_prompt("curriculum_generation", topic=req.topic, duration_str=duration_str)
        else:
            prompt_content = f"Erstelle einen {duration_str} Lehrplan für das Thema: {req.topic}."

        response = client.chat.completions.create(
            model=model_name,
            response_model=CurriculumSchema,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt_content}
            ]
        )
        return response
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM Generation failed: {str(e)}")

@app.post("/generate-lesson", response_model=LessonContentSchema)
def generate_lesson(req: LessonContentRequest):
    if is_provider_mock():
        return LessonContentSchema(
            teleprompter_script=f"Hallo und herzlich willkommen zur Lektion '{req.lesson_title}' im Modul '{req.module_title}'. Heute besprechen wir die Details von {req.course_topic}.",
            text_content=f"# {req.lesson_title}\n\nDies ist der ausführliche Begleittext für das Thema **{req.course_topic}**.\n\n```python\n# Beispielcode\ndef hello_world():\n    print('Willkommen bei {req.course_topic}')\n```\n\nStellen Sie sicher, dass Sie den Code ausprobieren.",
            quiz=[
                QuizQuestion(
                    question=f"Worum geht es in {req.course_topic}?",
                    options=["Antwort A", "Antwort B", "Antwort C", "Antwort D"],
                    correct_option_index=0,
                    explanation="Antwort A ist richtig, weil es die Grundlagen beschreibt."
                )
            ]
        )

    try:
        client, model_name = get_llm_client(is_instructor=True)

        print(f"[generate_lesson] Calling LLM model {model_name} for lesson: '{req.lesson_title}' in module: '{req.module_title}'...", flush=True)
        system_prompt = "Du bist ein didaktischer IT-Trainer. Generiere detaillierte Inhalte für eine Lektion."
        if req.custom_prompt:
            prompt_content = req.custom_prompt
        elif get_prompt is not None:
            system_prompt, prompt_content = get_prompt(
                "lesson_generation",
                course_topic=req.course_topic,
                module_title=req.module_title,
                lesson_title=req.lesson_title,
            )
        else:
            prompt_content = f"Erstelle Inhalte für den Kurs '{req.course_topic}' -> Modul '{req.module_title}' -> Lektion '{req.lesson_title}'."
        
        response = client.chat.completions.create(
            model=model_name,
            response_model=LessonContentSchema,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt_content}
            ]
        )
        print(f"[generate_lesson] LLM generation successful for: '{req.lesson_title}'", flush=True)
        return response
    except Exception as e:
        print(f"[generate_lesson] Error: {str(e)}", flush=True)
        raise HTTPException(status_code=500, detail=f"LLM Generation failed: {str(e)}")

@app.post("/generate-embeddings")
def generate_embeddings(req: EmbeddingRequest):
    try:
        provider = config.get_embedding_provider()
        if provider == "local":
            vector = get_local_embeddings(req.text)
        elif provider in ["zhipu", "zai"]:
            vector = get_zhipu_embeddings(req.text)
        else:
            vector = get_remote_embeddings(req.text)
        return {"embedding": vector}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Embedding generation failed: {str(e)}")

@app.post("/generate-answer")
def generate_answer(req: AnswerRequest):
    if is_provider_mock():
        return {"answer": f"[RAG Tutor - Mock Antwort für Tenant {req.tenant_id}]\nDies ist eine simulierte Antwort des KI-Tutors basierend auf den bereitgestellten Kursunterlagen."}
        
    try:
        client, model_name = get_llm_client(is_instructor=False)
            
        response = client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": "Du bist ein didaktischer IT-Trainer und beantwortest präzise Fragen."},
                {"role": "user", "content": req.prompt}
            ]
        )
        return {"answer": response.choices[0].message.content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM Answer Generation failed: {str(e)}")


@app.post("/generate-slide-narration", response_model=SlideNarrationSchema)
def generate_slide_narration(req: SlideNarrationRequest):
    """Vision-capable: looks at a slide image and writes spoken trainer script for TTS."""
    position = f"Folie {req.slide_index + 1} von {req.total_slides}"

    if is_provider_mock():
        return SlideNarrationSchema(
            speaker_notes=(
                f"Schauen wir uns jetzt {position} an: {req.slide_title or 'diese Folie'}. "
                f"Im Kurs „{req.course_topic}“ geht es hier um die Kernaussagen auf dem Bild. "
                f"{('Stichpunkte: ' + ', '.join(req.slide_bullets[:3]) + '. ') if req.slide_bullets else ''}"
                f"Merke dir diese Zusammenhänge – im nächsten Schritt bauen wir darauf auf."
            ),
            summary=req.slide_title or f"Inhalt von {position}",
        )

    bullets_txt = "\n".join(f"- {b}" for b in (req.slide_bullets or []) if b)

    if req.custom_prompt:
        system_prompt = (
            "Du bist ein erfahrener IT-Trainer und schreibst Sprecherskripte für E-Learning. "
            "Schreibe natürlichen, gesprochenen Text (Du-Form oder wir-Form), klar und didaktisch. "
            "Keine Meta-Kommentare wie „Auf dieser Folie sieht man…“. "
            "Erkläre kurz, was wichtig ist, und leite sanft weiter. "
            "Länge: etwa 80–160 Wörter. Antworte NUR mit gültigem JSON: "
            '{"speaker_notes":"...","summary":"..."}'
        )
        user_text = req.custom_prompt
    elif get_prompt is not None:
        system_prompt, user_text = get_prompt(
            "slide_narration",
            course_topic=req.course_topic,
            position=position,
            slide_title=req.slide_title or "(ohne Titel)",
            bullets_txt=bullets_txt or "(keine)",
        )
    else:
        system_prompt = (
            "Du bist ein erfahrener IT-Trainer und schreibst Sprecherskripte für E-Learning. "
            "Schreibe natürlichen, gesprochenen Text (Du-Form oder wir-Form), klar und didaktisch. "
            "Keine Meta-Kommentare wie „Auf dieser Folie sieht man…“. "
            "Erkläre kurz, was wichtig ist, und leite sanft weiter. "
            "Länge: etwa 80–160 Wörter. Antworte NUR mit gültigem JSON: "
            '{"speaker_notes":"...","summary":"..."}'
        )
        user_text = (
            f"Kurs: {req.course_topic}\n"
            f"{position}\n"
            f"Folientitel: {req.slide_title or '(ohne Titel)'}\n"
            f"Stichpunkte:\n{bullets_txt or '(keine)'}\n\n"
            "Analysiere die Folie (Text und Grafik) und schreibe das Sprecherskript."
        )

    user_content: list = [{"type": "text", "text": user_text}]
    if req.image_base64:
        user_content.append({
            "type": "image_url",
            "image_url": {
                "url": f"data:{req.image_mime or 'image/png'};base64,{req.image_base64}"
            },
        })

    try:
        client, model_name = get_llm_client(is_instructor=False, is_vision=True)
        print(f"[generate_slide_narration] model={model_name} slide={req.slide_index + 1}/{req.total_slides} title={req.slide_title!r}", flush=True)

        response = client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            response_format={"type": "json_object"},
            temperature=0.6,
        )
        raw = response.choices[0].message.content or "{}"
        import json
        data = json.loads(raw)
        notes = (data.get("speaker_notes") or data.get("script") or "").strip()
        if not notes:
            raise ValueError("Leeres speaker_notes in LLM-Antwort")
        return SlideNarrationSchema(
            speaker_notes=notes,
            summary=(data.get("summary") or req.slide_title or "").strip(),
        )
    except Exception as e:
        print(f"[generate_slide_narration] Error: {e}", flush=True)
        raise HTTPException(status_code=500, detail=f"Slide narration failed: {str(e)}")



if __name__ == "__main__":
    host = os.getenv("AI_SERVICE_HOST", "127.0.0.1")
    port = int(os.getenv("AI_SERVICE_PORT", "8085"))
    uvicorn.run(app, host=host, port=port)
