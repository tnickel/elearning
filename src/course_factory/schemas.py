"""Pydantic schemas for the Course Factory Multi-Agent System.

Covers:
- Macro-level: MasterCurriculumSchema (8 weeks, 40 days)
- Meso-level: DayPlanSchema (8 UEs per day with target_agent routing)
- Micro-level:
    - VideoScriptSchema (slides.json + elevenlabs_script.txt)
    - CodingExerciseSchema (boilerplate, solution, markdown instructions)
    - QuizSchema (quiz.json with 10 questions and explanations)
"""

from typing import List, Literal, Optional, Dict
from pydantic import BaseModel, Field, field_validator, model_validator


# =====================================================================
# 1. MACRO LEVEL SCHEMAS (Master Curriculum: 8 Weeks, 40 Days)
# =====================================================================

class UnitBreakdown(BaseModel):
    theory_ue: int = Field(..., ge=0, description="Anzahl der Theorie-Einheiten (z.B. 2)")
    practice_ue: int = Field(..., ge=0, description="Anzahl der Praxis/Projekt-Einheiten (z.B. 4)")
    assessment_ue: int = Field(..., ge=0, description="Anzahl der Einheiten für Wiederholung/Kontrollfragen (z.B. 2)")

    @field_validator("assessment_ue")
    @classmethod
    def validate_total_units(cls, v, info):
        theory = info.data.get("theory_ue", 0)
        practice = info.data.get("practice_ue", 0)
        total = theory + practice + v
        if total != 8:
            raise ValueError(
                f"Total units must equal 8 (got {theory} theory + {practice} practice + {v} assessment = {total})"
            )
        return v


class DayOverview(BaseModel):
    day_number: int = Field(..., ge=1, le=365, description="Fortlaufende Tagesnummer")
    day_theme: str = Field(..., description="Tagesziel / Thema des Tages")
    didactic_approach: str = Field(..., description="Kurze Beschreibung, wie Theorie und Praxis gemischt werden")
    units_breakdown: UnitBreakdown = Field(..., description="Verteilung der 8 UEs auf Theorie, Praxis, Assessment")
    daily_milestone: str = Field(..., description="Was die Teilnehmer am Ende des Tages lauffähig haben oder verstehen")


class WeekPlan(BaseModel):
    week_number: int = Field(..., ge=1, le=52, description="Wochennummer (1-52)")
    week_theme: str = Field(..., description="Übergeordnetes Thema der Woche")
    days: List[DayOverview] = Field(..., description="Liste der Tage dieser Woche")


class MasterCurriculumSchema(BaseModel):
    course_title: str = Field(..., description="Titel des gesamten Kurses")
    target_audience: str = Field(..., description="Zielgruppe der Weiterbildung")
    total_weeks: int = Field(8, description="Gesamtzahl der Wochen")
    weeks: List[WeekPlan] = Field(..., description="Liste der Wochenpläne mit ihren Unterrichtstagen")


# =====================================================================
# 2. MESO LEVEL SCHEMAS (Day Slicer: 8 Units per Day)
# =====================================================================

UeType = Literal["theory", "practice", "assessment"]
TargetAgent = Literal["video_script_agent", "coding_exercise_agent", "quiz_agent"]


class UnitPlan(BaseModel):
    ue_number: int = Field(..., ge=1, le=8, description="Unterrichtseinheit 1 bis 8")
    ue_title: str = Field(..., description="Titel der 45-Minuten-Einheit")
    ue_type: UeType = Field(..., description="'theory', 'practice' oder 'assessment'")
    target_agent: TargetAgent = Field(
        ...,
        description="'video_script_agent' für Theorie, 'coding_exercise_agent' für Praxis, 'quiz_agent' für Assessment"
    )
    learning_objective: str = Field(..., description="Was können/wissen die Teilnehmer nach diesen 45 Minuten?")
    content_outline: List[str] = Field(..., min_length=1, description="3-5 inhaltliche Schwerpunkte / Bullet Points")

    @model_validator(mode="after")
    def validate_type_agent_alignment(self):
        expected_agent = {
            "theory": "video_script_agent",
            "practice": "coding_exercise_agent",
            "assessment": "quiz_agent",
        }.get(self.ue_type)
        if expected_agent and self.target_agent != expected_agent:
            raise ValueError(
                f"ue_type '{self.ue_type}' requires target_agent '{expected_agent}', got '{self.target_agent}'"
            )
        return self


class DayPlanSchema(BaseModel):
    day_number: int = Field(..., ge=1, le=365, description="Tagesnummer (1-365)")
    day_theme: str = Field(..., description="Thema des Tages")
    units: List[UnitPlan] = Field(..., min_length=8, max_length=8, description="Exakt 8 Einheiten für den Tag")

    @model_validator(mode="after")
    def validate_unique_unit_numbers(self):
        nums = [u.ue_number for u in self.units]
        if len(set(nums)) != len(nums):
            raise ValueError(f"Unit numbers in day plan must be unique, got duplicate numbers: {nums}")
        return self


# =====================================================================
# 3. MICRO LEVEL SCHEMAS (Specialized Sub-Agents)
# =====================================================================

# --- A. Video Script Agent ---

class ImageCue(BaseModel):
    """Ein Bildwechsel-Signal innerhalb einer Folie zur audio-synchronen Illustration."""
    timestamp_percent: int = Field(
        ..., ge=0, le=100, description="Zeitpunkt im Folien-Audio (0% = Start, 100% = Ende)"
    )
    prompt: str = Field(
        ..., min_length=10, max_length=600, description="Konkreter Bild-Prompt für fotorealistische Illustration (ohne Text)"
    )
    transition: Literal["fade", "slide_left", "slide_right", "zoom_in", "cut"] = Field(
        default="fade", description="Übergangseffekt zum nächsten Bild"
    )
    image_url: Optional[str] = Field(
        default=None, description="Relativer oder HTTP-Pfad zum generierten Bild"
    )


class SlideOnSlideText(BaseModel):
    heading: str = Field(..., description="Maximal 5-7 Wörter")
    bullet_points_or_code: List[str] = Field(default_factory=list, description="Kompakte Stichpunkte oder Codezeilen")


class Slide(BaseModel):
    slide_number: int = Field(..., ge=1, description="Foliennummer (1-basiert)")
    layout_type: Literal["Title_Slide", "Code_Snippet", "Diagram", "Icon_Grid", "Comparison", "Illustrated"] = Field(
        ...,
        description="Layout: 'Title_Slide', 'Code_Snippet', 'Diagram', 'Icon_Grid', 'Comparison', 'Illustrated'"
    )
    visual_description: str = Field(..., description="Detaillierte Anweisung für Grafik-Engine, Mermaid oder Codeblock")
    on_slide_text: SlideOnSlideText = Field(..., description="Text auf der Folie")
    elevenlabs_script: str = Field(..., description="Gesprochener Text für diese Folie (für ElevenLabs optimiert)")
    image_cues: Optional[List[ImageCue]] = Field(
        default=None,
        description="1-4 Bildwechsel-Signale für kontextuelle KI-Illustrationen passend zum Sprechertext"
    )


class VideoScriptSchema(BaseModel):
    ue_title: str = Field(..., description="Titel der Einheit")
    estimated_video_duration_minutes: int = Field(..., ge=1, description="Geschätzte Videodauer in Minuten")
    visual_style: Optional[str] = Field(
        default="Fotorealistisch, hochwertige Ausleuchtung, realistische Szenen, keine generierten Texte",
        description="Konsistenter visueller Stil für alle generierten Bilder dieser UE"
    )
    slides: List[Slide] = Field(..., min_length=1, max_length=12, description="1–12 Folien; 1 für Minikurs-Schnelltest, Ziel für Theorie-UE: 8–12 (10–15 Min Video)")


# --- B. Coding Exercise Agent ---

class ExerciseFile(BaseModel):
    filename: str = Field(..., description="Dateiname, z.B. 'main.py' oder 'agent.py'")
    boilerplate_code: str = Field(..., description="Starter-Code mit # TODO Lücken für Teilnehmer")
    solution_code: str = Field(..., description="Vollständige, lauffähige Musterlösung")


class CodingExerciseSchema(BaseModel):
    ue_title: str = Field(..., description="Titel der Einheit")
    exercise_title: str = Field(..., description="Motivierender Titel der Aufgabe")
    difficulty_level: Literal["Beginner", "Intermediate", "Advanced"] = Field("Intermediate")
    student_instructions_md: str = Field(..., description="Ausführliche Aufgabenstellung im Markdown-Format")
    files: List[ExerciseFile] = Field(..., min_length=1, description="Dateien (Starter & Lösung)")
    validation_criteria: List[str] = Field(..., min_length=1, description="Prüfkriterien für Review oder automatische Tests")


# --- C. Quiz Agent ---

class QuizOptions(BaseModel):
    A: str = Field(..., description="Option A")
    B: str = Field(..., description="Option B")
    C: str = Field(..., description="Option C")
    D: str = Field(..., description="Option D")


class QuizQuestionItem(BaseModel):
    question_id: int = Field(..., ge=1, le=10, description="Nummer der Frage (1-10)")
    question_text: str = Field(..., description="Die Prüfungsfrage")
    options: QuizOptions = Field(..., description="Vier Antwortmöglichkeiten A, B, C, D")
    correct_option: Literal["A", "B", "C", "D"] = Field(..., description="Der korrekte Buchstabe ('A', 'B', 'C' oder 'D')")
    explanation: str = Field(..., description="Didaktische Erklärung, warum die Antwort korrekt ist")


class QuizSchema(BaseModel):
    ue_title: str = Field(..., description="Titel der Einheit")
    quiz_title: str = Field(..., description="Titel des Quiz / Knowledge Checks")
    questions: List[QuizQuestionItem] = Field(..., min_length=10, max_length=10, description="Exakt 10 Multiple-Choice Fragen")
