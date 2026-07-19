import os
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import List, Optional
import uvicorn
import config

app = FastAPI(title="Zero-Ops AI E-Learning Service")

# Pydantic Schemas for Instructor
class SlideSchema(BaseModel):
    title: str = Field(..., description="Titel der Folie")
    bullets: List[str] = Field(..., description="3 bis 5 stichpunktartige Kernaussagen für diese Folie")

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

# Lazy local model loader
_embedding_model = None

def get_local_embeddings(text: str) -> List[float]:
    global _embedding_model
    if _embedding_model is None:
        print("Loading SentenceTransformer model 'all-MiniLM-L6-v2'...")
        from sentence_transformers import SentenceTransformer
        _embedding_model = SentenceTransformer("all-MiniLM-L6-v2")
    
    emb = _embedding_model.encode(text).tolist()
    
    target_dim = 1536
    if len(emb) < target_dim:
        emb = emb + [0.0] * (target_dim - len(emb))
    else:
        emb = emb[:target_dim]
    return emb

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
        response = client.embeddings.create(
            input=[text],
            model="openai/text-embedding-3-small"
        )
        return response.data[0].embedding
    except Exception as e:
        print(f"Error generating remote embeddings: {e}. Falling back to local.")
        return get_local_embeddings(text)

@app.post("/generate-curriculum", response_model=CurriculumSchema)
def generate_curriculum(req: CurriculumRequest):
    key = config.get_openrouter_api_key()
    is_mock = not key or key == "mock-openrouter-key"
    
    if is_mock:
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

    import instructor
    from openai import OpenAI
    
    try:
        provider = config.get_llm_provider()
        if provider == "vllm":
            client = instructor.from_openai(OpenAI(
                base_url=config.get_vllm_base_url(),
                api_key="token"
            ), mode=instructor.Mode.MD_JSON)
            model_name = config.get_vllm_model()
        else:
            client = instructor.from_openai(OpenAI(
                base_url="https://openrouter.ai/api/v1",
                api_key=key
            ), mode=instructor.Mode.MD_JSON)
            model_name = config.get_openrouter_model()

        duration_mapping = {
            "1_week": "einwöchigen",
            "2_weeks": "zweiwöchigen",
            "4_weeks": "vierwöchigen",
            "crash_course": "kompakten Crashkurs-"
        }
        
        if req.custom_prompt:
            prompt_content = req.custom_prompt
        elif req.duration == "1_hour":
            prompt_content = f"Erstelle einen einstündigen Minikurs für das Thema: {req.topic}. WICHTIG: Der Kurs MUSS aus genau 1 einzigen Modul mit genau 1 einzigen Lektion bestehen!"
        else:
            duration_str = duration_mapping.get(req.duration, "zweiwöchigen")
            prompt_content = f"Erstelle einen {duration_str} Lehrplan für das Thema: {req.topic}."

        response = client.chat.completions.create(
            model=model_name,
            response_model=CurriculumSchema,
            messages=[
                {"role": "system", "content": "Du bist ein didaktischer Experte für IT-Schulungen. Erstelle einen strukturierten Lehrplan. Achte exakt auf die Vorgaben der Kurslänge."},
                {"role": "user", "content": prompt_content}
            ]
        )
        return response
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM Generation failed: {str(e)}")

@app.post("/generate-lesson", response_model=LessonContentSchema)
def generate_lesson(req: LessonContentRequest):
    key = config.get_openrouter_api_key()
    is_mock = not key or key == "mock-openrouter-key"
    
    if is_mock:
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

    import instructor
    from openai import OpenAI
    
    try:
        provider = config.get_llm_provider()
        if provider == "vllm":
            client = instructor.from_openai(OpenAI(
                base_url=config.get_vllm_base_url(),
                api_key="token"
            ), mode=instructor.Mode.MD_JSON)
            model_name = config.get_vllm_model()
        else:
            client = instructor.from_openai(OpenAI(
                base_url="https://openrouter.ai/api/v1",
                api_key=key
            ), mode=instructor.Mode.MD_JSON)
            model_name = config.get_openrouter_model()

        print(f"[generate_lesson] Calling LLM model {model_name} for lesson: '{req.lesson_title}' in module: '{req.module_title}'...", flush=True)
        prompt_content = req.custom_prompt if req.custom_prompt else f"Erstelle Inhalte für den Kurs '{req.course_topic}' -> Modul '{req.module_title}' -> Lektion '{req.lesson_title}'."
        
        response = client.chat.completions.create(
            model=model_name,
            response_model=LessonContentSchema,
            messages=[
                {"role": "system", "content": "Du bist ein didaktischer IT-Trainer. Generiere detaillierte Inhalte für eine Lektion."},
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
        else:
            vector = get_remote_embeddings(req.text)
        return {"embedding": vector}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Embedding generation failed: {str(e)}")

@app.post("/generate-answer")
def generate_answer(req: AnswerRequest):
    key = config.get_openrouter_api_key()
    is_mock = not key or key == "mock-openrouter-key"
    
    if is_mock:
        return {"answer": f"[RAG Tutor - Mock Antwort für Tenant {req.tenant_id}]\nDies ist eine simulierte Antwort des KI-Tutors basierend auf den bereitgestellten Kursunterlagen."}
        
    from openai import OpenAI
    try:
        provider = config.get_llm_provider()
        if provider == "vllm":
            client = OpenAI(base_url=config.get_vllm_base_url(), api_key="token")
            model_name = config.get_vllm_model()
        else:
            client = OpenAI(base_url="https://openrouter.ai/api/v1", api_key=key)
            model_name = config.get_openrouter_model()
            
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

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8085)
