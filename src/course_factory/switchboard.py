"""Switchboard Router for Course Factory (Micro Generation Phase).

Dynamically dispatches each UnitPlan to the designated target agent:
- video_script_agent   -> slides.json + elevenlabs_script.txt
- coding_exercise_agent -> instructions.md + boilerplate/ + solution/ + validation_criteria.json
- quiz_agent           -> quiz.json

Ensures output artifacts are stored in /course_output/week_{n}/day_{n}/ue_{n}_{type}/.
"""

from typing import Dict, Any, Optional, Callable
from .schemas import UnitPlan, DayPlanSchema
from .file_builder import CourseFileBuilder
from .agents.video_script_agent import generate_video_script
from .agents.coding_exercise_agent import generate_coding_exercise
from .agents.quiz_agent import generate_quiz
from .image_generator import generate_slide_images


class Switchboard:
    """Micro Generation Router."""

    def __init__(self, file_builder: Optional[CourseFileBuilder] = None):
        self.file_builder = file_builder or CourseFileBuilder()

    def route_unit(
        self,
        unit: UnitPlan,
        course_title: str,
        week_num: int,
        day_num: int,
        force_mock: bool = False,
        on_progress: Optional[Callable[[str], None]] = None,
    ) -> Any:
        """Routes a single unit to its target agent and saves to the strict directory."""
        ue_dir = self.file_builder.ensure_ue_dir(
            week_num=week_num,
            day_num=day_num,
            ue_num=unit.ue_number,
            ue_type=unit.ue_type,
        )

        agent = unit.target_agent
        print(f"[Switchboard] Routing UE {unit.ue_number} ('{unit.ue_title}') -> {agent}")

        if agent == "video_script_agent":
            if on_progress:
                on_progress(f"🎬 video_script_agent: Erstelle Folienkonzept & Layouts für '{unit.ue_title}'...")
            result = generate_video_script(
                course_title=course_title,
                ue_title=unit.ue_title,
                learning_objective=unit.learning_objective,
                content_outline=unit.content_outline,
                output_dir=ue_dir,
                force_mock=force_mock,
            )
            if on_progress:
                on_progress(f"🎬 video_script_agent: {len(result.slides)} Folien & ElevenLabs-Audio gespeichert.")

            # Generate contextual slide illustration cues
            if ue_dir:
                result = generate_slide_images(
                    video_script=result,
                    output_dir=ue_dir,
                    force_mock=force_mock,
                    on_progress=on_progress,
                )
        elif agent == "coding_exercise_agent":
            if on_progress:
                on_progress(f"💻 coding_exercise_agent: Erstelle Aufgabe, Starter-Code (# TODO) & Lösung für '{unit.ue_title}'...")
            result = generate_coding_exercise(
                course_title=course_title,
                ue_title=unit.ue_title,
                learning_objective=unit.learning_objective,
                content_outline=unit.content_outline,
                output_dir=ue_dir,
                force_mock=force_mock,
            )
            if on_progress:
                on_progress(f"💻 coding_exercise_agent: {len(result.files)} Code-Dateien & Kriterien validiert.")
        elif agent == "quiz_agent":
            if on_progress:
                on_progress(f"❓ quiz_agent: Generiere 10 didaktische Multiple-Choice-Fragen für '{unit.ue_title}'...")
            result = generate_quiz(
                course_title=course_title,
                ue_title=unit.ue_title,
                learning_objective=unit.learning_objective,
                content_outline=unit.content_outline,
                output_dir=ue_dir,
                force_mock=force_mock,
            )
            if on_progress:
                on_progress(f"❓ quiz_agent: 10 Kontrollfragen mit didaktischen Erklärungen gespeichert.")
        else:
            raise ValueError(f"Unknown target_agent '{agent}' for UE {unit.ue_number}")

        # Verify output artifacts
        verification = self.file_builder.verify_ue_artifacts(
            week_num=week_num,
            day_num=day_num,
            ue_num=unit.ue_number,
            ue_type=unit.ue_type,
            target_agent=agent,
        )
        print(f"[Switchboard] Artifacts verified for UE {unit.ue_number}: {verification}")
        if not all(verification.values()):
            failed_items = [k for k, v in verification.items() if not v]
            raise RuntimeError(
                f"Artifact verification failed for UE {unit.ue_number} ({agent}): missing or empty {failed_items}"
            )

        return result

    def route_day_units(
        self,
        day_plan: DayPlanSchema,
        course_title: str,
        week_num: int,
        force_mock: bool = False,
        on_progress: Optional[Callable[[str], None]] = None,
    ) -> Dict[int, Any]:
        """Routes all 8 units of a day through the switchboard."""
        results = {}
        for unit in day_plan.units:
            res = self.route_unit(
                unit=unit,
                course_title=course_title,
                week_num=week_num,
                day_num=day_plan.day_number,
                force_mock=force_mock,
                on_progress=on_progress,
            )
            results[unit.ue_number] = res

        return results
