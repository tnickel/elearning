"""Unit tests for Course Factory (Task 1: Schemas & LLM Client)."""

import pytest
import json
from src.course_factory.schemas import (
    MasterCurriculumSchema,
    WeekPlan,
    DayOverview,
    UnitBreakdown,
    DayPlanSchema,
    UnitPlan,
    VideoScriptSchema,
    Slide,
    SlideOnSlideText,
    CodingExerciseSchema,
    ExerciseFile,
    QuizSchema,
    QuizQuestionItem,
    QuizOptions,
)
from src.course_factory.llm_client import (
    extract_json_string,
    call_structured_llm,
)


def _sample_slides(n: int = 3):
    """Minimal valid slide deck for schema tests (min_length=3)."""
    layouts = ["Title_Slide", "Diagram", "Code_Snippet", "Icon_Grid", "Comparison"]
    return [
        Slide(
            slide_number=i,
            layout_type=layouts[(i - 1) % len(layouts)],
            visual_description=f"Visual {i}",
            on_slide_text=SlideOnSlideText(heading=f"Folie {i}", bullet_points_or_code=["Punkt"]),
            elevenlabs_script=f"Sprechertext für Folie {i}.",
        )
        for i in range(1, n + 1)
    ]


def test_extract_json_string():
    # 1. Pure json
    pure = '{"key": "val"}'
    assert extract_json_string(pure) == pure

    # 2. Markdown block
    md = 'Here is the output:\n```json\n{"key": "val"}\n```\nHope you like it!'
    assert extract_json_string(md) == '{"key": "val"}'

    # 3. Markdown block without language tag
    md2 = '```\n{"key": 123}\n```'
    assert extract_json_string(md2) == '{"key": 123}'

    # 4. Embedded in text
    text = 'Result: {"a": [1, 2, 3]} finished.'
    assert extract_json_string(text) == '{"a": [1, 2, 3]}'


def test_schemas_instantiation():
    # 1. MasterCurriculum
    week1_days = [
        DayOverview(
            day_number=d,
            day_theme=f"Thema Tag {d}",
            didactic_approach="Theorie + Praxis",
            units_breakdown=UnitBreakdown(theory_ue=2, practice_ue=4, assessment_ue=2),
            daily_milestone="Verstehen der Grundlagen",
        )
        for d in range(1, 6)
    ]
    curriculum = MasterCurriculumSchema(
        course_title="KI Softwareentwicklung",
        target_audience="Entwickler",
        total_weeks=1,
        weeks=[WeekPlan(week_number=1, week_theme="Grundlagen", days=week1_days)],
    )
    assert curriculum.weeks[0].days[0].units_breakdown.practice_ue == 4

    # 2. DayPlan
    units = [
        UnitPlan(
            ue_number=i,
            ue_title=f"Einheit {i}",
            ue_type="theory" if i <= 2 else ("practice" if i <= 6 else "assessment"),
            target_agent="video_script_agent" if i <= 2 else ("coding_exercise_agent" if i <= 6 else "quiz_agent"),
            learning_objective=f"Lernziel {i}",
            content_outline=["Punkt 1", "Punkt 2"],
        )
        for i in range(1, 9)
    ]
    day_plan = DayPlanSchema(day_number=1, day_theme="Setup & Intro", units=units)
    assert len(day_plan.units) == 8

    # 3. VideoScript
    video_script = VideoScriptSchema(
        ue_title="Einführung in KI",
        estimated_video_duration_minutes=12,
        slides=_sample_slides(3),
    )
    assert len(video_script.slides) == 3

    # 4. CodingExercise
    exercise = CodingExerciseSchema(
        ue_title="Hands-on API",
        exercise_title="API Wrapper bauen",
        difficulty_level="Intermediate",
        student_instructions_md="# Aufgabe\nBaue den API Wrapper.",
        files=[
            ExerciseFile(
                filename="main.py",
                boilerplate_code="# TODO: implement",
                solution_code="print('done')",
            )
        ],
        validation_criteria=["Keine Exceptions"],
    )
    assert exercise.files[0].filename == "main.py"

    # 5. Quiz (requires exactly 10 questions)
    quiz_questions = [
        QuizQuestionItem(
            question_id=i,
            question_text=f"Frage {i}: Was ist ein LLM?",
            options=QuizOptions(A="Large Language Model", B="Low Level Memory", C="Local Logic Module", D="None"),
            correct_option="A",
            explanation="LLM steht für Large Language Model.",
        )
        for i in range(1, 11)
    ]
    quiz = QuizSchema(
        ue_title="Review Tag 1",
        quiz_title="Knowledge Check",
        questions=quiz_questions,
    )
    assert len(quiz.questions) == 10
    assert quiz.questions[0].correct_option == "A"


def test_call_structured_llm_mock_fallback():
    mock_obj = VideoScriptSchema(
        ue_title="Mock Title",
        estimated_video_duration_minutes=10,
        slides=_sample_slides(3),
    )
    res = call_structured_llm(
        prompt="Test Prompt",
        system_prompt="Test System",
        response_schema=VideoScriptSchema,
        mock_fallback=mock_obj,
        force_mock=True,
    )
    assert res.ue_title == "Mock Title"


def test_self_healing_retry_loop(monkeypatch):
    """Simulates an LLM returning invalid JSON on attempt 1, and corrected JSON on attempt 2."""
    from unittest.mock import MagicMock

    attempt_counter = 0

    def mock_create(*args, **kwargs):
        nonlocal attempt_counter
        attempt_counter += 1
        choice_mock = MagicMock()
        if attempt_counter == 1:
            # Broken JSON with missing closing brace
            choice_mock.message.content = '{"ue_title": "Broken", "estimated_video_duration_minutes": 10'
        else:
            # Corrected valid JSON
            choice_mock.message.content = json.dumps({
                "ue_title": "Healed Title",
                "estimated_video_duration_minutes": 10,
                "slides": [
                    {
                        "slide_number": i,
                        "layout_type": "Title_Slide",
                        "visual_description": f"Visual {i}",
                        "on_slide_text": {"heading": f"Folie {i}", "bullet_points_or_code": []},
                        "elevenlabs_script": f"Spoken text {i}",
                    }
                    for i in range(1, 4)
                ]
            })
        resp = MagicMock()
        resp.choices = [choice_mock]
        return resp

    mock_client = MagicMock()
    mock_client.chat.completions.create = mock_create

    monkeypatch.setattr(
        "src.course_factory.llm_client.get_configured_llm_client",
        lambda: (mock_client, "test-model", False),
    )

    res = call_structured_llm(
        prompt="Test Prompt",
        system_prompt="Test System",
        response_schema=VideoScriptSchema,
        max_retries=3,
        force_mock=False,
    )

    assert attempt_counter == 2
    assert res.ue_title == "Healed Title"


def test_macro_generator(tmp_path):
    from src.course_factory.macro_generator import generate_macro_curriculum

    out_dir = str(tmp_path / "course_output")
    curriculum = generate_macro_curriculum(
        course_title="Test Kurs: KI Entwicklung",
        target_audience="Entwickler",
        output_dir=out_dir,
        force_mock=True,
    )

    assert curriculum.total_weeks == 8
    assert len(curriculum.weeks) == 8

    total_days = sum(len(w.days) for w in curriculum.weeks)
    assert total_days == 40

    for week in curriculum.weeks:
        for day in week.days:
            breakdown = day.units_breakdown
            assert breakdown.theory_ue + breakdown.practice_ue + breakdown.assessment_ue == 8

    # Verify JSON file written
    json_path = tmp_path / "course_output" / "master_curriculum.json"
    assert json_path.exists()

    with open(json_path, "r", encoding="utf-8") as f:
        loaded = json.load(f)
    assert loaded["course_title"] == "Test Kurs: KI Entwicklung"
    assert len(loaded["weeks"]) == 8


def test_meso_generator(tmp_path):
    from src.course_factory.meso_generator import generate_day_plan

    day_overview = DayOverview(
        day_number=1,
        day_theme="Setup, Git & LLM-APIs",
        didactic_approach="3 UE Theorie, 4 UE Praxis, 1 UE Assessment",
        units_breakdown=UnitBreakdown(theory_ue=3, practice_ue=4, assessment_ue=1),
        daily_milestone="Lauffähige Entwicklungsumgebung mit erstem API-Call",
    )

    out_dir = str(tmp_path / "course_output" / "week_1" / "day_1")
    day_plan = generate_day_plan(
        day_overview=day_overview,
        course_title="KI-gestützte Softwareentwicklung",
        output_dir=out_dir,
        force_mock=True,
    )

    assert day_plan.day_number == 1
    assert len(day_plan.units) == 8

    # Verify unit numbers 1..8
    assert [u.ue_number for u in day_plan.units] == list(range(1, 9))

    # Verify target agents
    agents = [u.target_agent for u in day_plan.units]
    assert agents.count("video_script_agent") == 3
    assert agents.count("coding_exercise_agent") == 4
    assert agents.count("quiz_agent") == 1

    # Verify file output
    plan_file = tmp_path / "course_output" / "week_1" / "day_1" / "day_1_plan.json"
    assert plan_file.exists()

    with open(plan_file, "r", encoding="utf-8") as f:
        data = json.load(f)
    assert data["day_number"] == 1
    assert len(data["units"]) == 8


def test_video_script_agent(tmp_path):
    from src.course_factory.agents.video_script_agent import generate_video_script

    out_dir = str(tmp_path / "course_output" / "week_1" / "day_1" / "ue_1_theory")
    script = generate_video_script(
        course_title="KI-Entwicklung",
        ue_title="Einführung in Agenten-Architekturen",
        learning_objective="Die Teilnehmer verstehen die Grundbausteine eines LLM-Agenten.",
        content_outline=["ReAct-Loop", "Tool Calling", "Memory"],
        output_dir=out_dir,
        force_mock=True,
    )

    assert len(script.slides) >= 3
    assert (tmp_path / "course_output" / "week_1" / "day_1" / "ue_1_theory" / "slides.json").exists()
    assert (tmp_path / "course_output" / "week_1" / "day_1" / "ue_1_theory" / "elevenlabs_script.txt").exists()

    with open(tmp_path / "course_output" / "week_1" / "day_1" / "ue_1_theory" / "elevenlabs_script.txt", "r", encoding="utf-8") as f:
        content = f.read()
    assert "Folie 1:" in content


def test_coding_exercise_agent(tmp_path):
    from src.course_factory.agents.coding_exercise_agent import generate_coding_exercise

    out_dir = str(tmp_path / "course_output" / "week_1" / "day_1" / "ue_3_practice")
    exercise = generate_coding_exercise(
        course_title="KI-Entwicklung",
        ue_title="Tool Calling mit Python",
        learning_objective="Die Teilnehmer implementieren einen Function Caller.",
        content_outline=["JSON Schema", "OpenAI Tools", "Error Handling"],
        output_dir=out_dir,
        force_mock=True,
    )

    assert len(exercise.files) >= 1
    assert (tmp_path / "course_output" / "week_1" / "day_1" / "ue_3_practice" / "instructions.md").exists()
    assert (tmp_path / "course_output" / "week_1" / "day_1" / "ue_3_practice" / "boilerplate" / "main.py").exists()
    assert (tmp_path / "course_output" / "week_1" / "day_1" / "ue_3_practice" / "solution" / "main.py").exists()
    assert (tmp_path / "course_output" / "week_1" / "day_1" / "ue_3_practice" / "validation_criteria.json").exists()


def test_quiz_agent(tmp_path):
    from src.course_factory.agents.quiz_agent import generate_quiz

    out_dir = str(tmp_path / "course_output" / "week_1" / "day_1" / "ue_8_assessment")
    quiz = generate_quiz(
        course_title="KI-Entwicklung",
        ue_title="Tages-Review Tag 1",
        learning_objective="Überprüfung der vermittelten Konzepte des ersten Tages.",
        content_outline=["Agenten-Architektur", "Tool Calling", "Best Practices"],
        output_dir=out_dir,
        force_mock=True,
    )

    assert len(quiz.questions) == 10
    quiz_file = tmp_path / "course_output" / "week_1" / "day_1" / "ue_8_assessment" / "quiz.json"
    assert quiz_file.exists()

    with open(quiz_file, "r", encoding="utf-8") as f:
        data = json.load(f)
    assert len(data["questions"]) == 10
    for q in data["questions"]:
        assert q["correct_option"] in ["A", "B", "C", "D"]
        assert len(q["explanation"]) > 5


def test_file_builder_paths(tmp_path):
    from src.course_factory.file_builder import CourseFileBuilder

    fb = CourseFileBuilder(base_output_dir=str(tmp_path / "course_output"))
    week_dir = fb.get_week_dir(2)
    assert week_dir.endswith("week_2")

    day_dir = fb.get_day_dir(2, 6)
    assert "week_2" in day_dir and day_dir.endswith("day_6")

    ue_dir = fb.get_ue_dir(2, 6, 4, "practice")
    assert ue_dir.endswith("ue_4_practice")


def test_switchboard_day_routing(tmp_path):
    from src.course_factory.file_builder import CourseFileBuilder
    from src.course_factory.switchboard import Switchboard
    from src.course_factory.meso_generator import create_mock_day_plan

    day_overview = DayOverview(
        day_number=1,
        day_theme="Setup & Basics",
        didactic_approach="3 Theorie, 4 Praxis, 1 Quiz",
        units_breakdown=UnitBreakdown(theory_ue=3, practice_ue=4, assessment_ue=1),
        daily_milestone="Tag 1 bereit",
    )

    day_plan = create_mock_day_plan(day_overview, "KI Kurs")
    fb = CourseFileBuilder(base_output_dir=str(tmp_path / "course_output"))
    sb = Switchboard(file_builder=fb)

    results = sb.route_day_units(
        day_plan=day_plan,
        course_title="KI Kurs",
        week_num=1,
        force_mock=True,
    )

    assert len(results) == 8

    # Verify all 8 UE directories exist
    base_day = tmp_path / "course_output" / "week_1" / "day_1"
    for u in range(1, 4):
        assert (base_day / f"ue_{u}_theory" / "slides.json").exists()
        assert (base_day / f"ue_{u}_theory" / "elevenlabs_script.txt").exists()

    for u in range(4, 8):
        assert (base_day / f"ue_{u}_practice" / "instructions.md").exists()
        assert (base_day / f"ue_{u}_practice" / "boilerplate" / "main.py").exists()
        assert (base_day / f"ue_{u}_practice" / "solution" / "main.py").exists()

    assert (base_day / "ue_8_assessment" / "quiz.json").exists()


def test_course_factory_orchestrator_e2e(tmp_path):
    from src.course_factory.orchestrator import CourseFactoryOrchestrator

    out_dir = str(tmp_path / "course_output_e2e")
    orch = CourseFactoryOrchestrator(base_output_dir=out_dir, force_mock=True)

    result = orch.run(
        course_title="KI-gestützte Softwareentwicklung",
        target_audience="Backend Entwickler",
        max_days=1,
    )

    assert result["success"] is True
    assert result["stats"]["total_days"] == 1
    assert result["stats"]["total_ues"] == 8

    # 1. Master Curriculum in Root
    assert (tmp_path / "course_output_e2e" / "master_curriculum.json").exists()

    # 2. Day Plan in Day Dir
    assert (tmp_path / "course_output_e2e" / "week_1" / "day_1" / "day_1_plan.json").exists()

    # 3. Micro Artifacts in Day Dir
    day_1_dir = tmp_path / "course_output_e2e" / "week_1" / "day_1"
    assert (day_1_dir / "ue_1_theory" / "slides.json").exists()
    assert (day_1_dir / "ue_1_theory" / "elevenlabs_script.txt").exists()
    assert (day_1_dir / "ue_4_practice" / "instructions.md").exists()
    assert (day_1_dir / "ue_4_practice" / "boilerplate" / "main.py").exists()
    assert (day_1_dir / "ue_4_practice" / "solution" / "main.py").exists()
    assert (day_1_dir / "ue_8_assessment" / "quiz.json").exists()


def test_orchestrator_checkpoint_and_resume(tmp_path):
    from src.course_factory.orchestrator import CourseFactoryOrchestrator

    out_dir = str(tmp_path / "course_output_resume")
    orch = CourseFactoryOrchestrator(base_output_dir=out_dir, force_mock=True)

    # 1. First run: only 1 day
    res1 = orch.run(
        course_title="KI-Entwicklung",
        max_days=1,
    )
    assert res1["stats"]["generated_ues"] == 8
    assert res1["stats"]["skipped_ues"] == 0

    # Verify progress.json exists
    prog_file = tmp_path / "course_output_resume" / "progress.json"
    assert prog_file.exists()
    with open(prog_file, "r", encoding="utf-8") as f:
        prog_data = json.load(f)
    assert prog_data["status"] == "completed"

    # 2. Second run: 2 days (Day 1 must be skipped via checkpoint!)
    orch2 = CourseFactoryOrchestrator(base_output_dir=out_dir, force_mock=True)
    res2 = orch2.run(
        course_title="KI-Entwicklung",
        max_days=2,
    )
    assert res2["stats"]["skipped_ues"] == 8  # Day 1 skipped
    assert res2["stats"]["generated_ues"] == 8  # Day 2 generated
    assert res2["stats"]["total_ues"] == 16


def test_orchestrator_fine_grained_progress_and_logs(tmp_path):
    from src.course_factory.orchestrator import CourseFactoryOrchestrator

    out_dir = str(tmp_path / "course_output_logs")
    orch = CourseFactoryOrchestrator(base_output_dir=out_dir, force_mock=True)

    result = orch.run(
        course_title="KI-Entwicklung mit LLM-Agenten",
        max_days=1,
    )
    assert result["success"] is True

    prog_file = tmp_path / "course_output_logs" / "progress.json"
    assert prog_file.exists()

    with open(prog_file, "r", encoding="utf-8") as f:
        data = json.load(f)

    assert data["status"] == "completed"
    assert data["total_ues"] == 8
    assert data["completed_ues"] == 8
    assert data["percent"] == 100.0
    assert len(data["recent_logs"]) > 5

    # Verify log structure
    first_log = data["recent_logs"][0]
    assert "time" in first_log
    assert "message" in first_log
    assert "week" in first_log
    assert "day" in first_log


def test_orchestrator_pause_and_exact_resume(tmp_path):
    from src.course_factory.orchestrator import CourseFactoryOrchestrator

    out_dir = str(tmp_path / "course_output_pause_resume")
    orch1 = CourseFactoryOrchestrator(base_output_dir=out_dir, force_mock=True)

    # First simulate requesting a stop immediately
    orch1.request_stop()
    assert orch1.is_stop_requested() is True

    # Run orch1 - it should pause immediately at Day 1
    res1 = orch1.run(
        course_title="KI-Entwicklung",
        max_days=2,
    )
    assert res1["paused"] is True
    assert res1["stats"]["total_days"] == 0

    prog_file = tmp_path / "course_output_pause_resume" / "progress.json"
    assert prog_file.exists()
    with open(prog_file, "r", encoding="utf-8") as f:
        paused_data = json.load(f)

    assert paused_data["status"] == "paused"
    assert paused_data["stop_requested"] is False
    assert paused_data["paused_at"] is not None

    # Now run orchestrator 2 (Resume) without stopping - should complete 1 day
    orch2 = CourseFactoryOrchestrator(base_output_dir=out_dir, force_mock=True)
    res2 = orch2.run(
        course_title="KI-Entwicklung",
        max_days=1,
    )
    assert res2["paused"] is False
    assert res2["stats"]["generated_ues"] == 8

    # Now run orchestrator 3 for 2 days - Day 1 should be completely skipped, Day 2 generated
    orch3 = CourseFactoryOrchestrator(base_output_dir=out_dir, force_mock=True)
    res3 = orch3.run(
        course_title="KI-Entwicklung",
        max_days=2,
    )
    assert res3["stats"]["skipped_ues"] == 8
    assert res3["stats"]["generated_ues"] == 8


def test_macro_generator_variable_durations():
    from src.course_factory.macro_generator import create_mock_master_curriculum

    # 1. Test 1 Tag (Test-Modus): exactly 1 day -> 8 UEs
    c_1d = create_mock_master_curriculum("Test", "Devs", total_weeks=1, total_days=1)
    assert c_1d.total_weeks == 1
    assert len(c_1d.weeks) == 1
    assert len(c_1d.weeks[0].days) == 1
    assert c_1d.weeks[0].days[0].day_number == 1

    # 2. Test 1 Woche: 5 days -> 40 UEs
    c_1w = create_mock_master_curriculum("Test", "Devs", total_weeks=1)
    assert c_1w.total_weeks == 1
    assert len(c_1w.weeks[0].days) == 5

    # 3. Test 2 Wochen: 10 days -> 80 UEs
    c_2w = create_mock_master_curriculum("Test", "Devs", total_weeks=2)
    assert c_2w.total_weeks == 2
    assert sum(len(w.days) for w in c_2w.weeks) == 10

    # 4. Test 4 Wochen (1 Monat): 20 days -> 160 UEs
    c_4w = create_mock_master_curriculum("Test", "Devs", total_weeks=4)
    assert c_4w.total_weeks == 4
    assert sum(len(w.days) for w in c_4w.weeks) == 20

    # 5. Test 6 Wochen: 30 days -> 240 UEs
    c_6w = create_mock_master_curriculum("Test", "Devs", total_weeks=6)
    assert c_6w.total_weeks == 6
    assert sum(len(w.days) for w in c_6w.weeks) == 30

    # 6. Test 8 Wochen (2 Monate): 40 days -> 320 UEs
    c_8w = create_mock_master_curriculum("Test", "Devs", total_weeks=8)
    assert c_8w.total_weeks == 8
    assert sum(len(w.days) for w in c_8w.weeks) == 40


def test_orchestrator_1_day_test_mode(tmp_path):
    from src.course_factory.orchestrator import CourseFactoryOrchestrator

    out_dir = str(tmp_path / "course_output_1day")
    orch = CourseFactoryOrchestrator(base_output_dir=out_dir, force_mock=True)

    result = orch.run(
        course_title="1-Tages Testkurs",
        max_days=1,
    )
    assert result["success"] is True
    assert result["stats"]["total_days"] == 1
    assert result["stats"]["total_ues"] == 8
    assert result["stats"]["generated_ues"] == 8

    # Verify progress file
    prog_file = tmp_path / "course_output_1day" / "progress.json"
    with open(prog_file, "r", encoding="utf-8") as f:
        data = json.load(f)

    assert data["total_ues"] == 8
    assert data["completed_ues"] == 8
    assert data["percent"] == 100.0


def test_llm_client_provider_switching(monkeypatch):
    import os
    from src.course_factory.llm_client import get_configured_llm_client

    # 1. Test GLM provider
    monkeypatch.setenv("LLM_PROVIDER", "glm")
    client, model, is_mock, provider = get_configured_llm_client()
    assert provider == "glm"
    assert "api.z.ai" in str(client.base_url)
    assert model == "glm-5.3"

    # 2. Test Gemini provider
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    client, model, is_mock, provider = get_configured_llm_client()
    assert provider == "gemini"
    assert "openrouter.ai" in str(client.base_url)
    assert model == "google/gemini-2.5-pro"


def test_orchestrator_llm_provider_arg(tmp_path):
    from src.course_factory.orchestrator import CourseFactoryOrchestrator

    out_dir = str(tmp_path / "course_output_glm")
    orch = CourseFactoryOrchestrator(
        base_output_dir=out_dir,
        force_mock=True,
        llm_provider="glm",
    )
    result = orch.run(course_title="GLM Kurs", max_days=1)
    assert result["success"] is True

    prog_file = tmp_path / "course_output_glm" / "progress.json"
    with open(prog_file, "r", encoding="utf-8") as f:
        data = json.load(f)

    assert data["llm_provider"] == "glm"
    assert data["llm_model"] == "glm-5.3"


def test_quiz_schema_rejects_non_10_questions():
    from pydantic import ValidationError

    def make_questions(n):
        return [
            QuizQuestionItem(
                question_id=i,
                question_text=f"Frage {i}",
                options=QuizOptions(A="A", B="B", C="C", D="D"),
                correct_option="A",
                explanation="Erklärung",
            )
            for i in range(1, n + 1)
        ]

    # 3 questions -> should raise ValidationError
    with pytest.raises(ValidationError):
        QuizSchema(
            ue_title="Quiz Test",
            quiz_title="Test",
            questions=make_questions(3),
        )

    # 11 questions -> should raise ValidationError
    with pytest.raises(ValidationError):
        QuizSchema(
            ue_title="Quiz Test",
            quiz_title="Test",
            questions=make_questions(11),
        )


def test_unit_breakdown_validation_error_on_sum_not_8():
    from pydantic import ValidationError

    # Sum is 2 + 2 + 2 = 6 != 8 -> should raise ValidationError
    with pytest.raises(ValidationError):
        UnitBreakdown(theory_ue=2, practice_ue=2, assessment_ue=2)

    # Sum is 4 + 4 + 2 = 10 != 8 -> should raise ValidationError
    with pytest.raises(ValidationError):
        UnitBreakdown(theory_ue=4, practice_ue=4, assessment_ue=2)

    # Valid sum: 2 + 4 + 2 = 8
    valid = UnitBreakdown(theory_ue=2, practice_ue=4, assessment_ue=2)
    assert valid.theory_ue + valid.practice_ue + valid.assessment_ue == 8


def test_unit_plan_validates_type_agent_alignment():
    from pydantic import ValidationError

    # theory with coding_exercise_agent -> mismatch!
    with pytest.raises(ValidationError):
        UnitPlan(
            ue_number=1,
            ue_title="Intro",
            ue_type="theory",
            target_agent="coding_exercise_agent",
            learning_objective="Obj",
            content_outline=["Outline"],
        )

    # Valid theory with video_script_agent
    plan = UnitPlan(
        ue_number=1,
        ue_title="Intro",
        ue_type="theory",
        target_agent="video_script_agent",
        learning_objective="Obj",
        content_outline=["Outline"],
    )
    assert plan.target_agent == "video_script_agent"


def test_slide_layout_type_literal_validation():
    from pydantic import ValidationError

    # Invalid layout type
    with pytest.raises(ValidationError):
        Slide(
            slide_number=1,
            layout_type="Invalid_Layout_Name",
            visual_description="Desc",
            on_slide_text=SlideOnSlideText(heading="Title"),
            elevenlabs_script="Script",
        )

    # Valid layout type
    slide = Slide(
        slide_number=1,
        layout_type="Diagram",
        visual_description="Mermaid diagram",
        on_slide_text=SlideOnSlideText(heading="Title"),
        elevenlabs_script="Script",
    )
    assert slide.layout_type == "Diagram"


def test_verify_ue_artifacts_rejects_empty_boilerplate(tmp_path):
    import os
    from src.course_factory.file_builder import CourseFileBuilder

    builder = CourseFileBuilder(base_output_dir=str(tmp_path))
    ue_dir = builder.ensure_ue_dir(1, 1, 1, "practice")

    # Create empty boilerplate and empty solution dirs
    bp_dir = os.path.join(ue_dir, "boilerplate")
    sol_dir = os.path.join(ue_dir, "solution")
    os.makedirs(bp_dir, exist_ok=True)
    os.makedirs(sol_dir, exist_ok=True)
    with open(os.path.join(ue_dir, "instructions.md"), "w", encoding="utf-8") as f:
        f.write("# Instructions")
    with open(os.path.join(ue_dir, "validation_criteria.json"), "w", encoding="utf-8") as f:
        f.write("[]")

    # boilerplate is empty -> verification must report boilerplate = False
    verif = builder.verify_ue_artifacts(1, 1, 1, "practice", "coding_exercise_agent")
    assert verif["boilerplate"] is False
    assert verif["solution"] is False

    # Now add non-empty files
    with open(os.path.join(bp_dir, "main.py"), "w", encoding="utf-8") as f:
        f.write("print('hello')")
    with open(os.path.join(sol_dir, "main.py"), "w", encoding="utf-8") as f:
        f.write("print('solution')")

    verif2 = builder.verify_ue_artifacts(1, 1, 1, "practice", "coding_exercise_agent")
    assert verif2["boilerplate"] is True
    assert verif2["solution"] is True


def test_switchboard_raises_on_failed_verification(tmp_path):
    from src.course_factory.switchboard import Switchboard
    from src.course_factory.file_builder import CourseFileBuilder

    builder = CourseFileBuilder(base_output_dir=str(tmp_path))
    sb = Switchboard(file_builder=builder)

    unit = UnitPlan(
        ue_number=1,
        ue_title="Intro",
        ue_type="practice",
        target_agent="coding_exercise_agent",
        learning_objective="Obj",
        content_outline=["Outline"],
    )

    # If verification fails, route_single_unit must raise RuntimeError
    # We simulate this by monkeypatching verify_ue_artifacts to return False
    builder.verify_ue_artifacts = lambda *args, **kwargs: {"instructions.md": False}

    with pytest.raises(RuntimeError) as exc_info:
        sb.route_unit(
            unit=unit,
            course_title="Test Course",
            week_num=1,
            day_num=1,
            force_mock=True,
        )
    assert "Artifact verification failed" in str(exc_info.value)


def test_live_llm_fails_without_mock_fallback(monkeypatch):
    from unittest.mock import MagicMock
    from src.course_factory.llm_client import call_structured_llm

    # Fake OpenAI client that always fails with APIConnectionError or generic Exception
    fake_client = MagicMock()
    fake_client.chat.completions.create.side_effect = ConnectionError("LLM API unreachable")

    # get_configured_llm_client returns fake_client, is_mock=False
    monkeypatch.setattr(
        "src.course_factory.llm_client.get_configured_llm_client",
        lambda: (fake_client, "gpt-4", False, "openai"),
    )

    mock_obj = VideoScriptSchema(
        ue_title="Fallback Title",
        estimated_video_duration_minutes=10,
        slides=_sample_slides(3),
    )

    # In live mode (is_mock=False), it must NOT return mock_obj on network error, but raise
    with pytest.raises(Exception) as exc_info:
        call_structured_llm(
            prompt="Prompt",
            system_prompt="System",
            response_schema=VideoScriptSchema,
            mock_fallback=mock_obj,
            max_retries=1,
        )
    assert "LLM API unreachable" in str(exc_info.value) or "Failed to obtain valid" in str(exc_info.value)


def test_orchestrator_max_days_1_duration_targeting(tmp_path):
    from src.course_factory.orchestrator import CourseFactoryOrchestrator

    out_dir = str(tmp_path / "course_output_1day")
    orch = CourseFactoryOrchestrator(
        base_output_dir=out_dir,
        force_mock=True,
    )
    result = orch.run(course_title="1-Tages-Crashkurs", max_days=1)
    assert result["success"] is True
    assert result["stats"]["total_days"] == 1
    assert result["stats"]["total_ues"] == 8

    # Verify master_curriculum has 1 week and 1 day
    with open(tmp_path / "course_output_1day" / "master_curriculum.json", "r", encoding="utf-8") as f:
        curriculum = json.load(f)
    assert curriculum["total_weeks"] == 1
    assert len(curriculum["weeks"]) == 1
    assert len(curriculum["weeks"][0]["days"]) == 1


def test_coding_artifacts_path_traversal_prevention(tmp_path):
    from src.course_factory.agents.coding_exercise_agent import save_coding_artifacts
    from src.course_factory.schemas import CodingExerciseSchema, ExerciseFile

    exercise = CodingExerciseSchema(
        ue_title="Unit 1",
        exercise_title="Test Path Traversal",
        learning_objective="Security test",
        difficulty_level="Beginner",
        student_instructions_md="# Exercise",
        files=[
            ExerciseFile(
                filename="../../escaped.py",
                boilerplate_code="# Boilerplate",
                solution_code="# Solution",
            )
        ],
        validation_criteria=["Criterion 1"],
    )

    out_dir = str(tmp_path / "exercise_out")
    with pytest.raises(ValueError) as exc:
        save_coding_artifacts(exercise, out_dir)
    assert "Path traversal detected" in str(exc.value) or "escapes target directory" in str(exc.value)


def test_verify_ue_artifacts_detects_corrupted_json(tmp_path):
    import os
    from src.course_factory.file_builder import CourseFileBuilder

    builder = CourseFileBuilder(base_output_dir=str(tmp_path / "output"))
    ue_dir = builder.ensure_ue_dir(week_num=1, day_num=1, ue_num=1, ue_type="assessment")

    # Write truncated/corrupted JSON
    quiz_file = os.path.join(ue_dir, "quiz.json")
    with open(quiz_file, "w", encoding="utf-8") as f:
        f.write("{")

    res = builder.verify_ue_artifacts(week_num=1, day_num=1, ue_num=1, ue_type="assessment", target_agent="quiz_agent")
    assert res["quiz.json"] is False


def test_day_plan_schema_rejects_duplicate_ue_numbers():
    from src.course_factory.schemas import DayPlanSchema, UnitPlan

    units = [
        UnitPlan(
            ue_number=1,
            ue_title=f"Unit {i}",
            ue_type="theory",
            target_agent="video_script_agent",
            duration_minutes=45,
            learning_objective="Objective",
            content_outline=["Topic 1"],
        )
        for i in range(1, 9)
    ]
    # Make duplicate ue_number
    units[1].ue_number = 1

    with pytest.raises(ValueError) as exc:
        DayPlanSchema(day_number=1, day_theme="Test Theme", units=units)
    assert "Unit numbers in day plan must be unique" in str(exc.value)

