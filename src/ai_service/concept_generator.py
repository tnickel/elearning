"""Staged Didactic Concept Generator tailored for GLM-5.3.

Provides:
- Dedicated GLM-5.3 prompts strictly focused on didactic curriculum structure (NO slides, NO scripts).
- Staged generation:
    1. Macro framework (course title, target audience, prerequisites, didactic approach, week outlines)
    2. Week-by-week detail generation (lessons, operationalized learning objectives, UE, methodology, exercises)
- Automatic generation of a branded PDF document via ReportLab.
"""

import os
import re
import json
import time
from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field
import httpx
from openai import OpenAI
import instructor

import config
from concept_pdf import create_concept_pdf


# =====================================================================
# Pydantic Schemas (Strictly Concept, No Slides / Audio)
# =====================================================================

class ConceptLessonSchema(BaseModel):
    title: str = Field(..., description="Prägnanter Titel der Lerneinheit / Lektion")
    description: str = Field(..., description="Didaktische Kurzbeschreibung der Inhalte und Relevanz")
    learning_objectives: List[str] = Field(
        ...,
        min_length=2,
        max_length=5,
        description="2 bis 5 konkrete, operationalisierte Kompetenzziele ('Die Teilnehmenden können...')"
    )
    target_ue: int = Field(8, description="Geplante Unterrichtseinheiten (UE à 45 Min) für diese Einheit")
    methodology: str = Field("Praxis-Lab / Hands-On", description="Lehrmethode, z.B. 'Hands-On Lab', 'Interaktiver Workshop', 'Fallstudie'")
    practical_exercise: str = Field(..., description="Konkrete praktische Transfer-Übung oder Coding-Aufgabe")


class WeekDetailSchema(BaseModel):
    week_number: int = Field(..., description="Nummer der Woche (z.B. 1, 2)")
    title: str = Field(..., description="Thema des Moduls dieser Woche")
    weekly_goal: str = Field(..., description="Übergeordnetes Meilenstein-Ziel dieser Woche")
    total_ue: int = Field(40, description="Gesamte UEs dieser Woche (z.B. 40)")
    lessons: List[ConceptLessonSchema] = Field(
        ...,
        min_length=2,
        max_length=5,
        description="3 bis 5 thematisch aufbauende Lerneinheiten für diese Woche"
    )


class WeekOutlineSchema(BaseModel):
    week_number: int = Field(..., description="Wochennummer (1 bis N)")
    title: str = Field(..., description="Modultitel dieser Woche")
    weekly_goal: str = Field(..., description="Kernziel / Wochenmeilenstein")
    target_ue: int = Field(40, description="Geplante UEs für diese Woche (z.B. 8 oder 40)")


class MacroConceptSchema(BaseModel):
    course_title: str = Field(..., description="Vollständiger, professioneller Titel der Weiterbildung")
    executive_summary: str = Field(..., description="Pädagogische Leitidee und Kursüberblick (2-3 prägnante Absätze)")
    target_audience: str = Field(..., description="Zielgruppe der Teilnehmenden")
    prerequisites: str = Field(..., description="Fachliche und technische Voraussetzungen")
    didactic_approach: str = Field(..., description="Didaktischer Leitansatz (z.B. Blended Learning, Problem-Based Learning)")
    total_ue: int = Field(..., description="Gesamtsumme aller Unterrichtseinheiten (UE)")
    duration_desc: str = Field(..., description="Textuelle Angabe des Umfangs (z.B. '2 Wochen (80 UE)')")
    weeks: List[WeekOutlineSchema] = Field(..., description="Grobe Übersicht der einzelnen Kurswochen")


class ConceptRequest(BaseModel):
    topic: str
    duration: Optional[str] = "2_weeks"
    tenant_id: Optional[str] = "default"
    custom_prompt: Optional[str] = None
    course_id: Optional[str] = None


class FullConceptResponse(BaseModel):
    course_id: Optional[str] = None
    course_title: str
    executive_summary: str
    target_audience: str
    prerequisites: str
    didactic_approach: str
    total_ue: int
    duration_desc: str
    modules: List[WeekDetailSchema]
    pdf_path: Optional[str] = None
    pdf_url: Optional[str] = None


# =====================================================================
# GLM-5.3 Special Prompts & Staged Execution
# =====================================================================

GLM_MACRO_SYSTEM_PROMPT = """Du bist ein leitender Didaktik- und Curriculum-Architekt für hochwertige, nach DQR/AZAV ausgerichtete IT-Weiterbildungen.
Deine Aufgabe ist es, das didaktische MAKRO-Konzept (den übergeordneten Rahmenlehrplan) für eine Schulung zu entwerfen.
WICHTIGSTE REGELN:
- Erstelle AUSSCHLIESSLICH den didaktischen Rahmen (Module, Wochenziele, Zielgruppe, Voraussetzungen).
- Generiere KEINE Folieninhalte, KEINE Sprechertexte, KEINE Prüfungsfragen.
- Formuliere präzise, professionell und didaktisch fundiert.
- Antworte strikt im vorgegebenen JSON-Schema."""

GLM_WEEK_SYSTEM_PROMPT = """Du bist ein Fachdidaktiker und Lehrplanentwickler.
Deine Aufgabe ist es, für eine EINZELNE Kurswoche die konkreten Lerneinheiten mit operationalisierten Lernzielen zu detaillieren.
WICHTIGSTE REGELN:
- KEINE Folien, KEINE Skripte.
- 3 bis 5 Lektionen pro Woche.
- Jede Lektion benötigt 2 bis 4 überprüfbare Kompetenzziele im Stil von: "Die Teilnehmenden können [Handlung/Kompetenz]...".
- Gib für jede Lektion eine praktische Transferaufgabe/Hands-On Übung an.
- Antworte strikt im vorgegebenen JSON-Schema."""


def _get_client_and_model():
    provider = config.get_llm_provider()
    if provider in ["glm", "zhipu", "zai"]:
        base_url = config.get_glm_base_url()
        api_key = config.get_glm_api_key()
        model_name = config.get_glm_model()
    else:
        base_url = "https://openrouter.ai/api/v1"
        api_key = config.get_openrouter_api_key()
        model_name = config.get_openrouter_model()

    # GLM-5.3 needs comfortable timeout for reasoning tokens
    http_client = httpx.Client(timeout=180.0)
    raw_client = OpenAI(base_url=base_url, api_key=api_key or "mock-key", http_client=http_client)
    client = instructor.from_openai(raw_client)
    return client, model_name


def _parse_duration_info(duration: str) -> (int, str, int):
    """Returns (num_weeks, duration_str, total_ue)."""
    if duration in ["1_day", "1day", "mini", "1_hour"]:
        return 1, "eintägigen Intensiv-Workshop (8 UE)", 8
    
    m = re.match(r"^(\d+)_weeks?$", duration or "")
    if m:
        w = int(m.group(1))
        return max(1, min(w, 12)), f"{w}-wöchigen Fachlehrgang ({w * 40} UE)", w * 40
    
    if duration in ["4_weeks", "4weeks"]:
        return 4, "vierwöchigen Fachlehrgang (160 UE)", 160
    if duration in ["8_weeks", "8weeks"]:
        return 8, "achtwöchigen Bootcamp-Lehrgang (320 UE)", 320
    
    return 2, "zweiwöchigen Fachkurs (80 UE)", 80


def generate_mock_concept(req: ConceptRequest) -> FullConceptResponse:
    weeks_count, dur_str, total_ue = _parse_duration_info(req.duration or "2_weeks")
    modules = []
    for w in range(1, weeks_count + 1):
        modules.append(
            WeekDetailSchema(
                week_number=w,
                title=f"Woche {w}: Kernkompetenzen und Praxisfundamente ({req.topic})",
                weekly_goal=f"Die Teilnehmenden beherrschen die wesentlichen Grundlagen und Bausteine von {req.topic} in Woche {w}.",
                total_ue=40 if total_ue > 8 else 8,
                lessons=[
                    ConceptLessonSchema(
                        title=f"Einführung & Orientierung {w}.1",
                        description=f"Konzeptionelle Grundlagen und Einordnung von {req.topic}.",
                        learning_objectives=[
                            "Die Teilnehmenden verstehen die Kernbegriffe und Systemgrenzen.",
                            "Die Teilnehmenden können Architekturmuster korrekt identifizieren."
                        ],
                        target_ue=8,
                        methodology="Interaktiver Vortrag & Diskussion",
                        practical_exercise="Analyse eines realen Fallbeispiels und Architekturskizze."
                    ),
                    ConceptLessonSchema(
                        title=f"Praxisanwendung & Implementierung {w}.2",
                        description=f"Hands-On Vertiefung mit Best Practices zu {req.topic}.",
                        learning_objectives=[
                            "Die Teilnehmenden wenden Entwurfsmuster fehlerfrei im Code an.",
                            "Die Teilnehmenden führen selbstständig Refactoring und Validierung durch."
                        ],
                        target_ue=16,
                        methodology="Hands-On Coding Lab",
                        practical_exercise="Entwicklung eines lauffähigen Prototyps im Team."
                    ),
                    ConceptLessonSchema(
                        title=f"Wochenmeilenstein & Review {w}.3",
                        description=f"Konsolidierung und Meilenstein-Präsentation für Woche {w}.",
                        learning_objectives=[
                            "Die Teilnehmenden können ihre Lösungen vor Fachkollegen verteidigen.",
                            "Die Teilnehmenden identifizieren Optimierungspotenziale durch Peer-Review."
                        ],
                        target_ue=16,
                        methodology="Projektarbeit & Peer-Review",
                        practical_exercise="Code-Review und Dokumentation des Gesamtergebnisses."
                    )
                ]
            )
        )

    return FullConceptResponse(
        course_id=req.course_id,
        course_title=f"Didaktisches Konzept: {req.topic}",
        executive_summary=f"Dieser Lehrplan bietet ein didaktisch optimiertes Rahmenkonzept für {req.topic}. Ziel ist die zielgerichtete Vermittlung von fundiertem Praxiswissen nach modernsten didaktischen Standards.",
        target_audience="Softwareentwickler, IT-Fachkräfte und technische Quereinsteiger",
        prerequisites="Grundlegende Programmierkenntnisse und Interesse an professioneller Softwarearchitektur",
        didactic_approach="Blended Learning mit problembasiertem Unterricht (PBL) und täglichen Praxislabs",
        total_ue=total_ue,
        duration_desc=dur_str,
        modules=modules
    )


def generate_staged_concept(req: ConceptRequest) -> FullConceptResponse:
    """Orchestrates staged generation for GLM-5.3:
    Stufe 1: Macro-Outline (FAST ~10-15s)
    Stufe 2..N: Iterative Week Details (FAST ~8-12s each)
    Stufe Final: PDF-Generierung via ReportLab
    """
    if config.get_llm_provider() not in ["glm", "zhipu", "zai"] and not config.get_glm_api_key():
        return generate_mock_concept(req)

    client, model_name = _get_client_and_model()
    weeks_count, default_dur_str, expected_total_ue = _parse_duration_info(req.duration or "2_weeks")

    print(f"[concept_generator] Stufe 1: Starte Makro-Konzept für '{req.topic}' ({req.duration}) mit {model_name}...", flush=True)

    # -------------------------------------------------------------
    # STUFE 1: Makro-Konzept (Titel, Profil, Wochenübersicht)
    # -------------------------------------------------------------
    macro_user_prompt = f"""Erstelle das didaktische Makro-Konzept für folgende Schulungsanforderung:
- Thema: "{req.topic}"
- Geplanter Umfang: {weeks_count} Woche(n) (ca. {expected_total_ue} UE)
- Didaktische Anforderung: Rein didaktischer Rahmenlehrplan (keine Folieninhalte, keine Skripte).
{f'Zusätzliche Wünsche: {req.custom_prompt}' if req.custom_prompt else ''}

Erstelle:
1. Einen professionellen, klaren Kurstitel
2. Eine prägnante Pädagogische Leitidee / Executive Summary (2-3 Absätze)
3. Zielgruppe & Voraussetzungen
4. Didaktischer Leitansatz
5. Genaue Aufteilung in exakt {weeks_count} Woche(n) mit jeweils prägnantem Titel, Wochenziel und geplanter UE-Zahl."""

    try:
        t0 = time.time()
        macro: MacroConceptSchema = client.chat.completions.create(
            model=model_name,
            response_model=MacroConceptSchema,
            messages=[
                {"role": "system", "content": GLM_MACRO_SYSTEM_PROMPT},
                {"role": "user", "content": macro_user_prompt}
            ],
            temperature=0.5
        )
        print(f"[concept_generator] Stufe 1 abgeschlossen in {time.time() - t0:.1f}s. Titel: {macro.course_title}, Wochen: {len(macro.weeks)}", flush=True)
    except Exception as e:
        print(f"[concept_generator] Fehler in Stufe 1: {e}", flush=True)
        # Fallback to mock on severe API error
        return generate_mock_concept(req)

    # -------------------------------------------------------------
    # STUFE 2: Wochenweise Detaillierung (Step-by-Step)
    # -------------------------------------------------------------
    detailed_modules: List[WeekDetailSchema] = []

    for w_outline in macro.weeks:
        w_num = w_outline.week_number
        print(f"[concept_generator] Stufe 2 ({w_num}/{len(macro.weeks)}): Detailliere Woche {w_num} '{w_outline.title}'...", flush=True)

        week_user_prompt = f"""Detailliere die folgende Kurswoche didaktisch aus:
- Kurs: "{macro.course_title}"
- Woche {w_num}: "{w_outline.title}"
- Wochenziel: "{w_outline.weekly_goal}"
- Geplanter Zeitumfang: {w_outline.target_ue} UE

Erstelle für diese Woche 3 bis 5 thematisch logisch aufeinander aufbauende Lerneinheiten (Lektionen).
Für jede Lerneinheit:
- Prägnanter Titel & didaktische Beschreibung
- 2 bis 4 konkrete, überprüfbare Kompetenzziele ("Die Teilnehmenden können...")
- Realistische UE-Zahl (in Summe ca. {w_outline.target_ue} UE)
- Methodik (z.B. Hands-on Lab, Workshop)
- Eine konkrete Praxisübung / Transferaufgabe"""

        try:
            t_w = time.time()
            week_detail: WeekDetailSchema = client.chat.completions.create(
                model=model_name,
                response_model=WeekDetailSchema,
                messages=[
                    {"role": "system", "content": GLM_WEEK_SYSTEM_PROMPT},
                    {"role": "user", "content": week_user_prompt}
                ],
                temperature=0.5
            )
            # Ensure week number and outline values are preserved
            week_detail.week_number = w_num
            if not week_detail.title:
                week_detail.title = w_outline.title
            print(f"[concept_generator] Woche {w_num} fertiggestellt in {time.time() - t_w:.1f}s mit {len(week_detail.lessons)} Lektionen.", flush=True)
            detailed_modules.append(week_detail)
        except Exception as e:
            print(f"[concept_generator] Warnung: Fehler bei Woche {w_num} ({e}). Verwende didaktischen Fallback für diese Woche.", flush=True)
            # Fallback week if single week fails
            detailed_modules.append(
                WeekDetailSchema(
                    week_number=w_num,
                    title=w_outline.title,
                    weekly_goal=w_outline.weekly_goal,
                    total_ue=w_outline.target_ue,
                    lessons=[
                        ConceptLessonSchema(
                            title=f"Schwerpunkt: {w_outline.title}",
                            description=f"Didaktische Grundlagen und Vertiefung zu {w_outline.weekly_goal}.",
                            learning_objectives=[
                                "Die Teilnehmenden verstehen die relevanten theoretischen Zusammenhänge.",
                                "Die Teilnehmenden können die Konzepte eigenständig in der Praxis umsetzen."
                            ],
                            target_ue=w_outline.target_ue // 2 or 4,
                            methodology="Workshop & Live-Coding",
                            practical_exercise="Praxis-Labor mit direktem Feedback."
                        ),
                        ConceptLessonSchema(
                            title=f"Transfer & Meilenstein: {w_outline.title}",
                            description=f"Praktischer Transfer und Validierung des Lernerfolgs.",
                            learning_objectives=[
                                "Die Teilnehmenden wenden Best Practices sicher an.",
                                "Die Teilnehmenden reflektieren Lernergebnisse in einer Review-Session."
                            ],
                            target_ue=w_outline.target_ue // 2 or 4,
                            methodology="Hands-On Projekt",
                            practical_exercise="Meilenstein-Implementierung und Dokumentation."
                        )
                    ]
                )
            )

    # -------------------------------------------------------------
    # STUFE 3: PDF Generierung (ReportLab)
    # -------------------------------------------------------------
    course_id = req.course_id or f"concept_{int(time.time())}"
    
    # Root output directory for courses
    project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    output_dir = os.path.join(project_root, "course_output", course_id)
    pdf_path = os.path.join(output_dir, "didaktisches_konzept.pdf")
    pdf_url = f"/course_output/{course_id}/didaktisches_konzept.pdf"

    concept_dict = {
        "course_title": macro.course_title,
        "executive_summary": macro.executive_summary,
        "target_audience": macro.target_audience,
        "prerequisites": macro.prerequisites,
        "didactic_approach": macro.didactic_approach,
        "total_ue": macro.total_ue,
        "duration_desc": macro.duration_desc,
        "modules": [m.model_dump() for m in detailed_modules]
    }

    try:
        print(f"[concept_generator] Erstelle PDF unter {pdf_path}...", flush=True)
        create_concept_pdf(concept_dict, pdf_path)
        print(f"[concept_generator] PDF erfolgreich erstellt ({os.path.getsize(pdf_path)} Bytes).", flush=True)
    except Exception as pdf_err:
        print(f"[concept_generator] PDF-Erstellung fehlgeschlagen: {pdf_err}", flush=True)
        pdf_path = None
        pdf_url = None

    return FullConceptResponse(
        course_id=course_id,
        course_title=macro.course_title,
        executive_summary=macro.executive_summary,
        target_audience=macro.target_audience,
        prerequisites=macro.prerequisites,
        didactic_approach=macro.didactic_approach,
        total_ue=macro.total_ue,
        duration_desc=macro.duration_desc,
        modules=detailed_modules,
        pdf_path=pdf_path,
        pdf_url=pdf_url
    )
