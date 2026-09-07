"""Macro Generator for Course Factory (Phase 1 Pipeline).

Generates the 8-week Master Curriculum (40 days total, 8 UEs/day)
conforming to MasterCurriculumSchema and outputs 'master_curriculum.json'.
"""

import json
import os
from typing import Optional
from .schemas import (
    MasterCurriculumSchema,
    WeekPlan,
    DayOverview,
    UnitBreakdown,
)
from .llm_client import call_structured_llm


def create_mock_master_curriculum(
    course_title: str,
    target_audience: str,
    total_weeks: int = 8,
    total_days: Optional[int] = None,
) -> MasterCurriculumSchema:
    """Creates a complete, didactic curriculum mock for the desired duration.

    Supports:
    - 1 Day Test-Mode (total_days=1, total_weeks=1) -> 8 UEs
    - 1 Week (total_weeks=1, 5 days) -> 40 UEs
    - 2 Weeks (total_weeks=2, 10 days) -> 80 UEs
    - 4 Weeks / 1 Month (total_weeks=4, 20 days) -> 160 UEs
    - 6 Weeks (total_weeks=6, 30 days) -> 240 UEs
    - 8 Weeks / 2 Months (total_weeks=8, 40 days) -> 320 UEs
    """
    base_themes = [
        "Grundlagen & Moderne Entwicklungsumgebungen (Python, Git, LLM-APIs)",
        "Prompt Engineering, Structured Outputs & Validierung (Pydantic, Instructor)",
        "Vektor-Datenbanken, Embeddings & RAG-Architekturen",
        "Autonome Agenten & Werkzeuge (Tool Calling, ReAct, LangGraph)",
        "Multi-Agenten-Systeme & Orchestrierung (Temporal, State Machines)",
        "Testing, Evaluation & Observability (Traces, Benchmarks, CI/CD)",
        "Deployment, Skalierung & Sicherheit (FastAPI, Docker, Rate-Limiting, Guardrails)",
        "Abschlussprojekt: End-to-End Enterprise Agentic Application",
    ]

    # Special case: 1-Day Test-Mode
    if total_days == 1:
        single_day = DayOverview(
            day_number=1,
            day_theme="Schnellstart & Praxiseinführung: LLM-Agenten & Workflows",
            didactic_approach="Kompakter 1-Tages-Intensivüberblick mit Theorie, Hands-on Tool Calling und Abschlussquiz.",
            units_breakdown=UnitBreakdown(theory_ue=3, practice_ue=4, assessment_ue=1),
            daily_milestone="Lauffähiger Prototyp und Verständnis der Kernkonzepte an Tag 1",
        )
        return MasterCurriculumSchema(
            course_title=course_title,
            target_audience=target_audience,
            total_weeks=1,
            weeks=[
                WeekPlan(
                    week_number=1,
                    week_theme="1-Tages-Intensivworkshop (Kompaktkurs)",
                    days=[single_day],
                )
            ],
        )

    # Determine themes for the requested number of weeks
    weeks = []
    day_counter = 1
    max_days_target = total_days if total_days is not None else (total_weeks * 5)

    for week_idx in range(1, total_weeks + 1):
        if len(base_themes) >= week_idx:
            theme = base_themes[week_idx - 1]
        else:
            theme = f"Vertiefung & Erweiterung: {course_title} (Modul {week_idx})"

        days = []
        for d in range(1, 6):
            if day_counter > max_days_target:
                break

            if d in [1, 2]:
                theory = 3
                practice = 4
                assessment = 1
                approach = "Konzepteinführung gefolgt von geführten Programmierübungen."
            elif d in [3, 4]:
                theory = 2
                practice = 5
                assessment = 1
                approach = "Fokus auf eigenständiges Hands-on Coding und Problemlösung."
            else:
                # Day 5: Review & Milestone Assessment
                theory = 1
                practice = 5
                assessment = 2
                approach = "Wochen-Review, Code-Review in Kleingruppen und didaktisches Assessment."

            days.append(
                DayOverview(
                    day_number=day_counter,
                    day_theme=f"{theme}: Tag {d} Schwerpunkt",
                    didactic_approach=approach,
                    units_breakdown=UnitBreakdown(
                        theory_ue=theory,
                        practice_ue=practice,
                        assessment_ue=assessment,
                    ),
                    daily_milestone=f"Lauffähiges Modul und verstandene Konzepte für Tag {day_counter}",
                )
            )
            day_counter += 1

        if days:
            weeks.append(
                WeekPlan(
                    week_number=week_idx,
                    week_theme=theme,
                    days=days,
                )
            )

    return MasterCurriculumSchema(
        course_title=course_title,
        target_audience=target_audience,
        total_weeks=len(weeks),
        weeks=weeks,
    )


def generate_macro_curriculum(
    course_title: str,
    target_audience: str = "Softwareentwickler mit grundlegender Programmiererfahrung",
    total_weeks: int = 8,
    total_days: Optional[int] = None,
    output_dir: Optional[str] = None,
    force_mock: bool = False,
) -> MasterCurriculumSchema:
    """Generates the master curriculum for the desired duration using the self-healing LLM client."""
    target_days = total_days if total_days is not None else (total_weeks * 5)

    if total_days == 1:
        duration_desc = "1 Tag (Kompakt-Testkurs, exakt 1 Unterrichtstag)"
    else:
        duration_desc = f"{total_weeks} Wochen ({target_days} Unterrichtstage insgesamt, Mo-Fr)"

    from .prompt_manager import get_prompt

    system_prompt, user_prompt = get_prompt(
        "macro_curriculum",
        course_title=course_title,
        target_audience=target_audience,
        duration_desc=duration_desc,
        total_weeks=total_weeks,
        target_days=target_days,
    )

    mock_data = create_mock_master_curriculum(
        course_title=course_title,
        target_audience=target_audience,
        total_weeks=total_weeks,
        total_days=total_days,
    )

    curriculum = call_structured_llm(
        prompt=user_prompt,
        system_prompt=system_prompt,
        response_schema=MasterCurriculumSchema,
        mock_fallback=mock_data,
        force_mock=force_mock,
    )

    # If output directory specified, save master_curriculum.json
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
        file_path = os.path.join(output_dir, "master_curriculum.json")
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(curriculum.model_dump(), f, indent=2, ensure_ascii=False)
        print(f"[Macro Generator] Saved Master Curriculum to: {file_path}")

    return curriculum
