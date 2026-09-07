"""Master Pipeline Orchestrator for Course Factory (Multi-Agent System).

Coordinates the complete 3-phase generation pipeline with Checkpointing & Resume:
1. Macro Generation: 8-week Master Curriculum -> master_curriculum.json
2. Meso Generation: 40 Days sliced into 8 UEs each -> day_{n}_plan.json
3. Micro Generation: Switchboard routing to Video Script, Coding Exercise & Quiz Agents
   -> Stored in /course_output/week_{n}/day_{n}/ue_{n}_{type}/

Features:
- Checkpointing & Auto-Resume: Automatically detects existing files on disk,
  skips completed UEs, and resumes at the exact unfinished unit.
- Live Progress Tracking: Persists progress and status to 'progress.json'.
- Graceful Stop & Pause: Honors stop_requested signals.
"""

import argparse
import json
import os
import sys
import time
from typing import Optional, Dict, Any

from .schemas import MasterCurriculumSchema, DayPlanSchema
from .macro_generator import generate_macro_curriculum
from .meso_generator import generate_day_plan
from .file_builder import CourseFileBuilder
from .switchboard import Switchboard


class CourseFactoryOrchestrator:
    """End-to-End Multi-Agent Orchestrator with Checkpointing and Live Progress."""

    def __init__(
        self,
        base_output_dir: str = "course_output",
        force_mock: bool = False,
        force_regenerate: bool = False,
        llm_provider: Optional[str] = None,
    ):
        self.base_output_dir = os.path.abspath(base_output_dir)
        self.force_mock = force_mock
        self.force_regenerate = force_regenerate
        self.llm_provider = (llm_provider or os.getenv("LLM_PROVIDER") or "glm").strip().lower()
        os.environ["LLM_PROVIDER"] = self.llm_provider
        self.file_builder = CourseFileBuilder(base_output_dir=self.base_output_dir)
        self.switchboard = Switchboard(file_builder=self.file_builder)
        self.progress_file = os.path.join(self.base_output_dir, "progress.json")

    def get_progress_data(self) -> Dict[str, Any]:
        """Reads current progress from disk or returns default template."""
        if os.path.exists(self.progress_file):
            try:
                with open(self.progress_file, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass

        return {
            "status": "idle",
            "current_phase": "none",
            "current_step": "Bereit zum Start",
            "current_week": 1,
            "current_week_theme": "",
            "current_day": 1,
            "current_day_theme": "",
            "current_ue": 1,
            "current_ue_title": "",
            "current_ue_type": "theory",
            "target_agent": "",
            "agent_action": "",
            "llm_provider": self.llm_provider,
            "llm_model": "glm-5.3" if self.llm_provider in ["glm", "zhipu", "zai"] else "google/gemini-2.5-pro",
            "total_ues": 320,
            "completed_ues": 0,
            "skipped_ues": 0,
            "generated_ues": 0,
            "percent": 0.0,
            "stop_requested": False,
            "paused_at": None,
            "recent_logs": [],
            "updated_at": time.time(),
        }

    def update_progress(self, log_type: str = "info", **kwargs):
        """Atomically updates progress.json on disk with timestamp and rolling log buffer."""
        data = self.get_progress_data()
        data.update(kwargs)
        data["updated_at"] = time.time()

        # Update recent logs history
        step_msg = kwargs.get("agent_action") or kwargs.get("current_step")
        if step_msg:
            logs = data.get("recent_logs", [])
            timestamp_str = time.strftime("%H:%M:%S")
            # Avoid duplicate entries back-to-back
            if not logs or logs[-1].get("message") != step_msg:
                logs.append({
                    "time": timestamp_str,
                    "message": step_msg,
                    "type": log_type,
                    "week": data.get("current_week", 1),
                    "day": data.get("current_day", 1),
                    "ue": data.get("current_ue", 1),
                    "agent": data.get("target_agent", ""),
                })
                data["recent_logs"] = logs[-30:]  # Keep latest 30 log events

        os.makedirs(self.base_output_dir, exist_ok=True)
        temp_path = self.progress_file + ".tmp"
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(temp_path, self.progress_file)

    def is_stop_requested(self) -> bool:
        """Checks if a pause or stop was signaled via progress.json."""
        data = self.get_progress_data()
        return bool(data.get("stop_requested", False))

    def request_stop(self):
        """Signals the running orchestrator to pause after the current unit."""
        self.update_progress(
            stop_requested=True,
            status="stopping",
            current_step="Stop-Signal empfangen. Halte nach aktueller Einheit an...",
            log_type="warning",
        )

    def run(
        self,
        course_title: str,
        target_audience: str = "Softwareentwickler mit grundlegender Programmiererfahrung",
        max_weeks: Optional[int] = None,
        max_days: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Executes the complete Course Factory pipeline with auto-resume."""
        start_time = time.time()
        os.makedirs(self.base_output_dir, exist_ok=True)

        print("=" * 70)
        print("     COURSE FACTORY MULTI-AGENT ORCHESTRATOR (CHECKPOINTING)     ")
        print("=" * 70)
        print(f"Kurs:            {course_title}")
        print(f"Zielgruppe:      {target_audience}")
        print(f"Ausgabe-Pfad:    {self.base_output_dir}")
        print(f"Modus:           {'MOCK (Simuliert)' if self.force_mock else 'LIVE LLM'}")
        print(f"Wiederaufnahme:  {'DEAKTIVIERT (--force-regenerate)' if self.force_regenerate else 'AKTIV (Überspringt fertige Einheiten)'}")
        if max_weeks:
            print(f"Limit:           Max {max_weeks} Wochen")
        if max_days:
            print(f"Limit:           Max {max_days} Tage")
        print("-" * 70)

        if self.is_stop_requested():
            print("\n[Orchestrator] Stop-Signal vor dem Start empfangen. Pausiere sofort...")
            self.update_progress(
                status="paused",
                stop_requested=False,
                current_step="Pipeline vor Beginn pausiert durch Benutzer.",
                log_type="warning",
                paused_at={"week": 1, "day": 1, "ue": 1, "title": "Start"},
            )
            return {
                "success": True,
                "paused": True,
                "stats": {
                    "total_weeks": 0,
                    "total_days": 0,
                    "total_ues": 0,
                    "video_ues": 0,
                    "coding_ues": 0,
                    "quiz_ues": 0,
                    "skipped_ues": 0,
                    "generated_ues": 0,
                },
                "message": "Pipeline vor Beginn pausiert.",
            }

        self.update_progress(
            status="running",
            stop_requested=False,
            current_phase="macro",
            current_step="Initialisiere oder prüfe Makro-Curriculum...",
            log_type="info",
        )

        # Determine duration targets
        if max_days == 1 or (max_days == 1 and max_weeks == 1):
            target_weeks = 1
            target_days = 1
        elif max_weeks and max_days:
            target_weeks = max_weeks
            target_days = max_days
        elif max_weeks:
            target_weeks = max_weeks
            target_days = None
        elif max_days:
            target_weeks = max(1, (max_days + 4) // 5)
            target_days = max_days
        else:
            target_weeks = 8
            target_days = None

        # -------------------------------------------------------------
        # PHASE 1: MACRO GENERATION (CHECKPOINTABLE)
        # -------------------------------------------------------------
        master_path = os.path.join(self.base_output_dir, "master_curriculum.json")
        should_reload = False
        if os.path.exists(master_path) and not self.force_regenerate:
            try:
                with open(master_path, "r", encoding="utf-8") as f:
                    curriculum_dict = json.load(f)
                curriculum = MasterCurriculumSchema.model_validate(curriculum_dict)
                existing_total_days = sum(len(w.days) for w in curriculum.weeks)

                # Check if existing curriculum satisfies requested topic and weeks/days
                title_lower = (curriculum.course_title or "").strip().lower()
                topic_lower = (topic or "").strip().lower()
                # Exact title match (case-insensitive). Fuzzy word overlap caused wrong resumes.
                topic_matches = bool(title_lower) and (
                    title_lower == topic_lower
                    or title_lower == course_title.strip().lower()
                )

                if not topic_matches:
                    print(f"[Checkpoint] Vorhandenes Curriculum '{curriculum.course_title}' passt nicht zu angefordertem Thema '{topic}'. Generiere neu...")
                    should_reload = True
                elif max_days and existing_total_days < max_days:
                    should_reload = True
                elif max_weeks and len(curriculum.weeks) < max_weeks:
                    should_reload = True
                else:
                    print(f"[Checkpoint] master_curriculum.json vorhanden. Lade Curriculum ({len(curriculum.weeks)} Wochen, {existing_total_days} Tage)...")
                    self.update_progress(
                        current_phase="macro",
                        current_step=f"[Checkpoint] Curriculum geladen ({len(curriculum.weeks)} Wochen).",
                        log_type="success",
                    )
            except Exception:
                should_reload = True
        else:
            should_reload = True

        if should_reload:
            duration_info = f"{target_days} Tage" if target_days == 1 else f"{target_weeks} Wochen"
            print(f"\n[PHASE 1] Starte Makro-Generierung ({duration_info})...")
            self.update_progress(
                current_phase="macro",
                current_step=f"Generiere {duration_info}-Curriculum (Makro-Ebene)...",
                log_type="info",
            )
            curriculum = generate_macro_curriculum(
                course_title=course_title,
                target_audience=target_audience,
                total_weeks=target_weeks,
                total_days=target_days,
                output_dir=self.base_output_dir,
                force_mock=self.force_mock,
            )
            print(f"[OK] Makro-Generierung abgeschlossen: {len(curriculum.weeks)} Wochen definiert.")
            self.update_progress(
                current_phase="macro",
                current_step=f"[OK] Makro-Curriculum ({len(curriculum.weeks)} Wochen) erfolgreich generiert.",
                log_type="success",
            )

        # Calculate total UEs for accurate progress percentage
        total_course_ues = 0
        for w in curriculum.weeks:
            if max_weeks and w.week_number > max_weeks:
                continue
            for d in w.days:
                if max_days and d.day_number > max_days:
                    continue
                total_course_ues += 8
        if total_course_ues == 0:
            total_course_ues = 8 if (max_days == 1) else ((max_weeks or 8) * 40)

        stats = {
            "total_weeks": 0,
            "total_days": 0,
            "total_ues": 0,
            "video_ues": 0,
            "coding_ues": 0,
            "quiz_ues": 0,
            "skipped_ues": 0,
            "generated_ues": 0,
        }

        days_processed = 0

        # -------------------------------------------------------------
        # PHASE 2 & 3: MESO & MICRO GENERATION (WITH AUTO-RESUME)
        # -------------------------------------------------------------
        for week in curriculum.weeks:
            if max_weeks is not None and week.week_number > max_weeks:
                print(f"[Orchestrator] Limit max_weeks={max_weeks} erreicht.")
                break

            stats["total_weeks"] += 1
            print(f"\n=======================================================")
            print(f" Woche {week.week_number}: {week.week_theme}")
            print(f"=======================================================")

            for day_overview in week.days:
                if max_days is not None and days_processed >= max_days:
                    print(f"[Orchestrator] Limit max_days={max_days} erreicht.")
                    break

                # Check for stop request before day
                if self.is_stop_requested():
                    print("\n[Orchestrator] Stop-Signal empfangen. Pausiere Pipeline vor Tag", day_overview.day_number)
                    self.update_progress(
                        status="paused",
                        stop_requested=False,
                        current_week=week.week_number,
                        current_week_theme=week.week_theme,
                        current_day=day_overview.day_number,
                        current_day_theme=day_overview.day_theme,
                        current_ue=1,
                        paused_at={
                            "week": week.week_number,
                            "day": day_overview.day_number,
                            "ue": 1,
                            "title": day_overview.day_theme,
                        },
                        current_step=f"Pausiert vor Woche {week.week_number}, Tag {day_overview.day_number}. Beim nächsten Start wird hier fortgesetzt.",
                        log_type="warning",
                    )
                    return {
                        "success": True,
                        "paused": True,
                        "stats": stats,
                        "message": "Pipeline erfolgreich pausiert. Beim nächsten Start wird an gleicher Stelle fortgesetzt.",
                    }

                days_processed += 1
                stats["total_days"] += 1
                day_num = day_overview.day_number
                day_dir = self.file_builder.get_day_dir(week.week_number, day_num)
                day_plan_path = os.path.join(day_dir, f"day_{day_num}_plan.json")

                # Phase 2: Checkpoint Meso Plan
                day_plan = None
                if os.path.exists(day_plan_path) and not self.force_regenerate:
                    try:
                        with open(day_plan_path, "r", encoding="utf-8") as f:
                            day_plan_dict = json.load(f)
                        day_plan = DayPlanSchema.model_validate(day_plan_dict)
                    except Exception as corrupt_err:
                        print(f"[Checkpoint] Beschädigter Tagesplan an Tag {day_num} ({corrupt_err}). Generiere neu...")
                        day_plan = None

                if day_plan is None:
                    print(f"\n[PHASE 2] Slicing Tag {day_num} in 8 UEs...")
                    self.update_progress(
                        current_phase="meso",
                        current_week=week.week_number,
                        current_week_theme=week.week_theme,
                        current_day=day_num,
                        current_day_theme=day_overview.day_theme,
                        current_ue=1,
                        current_step=f"Woche {week.week_number}, Tag {day_num}: Slicing in 8 didaktische UEs...",
                        log_type="info",
                    )
                    day_plan = generate_day_plan(
                        day_overview=day_overview,
                        course_title=course_title,
                        output_dir=day_dir,
                        force_mock=self.force_mock,
                    )
                    print(f"[OK] Tag {day_num} Plan erstellt ({len(day_plan.units)} UEs).")

                # Phase 3: Checkpoint Micro Units
                for unit in day_plan.units:
                    # Check for stop request before each unit
                    if self.is_stop_requested():
                        print(f"\n[Orchestrator] Stop-Signal empfangen. Pausiere vor UE {unit.ue_number} an Tag {day_num}.")
                        self.update_progress(
                            status="paused",
                            stop_requested=False,
                            current_week=week.week_number,
                            current_week_theme=week.week_theme,
                            current_day=day_num,
                            current_day_theme=day_overview.day_theme,
                            current_ue=unit.ue_number,
                            current_ue_title=unit.ue_title,
                            current_ue_type=unit.ue_type,
                            target_agent=unit.target_agent,
                            paused_at={
                                "week": week.week_number,
                                "day": day_num,
                                "ue": unit.ue_number,
                                "title": unit.ue_title,
                            },
                            current_step=f"Pausiert vor Woche {week.week_number}, Tag {day_num}, UE {unit.ue_number} ({unit.ue_title}). Bereit zur Wiederaufnahme.",
                            log_type="warning",
                        )
                        return {
                            "success": True,
                            "paused": True,
                            "stats": stats,
                            "message": "Pipeline erfolgreich pausiert.",
                        }

                    stats["total_ues"] += 1
                    if unit.target_agent == "video_script_agent":
                        stats["video_ues"] += 1
                    elif unit.target_agent == "coding_exercise_agent":
                        stats["coding_ues"] += 1
                    elif unit.target_agent == "quiz_agent":
                        stats["quiz_ues"] += 1

                    # Verify if unit artifacts already exist on disk
                    verification = self.file_builder.verify_ue_artifacts(
                        week_num=week.week_number,
                        day_num=day_num,
                        ue_num=unit.ue_number,
                        ue_type=unit.ue_type,
                        target_agent=unit.target_agent,
                    )

                    all_exist = len(verification) > 0 and all(verification.values())

                    if all_exist and not self.force_regenerate:
                        stats["skipped_ues"] += 1
                        pct = round((stats["total_ues"] / total_course_ues) * 100, 1)
                        self.update_progress(
                            current_phase="micro",
                            current_week=week.week_number,
                            current_week_theme=week.week_theme,
                            current_day=day_num,
                            current_day_theme=day_overview.day_theme,
                            current_ue=unit.ue_number,
                            current_ue_title=unit.ue_title,
                            current_ue_type=unit.ue_type,
                            target_agent=unit.target_agent,
                            agent_action=f"Übersprungen via Checkpoint",
                            completed_ues=stats["total_ues"],
                            skipped_ues=stats["skipped_ues"],
                            generated_ues=stats["generated_ues"],
                            total_ues=total_course_ues,
                            percent=pct,
                            current_step=f"[Checkpoint] UE {unit.ue_number} an Tag {day_num} existiert bereits – übersprungen.",
                            log_type="info",
                        )
                        continue

                    # Generate missing unit with live granular progress
                    pct = round((stats["total_ues"] / total_course_ues) * 100, 1)
                    step_desc = f"Woche {week.week_number}, Tag {day_num}, UE {unit.ue_number} ({unit.target_agent}): {unit.ue_title}"
                    print(f"[{pct}%] {step_desc}...")

                    def on_unit_progress(sub_action: str):
                        self.update_progress(
                            current_phase="micro",
                            current_week=week.week_number,
                            current_week_theme=week.week_theme,
                            current_day=day_num,
                            current_day_theme=day_overview.day_theme,
                            current_ue=unit.ue_number,
                            current_ue_title=unit.ue_title,
                            current_ue_type=unit.ue_type,
                            target_agent=unit.target_agent,
                            agent_action=sub_action,
                            completed_ues=stats["total_ues"],
                            skipped_ues=stats["skipped_ues"],
                            generated_ues=stats["generated_ues"],
                            total_ues=total_course_ues,
                            percent=pct,
                            current_step=sub_action,
                            log_type="info",
                        )

                    on_unit_progress(f"Starte {unit.target_agent} für UE {unit.ue_number}: '{unit.ue_title}'...")

                    self.switchboard.route_unit(
                        unit=unit,
                        course_title=course_title,
                        week_num=week.week_number,
                        day_num=day_num,
                        force_mock=self.force_mock,
                        on_progress=on_unit_progress,
                    )
                    stats["generated_ues"] += 1

                    self.update_progress(
                        current_phase="micro",
                        current_week=week.week_number,
                        current_week_theme=week.week_theme,
                        current_day=day_num,
                        current_day_theme=day_overview.day_theme,
                        current_ue=unit.ue_number,
                        current_ue_title=unit.ue_title,
                        current_ue_type=unit.ue_type,
                        target_agent=unit.target_agent,
                        agent_action=f"UE {unit.ue_number} erfolgreich fertiggestellt",
                        completed_ues=stats["total_ues"],
                        skipped_ues=stats["skipped_ues"],
                        generated_ues=stats["generated_ues"],
                        total_ues=total_course_ues,
                        percent=pct,
                        current_step=f"[OK] Woche {week.week_number}, Tag {day_num}, UE {unit.ue_number} fertiggestellt.",
                        log_type="success",
                    )

            if max_days is not None and days_processed >= max_days:
                break

        elapsed = round(time.time() - start_time, 2)
        pct = 100.0 if (not max_weeks and not max_days) else round((stats["total_ues"] / total_course_ues) * 100, 1)

        self.update_progress(
            status="completed",
            stop_requested=False,
            percent=pct,
            completed_ues=stats["total_ues"],
            skipped_ues=stats["skipped_ues"],
            generated_ues=stats["generated_ues"],
            total_ues=total_course_ues,
            current_step="Kursgenerierung erfolgreich abgeschlossen. Alle Einheiten bereit zur Freigabe.",
            log_type="success",
        )

        print("\n" + "=" * 70)
        print("          COURSE FACTORY PIPELINE ERFOLGREICH BEENDET        ")
        print("=" * 70)
        print(f"Dauer:             {elapsed} Sekunden")
        print(f"Verarbeitete Tage: {stats['total_days']}")
        print(f"Gesamt-UEs:        {stats['total_ues']} UEs à 45 Minuten")
        print(f"  - Neu generiert: {stats['generated_ues']}")
        print(f"  - Übersprungen:  {stats['skipped_ues']} (bereits vorhanden via Checkpoint)")
        print(f"  - Video/Theorie: {stats['video_ues']}")
        print(f"  - Praxis/Code:   {stats['coding_ues']}")
        print(f"  - Assessments:   {stats['quiz_ues']}")
        print(f"Ablage-Verzeichnis:{self.base_output_dir}")
        print("=" * 70)

        return {
            "success": True,
            "paused": False,
            "elapsed_seconds": elapsed,
            "stats": stats,
            "output_dir": self.base_output_dir,
        }


def main():
    parser = argparse.ArgumentParser(description="Course Factory Multi-Agent Orchestrator CLI")
    parser.add_argument("--topic", type=str, default="KI-gestützte Softwareentwicklung und Agenten-Workflows", help="Kursthema")
    parser.add_argument("--audience", type=str, default="Softwareentwickler mit Backend-Erfahrung", help="Zielgruppe")
    parser.add_argument("--output-dir", type=str, default="course_output", help="Basis-Ausgabeverzeichnis")
    parser.add_argument("--weeks", type=int, default=None, help="Gesamtdauer in Wochen (z.B. 1, 2, 4, 6, 8)")
    parser.add_argument("--days", type=int, default=None, help="Gesamtdauer in Tagen (z.B. 1 für 1-Tagestest)")
    parser.add_argument("--max-weeks", type=int, default=None, help="Optionale Begrenzung auf N Wochen")
    parser.add_argument("--max-days", type=int, default=None, help="Optionale Begrenzung auf N Tage")
    parser.add_argument("--mock", action="store_true", help="Erzwinge Mock-Modus für schnellen Offline-Test")
    parser.add_argument("--force-regenerate", action="store_true", help="Überschreibt alle vorhandenen Dateien")
    parser.add_argument("--stop", action="store_true", help="Sendet Stop-Signal an laufende Pipeline")
    parser.add_argument("--llm-provider", type=str, default=None, choices=["glm", "gemini", "openrouter", "zhipu", "vllm"], help="LLM-Provider (glm oder gemini)")

    args = parser.parse_args()

    orchestrator = CourseFactoryOrchestrator(
        base_output_dir=args.output_dir,
        force_mock=args.mock,
        force_regenerate=args.force_regenerate,
        llm_provider=args.llm_provider,
    )

    if args.stop:
        orchestrator.request_stop()
        print("[Orchestrator] Stop-Signal wurde in progress.json gesetzt.")
        return

    weeks = args.weeks or args.max_weeks
    days = args.days or args.max_days

    orchestrator.run(
        course_title=args.topic,
        target_audience=args.audience,
        max_weeks=weeks,
        max_days=days,
    )


if __name__ == "__main__":
    main()
