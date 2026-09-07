"""Course Factory Multi-Agent System Package."""

from .schemas import (
    MasterCurriculumSchema,
    DayPlanSchema,
    VideoScriptSchema,
    CodingExerciseSchema,
    QuizSchema,
    ImageCue,
    Slide,
)
from .macro_generator import generate_macro_curriculum
from .meso_generator import generate_day_plan
from .switchboard import Switchboard
from .file_builder import CourseFileBuilder
from .image_generator import generate_slide_images

__version__ = "1.0.0"

def __getattr__(name: str):
    if name == "CourseFactoryOrchestrator":
        from .orchestrator import CourseFactoryOrchestrator
        return CourseFactoryOrchestrator
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

__all__ = [
    "CourseFactoryOrchestrator",
    "MasterCurriculumSchema",
    "DayPlanSchema",
    "VideoScriptSchema",
    "CodingExerciseSchema",
    "QuizSchema",
    "ImageCue",
    "Slide",
    "generate_macro_curriculum",
    "generate_day_plan",
    "generate_slide_images",
    "Switchboard",
    "CourseFileBuilder",
]
