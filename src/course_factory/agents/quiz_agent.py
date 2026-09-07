"""Quiz Agent for Course Factory (Micro Generation).

Generates:
- quiz.json: 10 structured multiple-choice questions with 4 options (A-D),
  the correct option indicator, and didactic explanations.
"""

import json
import os
from typing import List, Optional
from ..schemas import (
    QuizSchema,
    QuizQuestionItem,
    QuizOptions,
)
from ..llm_client import call_structured_llm


def create_mock_quiz(ue_title: str, learning_objective: str, content_outline: List[str]) -> QuizSchema:
    """Generates a realistic mock QuizSchema with 10 questions for testing or offline mode."""
    questions = []
    topics = [
        ("Architektur & Komponenten", "Welche Komponente nimmt Anfragen im Gateway entgegen?", "A", "Das Gateway ist der zentrale Einstiegspunkt."),
        ("Fehlerbehandlung & Timeouts", "Was passiert bei einem unbehandelten Netzwerk-Timeout?", "B", "Unbehandelte Timeouts blockieren Ressourcen, weshalb Circuit Breaker nötig sind."),
        ("Pydantic & Validierung", "Welche Methode validiert ein Dictionary gegen ein Pydantic Model?", "C", "model_validate() parst und validiert strukturierte Daten in Pydantic v2."),
        ("Datenkonsistenz", "Wie wird Datenkonsistenz in verteilten Agenten sichergestellt?", "A", "Idempotente Operationen und Sagas garantieren Konsistenz ohne globale Locks."),
        ("Retry-Strategien", "Welches Backoff-Verfahren verhindert Server-Überlastung bei Retries?", "D", "Exponentielles Backoff mit Jitter verteilt die Retry-Last gleichmäßig."),
        ("Mermaid Diagramme", "Welcher Diagramm-Typ eignet sich am besten für Statusübergänge?", "B", "State Diagrams bilden Zustände und Transitionen eindeutig ab."),
        ("Sicherheit & Tokens", "Wo sollten sensible API-Keys niemals hinterlegt werden?", "C", "API-Keys dürfen niemals im Frontend-Code oder Git-Repository committet werden."),
        ("Testabdeckung", "Welcher Test prüft das Zusammenspiel mehrerer Micro-Services?", "A", "Integrationstests validieren die Kommunikation über Service-Grenzen hinweg."),
        ("Asynchrone Workflows", "Was ist der Hauptvorteil von Orchestratoren wie Temporal?", "D", "Durable Execution stellt sicher, dass Workflows nach Abstürzen exakt dort fortfahren."),
        ("Best Practices", "Warum sollten LLM-Outputs immer streng typisiert werden?", "B", "Strikte Typisierung verhindert unbemerkte Formatbrüche und Injection-Fehler."),
    ]

    for q_id, (sub_theme, q_text, corr, expl) in enumerate(topics, start=1):
        questions.append(
            QuizQuestionItem(
                question_id=q_id,
                question_text=f"{q_text} ({sub_theme})",
                options=QuizOptions(
                    A="Antwort A: Primäre Option und etablierter Standard",
                    B="Antwort B: Alternative Option für spezifische Sonderfälle",
                    C="Antwort C: Oft gewähltes, aber problematisches Anti-Pattern",
                    D="Antwort D: Veralteter Ansatz aus früheren Versionen",
                ),
                correct_option=corr,  # type: ignore
                explanation=f"{expl} Die anderen Antwortmöglichkeiten sind gängige Missverständnisse oder unvollständig.",
            )
        )

    return QuizSchema(
        ue_title=ue_title,
        quiz_title=f"Wissensüberprüfung: {ue_title}",
        questions=questions,
    )


def save_quiz_artifacts(quiz: QuizSchema, output_dir: str):
    """Saves quiz.json into the specified output directory."""
    os.makedirs(output_dir, exist_ok=True)
    quiz_path = os.path.join(output_dir, "quiz.json")
    with open(quiz_path, "w", encoding="utf-8") as f:
        json.dump(quiz.model_dump(), f, indent=2, ensure_ascii=False)
    print(f"[Quiz Agent] Artifacts saved to: {output_dir}")


def generate_quiz(
    course_title: str,
    ue_title: str,
    learning_objective: str,
    content_outline: List[str],
    output_dir: Optional[str] = None,
    force_mock: bool = False,
) -> QuizSchema:
    """Generates 10 multiple-choice questions for an assessment unit."""
    from ..prompt_manager import get_prompt

    outline_str = "\n".join(f"- {pt}" for pt in content_outline)
    system_prompt, user_prompt = get_prompt(
        "quiz",
        course_title=course_title,
        ue_title=ue_title,
        learning_objective=learning_objective,
        content_outline_formatted=outline_str,
    )

    mock_fallback = create_mock_quiz(ue_title, learning_objective, content_outline)

    quiz = call_structured_llm(
        prompt=user_prompt,
        system_prompt=system_prompt,
        response_schema=QuizSchema,
        mock_fallback=mock_fallback,
        force_mock=force_mock,
    )

    if output_dir:
        save_quiz_artifacts(quiz, output_dir)

    return quiz
