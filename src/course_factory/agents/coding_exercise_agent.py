"""Coding Exercise Agent for Course Factory (Micro Generation).

Generates:
- instructions.md: Detailed markdown guide for students (Goal, Requirements, Hints).
- boilerplate/: Starter code containing '# TODO' markers for students.
- solution/: Complete, working reference solution.
- validation_criteria.json: Acceptance criteria for tests or peer/tutor reviews.
"""

import json
import os
from typing import List, Optional
from ..schemas import (
    CodingExerciseSchema,
    ExerciseFile,
)
from ..llm_client import call_structured_llm


def create_mock_coding_exercise(ue_title: str, learning_objective: str, content_outline: List[str]) -> CodingExerciseSchema:
    """Generates a realistic mock CodingExerciseSchema for testing or offline mode."""
    boilerplate = '''"""Hands-on Übung: Starter Code."""
import json
from typing import Dict, Any

def process_data(raw_payload: str) -> Dict[str, Any]:
    """Parst den JSON-String und validiert die Pflichtfelder.
    
    # TODO: 1. Parse den JSON-String in ein Python-Dictionary
    # TODO: 2. Stelle sicher, dass die Schlüssel 'id' und 'status' vorhanden sind
    # TODO: 3. Wirf einen ValueError bei ungültigen Daten
    """
    pass

if __name__ == "__main__":
    test_input = '{"id": "task-101", "status": "pending"}'
    result = process_data(test_input)
    print("Ergebnis:", result)
'''

    solution = '''"""Hands-on Übung: Referenz-Musterlösung."""
import json
from typing import Dict, Any

def process_data(raw_payload: str) -> Dict[str, Any]:
    """Parst den JSON-String und validiert die Pflichtfelder."""
    try:
        data = json.loads(raw_payload)
    except json.JSONDecodeError as err:
        raise ValueError(f"Ungültiges JSON-Format: {err}")

    required_keys = ["id", "status"]
    for key in required_keys:
        if key not in data:
            raise ValueError(f"Pflichtfeld '{key}' fehlt im Payload")

    return {
        "id": str(data["id"]),
        "status": str(data["status"]),
        "processed": True,
    }

if __name__ == "__main__":
    test_input = '{"id": "task-101", "status": "pending"}'
    result = process_data(test_input)
    print("Ergebnis:", result)
    assert result["status"] == "pending"
    print("Alle Tests erfolgreich bestanden!")
'''

    instructions = f"""# Praxisübung: {ue_title}

## 🎯 Lernziel
{learning_objective}

## 📋 Aufgabenstellung
In dieser Einheit implementierst du die Kernfunktionalität für die Datenverarbeitung.

### Anforderungen:
1. Öffne die Datei `boilerplate/main.py`.
2. Ergänze die mit `# TODO` markierten Code-Bereiche.
3. Fange fehlerhafte Eingaben robust mit entsprechenden Exceptions ab.
4. Führe das Skript aus und verifiziere, dass keine Fehler auftreten.

## 💡 Tipps
- Nutze das Python-Modul `json`.
- Achte darauf, edge cases wie leere Strings oder fehlende Attribute zu testen.
"""

    return CodingExerciseSchema(
        ue_title=ue_title,
        exercise_title=f"Hands-on: {ue_title}",
        difficulty_level="Intermediate",
        student_instructions_md=instructions,
        files=[
            ExerciseFile(
                filename="main.py",
                boilerplate_code=boilerplate,
                solution_code=solution,
            )
        ],
        validation_criteria=[
            "Funktion 'process_data' parst valides JSON ohne Exception.",
            "Funktion wirft ValueError bei fehlendem 'id' oder 'status'.",
            "Musterlösung läuft ohne Warnungen oder Syntaxfehler durch.",
        ],
    )


def _safe_join(base_dir: str, rel_path: str) -> str:
    """Safely joins rel_path to base_dir, preventing directory traversal and creating subdirs."""
    clean_path = os.path.normpath(rel_path).lstrip(r"\/")
    parts = clean_path.split(os.sep)
    if ".." in parts:
        raise ValueError(f"Path traversal detected in exercise filename: {rel_path}")
    full_path = os.path.abspath(os.path.join(base_dir, clean_path))
    if not full_path.startswith(os.path.abspath(base_dir)):
        raise ValueError(f"Exercise file {rel_path} escapes target directory {base_dir}")
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    return full_path

def save_coding_artifacts(exercise: CodingExerciseSchema, output_dir: str):
    """Saves coding artifacts: instructions.md, boilerplate/, solution/, validation_criteria.json."""
    os.makedirs(output_dir, exist_ok=True)

    # 1. instructions.md
    instructions_path = os.path.join(output_dir, "instructions.md")
    with open(instructions_path, "w", encoding="utf-8") as f:
        f.write(exercise.student_instructions_md)

    # 2. Boilerplate directory
    bp_dir = os.path.join(output_dir, "boilerplate")
    os.makedirs(bp_dir, exist_ok=True)
    for f in exercise.files:
        target_path = _safe_join(bp_dir, f.filename)
        with open(target_path, "w", encoding="utf-8") as file_out:
            file_out.write(f.boilerplate_code)

    # 3. Solution directory
    sol_dir = os.path.join(output_dir, "solution")
    os.makedirs(sol_dir, exist_ok=True)
    for f in exercise.files:
        target_path = _safe_join(sol_dir, f.filename)
        with open(target_path, "w", encoding="utf-8") as file_out:
            file_out.write(f.solution_code)

    # 4. validation_criteria.json
    crit_path = os.path.join(output_dir, "validation_criteria.json")
    with open(crit_path, "w", encoding="utf-8") as f:
        json.dump(exercise.validation_criteria, f, indent=2, ensure_ascii=False)

    # 5. exercise.json (Full metadata)
    ex_json_path = os.path.join(output_dir, "exercise.json")
    with open(ex_json_path, "w", encoding="utf-8") as f:
        json.dump(exercise.model_dump(), f, indent=2, ensure_ascii=False)

    print(f"[Coding Exercise Agent] Artifacts saved to: {output_dir}")


def generate_coding_exercise(
    course_title: str,
    ue_title: str,
    learning_objective: str,
    content_outline: List[str],
    output_dir: Optional[str] = None,
    force_mock: bool = False,
) -> CodingExerciseSchema:
    """Generates a coding exercise with starter boilerplate, solution, and instructions."""
    from ..prompt_manager import get_prompt

    outline_str = "\n".join(f"- {pt}" for pt in content_outline)
    system_prompt, user_prompt = get_prompt(
        "coding_exercise",
        course_title=course_title,
        ue_title=ue_title,
        learning_objective=learning_objective,
        content_outline_formatted=outline_str,
    )

    mock_fallback = create_mock_coding_exercise(ue_title, learning_objective, content_outline)

    exercise = call_structured_llm(
        prompt=user_prompt,
        system_prompt=system_prompt,
        response_schema=CodingExerciseSchema,
        mock_fallback=mock_fallback,
        force_mock=force_mock,
    )

    if output_dir:
        save_coding_artifacts(exercise, output_dir)

    return exercise
