"""File System Builder for Course Factory.

Enforces strict directory structure:
/course_output/
  └── week_{n}/
      └── day_{n}/
          ├── day_{n}_plan.json
          └── ue_{n}_{type}/
              ├── (agent-specific generated files)
"""

import json
import os
from typing import Dict, List, Optional


class CourseFileBuilder:
    """Manages paths and creation of the strict Course Factory directory tree."""

    def __init__(self, base_output_dir: str = "course_output"):
        self.base_output_dir = os.path.abspath(base_output_dir)

    def get_week_dir(self, week_num: int) -> str:
        """Returns path to week directory: course_output/week_{n}"""
        return os.path.join(self.base_output_dir, f"week_{week_num}")

    def get_day_dir(self, week_num: int, day_num: int) -> str:
        """Returns path to day directory: course_output/week_{n}/day_{n}"""
        return os.path.join(self.get_week_dir(week_num), f"day_{day_num}")

    def get_ue_dir(self, week_num: int, day_num: int, ue_num: int, ue_type: str) -> str:
        """Returns path to unit directory: course_output/week_{n}/day_{n}/ue_{n}_{type}"""
        clean_type = ue_type.lower().strip()
        dir_name = f"ue_{ue_num}_{clean_type}"
        return os.path.join(self.get_day_dir(week_num, day_num), dir_name)

    def ensure_ue_dir(self, week_num: int, day_num: int, ue_num: int, ue_type: str) -> str:
        """Ensures that the UE directory exists on disk and returns its absolute path."""
        path = self.get_ue_dir(week_num, day_num, ue_num, ue_type)
        os.makedirs(path, exist_ok=True)
        return path

    def verify_ue_artifacts(self, week_num: int, day_num: int, ue_num: int, ue_type: str, target_agent: str) -> Dict[str, bool]:
        """Checks whether the expected files for this UE and agent exist, are non-empty, and contain valid JSON."""
        ue_dir = self.get_ue_dir(week_num, day_num, ue_num, ue_type)
        results = {}

        def is_non_empty_file(file_path: str) -> bool:
            return os.path.isfile(file_path) and os.path.getsize(file_path) > 0

        def is_valid_json_file(file_path: str) -> bool:
            if not is_non_empty_file(file_path):
                return False
            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    json.load(f)
                return True
            except Exception:
                return False

        def dir_contains_non_empty_files(dir_path: str) -> bool:
            if not os.path.isdir(dir_path):
                return False
            for entry in os.listdir(dir_path):
                full_p = os.path.join(dir_path, entry)
                if os.path.isfile(full_p) and os.path.getsize(full_p) > 0:
                    return True
            return False

        if target_agent == "video_script_agent":
            results["slides.json"] = is_valid_json_file(os.path.join(ue_dir, "slides.json"))
            results["elevenlabs_script.txt"] = is_non_empty_file(os.path.join(ue_dir, "elevenlabs_script.txt"))
        elif target_agent == "coding_exercise_agent":
            results["instructions.md"] = is_non_empty_file(os.path.join(ue_dir, "instructions.md"))
            results["boilerplate"] = dir_contains_non_empty_files(os.path.join(ue_dir, "boilerplate"))
            results["solution"] = dir_contains_non_empty_files(os.path.join(ue_dir, "solution"))
            results["validation_criteria.json"] = is_valid_json_file(os.path.join(ue_dir, "validation_criteria.json"))
        elif target_agent == "quiz_agent":
            results["quiz.json"] = is_valid_json_file(os.path.join(ue_dir, "quiz.json"))

        return results
