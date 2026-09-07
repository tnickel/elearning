"""Meso Generator for Course Factory (Phase 2 Pipeline).

Slices an individual day into exactly 8 Unterrichtseinheiten (UEs) à 45 minutes
conforming to DayPlanSchema and outputs 'day_{n}_plan.json'.
Assigns target_agent ('video_script_agent', 'coding_exercise_agent', 'quiz_agent')
to each UE based on didactic role.
"""

import json
import os
from typing import Optional, List
from .schemas import (
    DayOverview,
    DayPlanSchema,
    UnitPlan,
    UeType,
    TargetAgent,
)
from .llm_client import call_structured_llm


def create_mock_day_plan(day_overview: DayOverview, course_title: str) -> DayPlanSchema:
    """Generates a realistic mock DayPlan with 8 UEs for testing or offline mode."""
    breakdown = day_overview.units_breakdown
    theory_count = breakdown.theory_ue
    practice_count = breakdown.practice_ue
    assessment_count = breakdown.assessment_ue

    # Fallback if sum is not 8
    if theory_count + practice_count + assessment_count != 8:
        theory_count, practice_count, assessment_count = 2, 4, 2

    units: List[UnitPlan] = []
    ue_num = 1

    # 1. Theory Units (Video Script Agent)
    for t_idx in range(1, theory_count + 1):
        units.append(
            UnitPlan(
                ue_number=ue_num,
                ue_title=f"Theorie {t_idx}: Grundlagen & Konzepte zu {day_overview.day_theme}",
                ue_type="theory",
                target_agent="video_script_agent",
                learning_objective=f"Die Teilnehmer verstehen die Kernmechanismen und Architektur von Einheit {t_idx}.",
                content_outline=[
                    f"Einführung und Motivation für {day_overview.day_theme}",
                    "Systemkomponenten und Schnittstellen im Überblick",
                    "Best Practices und typische Fallstricke in der Praxis",
                ],
            )
        )
        ue_num += 1

    # 2. Practice Units (Coding Exercise Agent)
    for p_idx in range(1, practice_count + 1):
        units.append(
            UnitPlan(
                ue_number=ue_num,
                ue_title=f"Praxis {p_idx}: Hands-on Implementierung {day_overview.day_theme}",
                ue_type="practice",
                target_agent="coding_exercise_agent",
                learning_objective=f"Die Teilnehmer implementieren selbstständig ein lauffähiges Modul für Teil {p_idx}.",
                content_outline=[
                    "Vorbereitung des Boilerplates und Analyse der Anforderungen",
                    "Schritt-für-Schritt Implementierung der Kernlogik",
                    "Lokales Testen, Error-Handling und Validierung",
                ],
            )
        )
        ue_num += 1

    # 3. Assessment Units (Quiz Agent)
    for a_idx in range(1, assessment_count + 1):
        units.append(
            UnitPlan(
                ue_number=ue_num,
                ue_title=f"Assessment {a_idx}: Wissensüberprüfung & Review zu {day_overview.day_theme}",
                ue_type="assessment",
                target_agent="quiz_agent",
                learning_objective=f"Die Teilnehmer festigen das Wissen des Tages und prüfen ihr Verständnis.",
                content_outline=[
                    "Multiple-Choice Fragen zu Kernkonzepten",
                    "Architektur-Entscheidungen und Begründungen",
                    "Tages-Review und Zusammenfassung",
                ],
            )
        )
        ue_num += 1

    return DayPlanSchema(
        day_number=day_overview.day_number,
        day_theme=day_overview.day_theme,
        units=units,
    )


def generate_day_plan(
    day_overview: DayOverview,
    course_title: str,
    output_dir: Optional[str] = None,
    force_mock: bool = False,
) -> DayPlanSchema:
    """Generates the 8-UE day plan for a specific day using the self-healing LLM client.

    Saves output to {output_dir}/day_{day_number}_plan.json if output_dir is provided.
    """
    from .prompt_manager import get_prompt

    system_prompt, user_prompt = get_prompt(
        "meso_day_plan",
        course_title=course_title,
        day_number=day_overview.day_number,
        day_theme=day_overview.day_theme,
        didactic_approach=day_overview.didactic_approach,
        daily_milestone=day_overview.daily_milestone,
        theory_ue=day_overview.units_breakdown.theory_ue,
        practice_ue=day_overview.units_breakdown.practice_ue,
        assessment_ue=day_overview.units_breakdown.assessment_ue,
    )

    mock_fallback = create_mock_day_plan(day_overview, course_title)

    day_plan = call_structured_llm(
        prompt=user_prompt,
        system_prompt=system_prompt,
        response_schema=DayPlanSchema,
        mock_fallback=mock_fallback,
        force_mock=force_mock,
    )

    # Save to file if output_dir specified
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
        filename = f"day_{day_overview.day_number}_plan.json"
        file_path = os.path.join(output_dir, filename)
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(day_plan.model_dump(), f, indent=2, ensure_ascii=False)
        print(f"[Meso Generator] Saved Day Plan to: {file_path}")

    return day_plan
