import pytest
import shutil
from pathlib import Path
import src.course_factory.prompt_manager as pm

@pytest.fixture(autouse=True)
def isolate_prompts_dir(tmp_path, monkeypatch):
    """Isolate PROMPTS_DIR in a temporary directory for each test so repo files are never touched."""
    temp_prompts_dir = tmp_path / "prompts"
    temp_prompts_dir.mkdir(parents=True, exist_ok=True)
    
    # Pre-populate temp directory with repo prompts if they exist, or let ensure_prompts_directory create them
    if pm.PROMPTS_DIR.exists():
        for f in pm.PROMPTS_DIR.glob("*.json"):
            shutil.copy(f, temp_prompts_dir / f.name)
            
    monkeypatch.setattr(pm, "PROMPTS_DIR", temp_prompts_dir)
    return temp_prompts_dir

def test_list_all_prompts():
    prompts = pm.list_all_prompts()
    assert len(prompts) >= 8
    ids = [p["id"] for p in prompts]
    assert "macro_curriculum" in ids
    assert "meso_day_plan" in ids
    assert "video_script" in ids
    assert "coding_exercise" in ids
    assert "quiz" in ids
    assert "curriculum_generation" in ids
    assert "lesson_generation" in ids
    assert "slide_narration" in ids

def test_load_prompt_definition():
    prompt = pm.load_prompt_definition("macro_curriculum")
    assert prompt["id"] == "macro_curriculum"
    assert "variables" in prompt
    assert len(prompt["variables"]) > 0
    assert "system_prompt" in prompt
    assert "user_prompt" in prompt

def test_render_prompt_safe_dict():
    sys_rendered, usr_rendered = pm.get_prompt(
        "macro_curriculum",
        course_title="Test Kurs",
        target_audience="Entwickler",
        duration_desc="1 Woche",
    )
    assert "Test Kurs" in usr_rendered
    assert "Entwickler" in usr_rendered
    assert "1 Woche" in sys_rendered or "1 Woche" in usr_rendered

def test_slide_narration_prompt_double_braces_escape():
    """Verify that literal JSON braces in slide_narration do not break format_map."""
    sys_rendered, usr_rendered = pm.get_prompt(
        "slide_narration",
        course_topic="Python Webentwicklung",
        position="Folie 1 von 5",
        slide_title="Einführung",
        bullets_txt="• Punkt 1\n• Punkt 2",
    )
    # The formatted system prompt should contain literal json without crash
    assert '{"speaker_notes":"...","summary":"..."}' in sys_rendered
    assert "Python Webentwicklung" in usr_rendered
    assert "Folie 1 von 5" in usr_rendered

def test_save_and_reset_prompt():
    original = pm.load_prompt_definition("quiz")
    orig_sys = original["system_prompt"]
    
    # Save custom
    modified = pm.save_prompt("quiz", system_prompt="CUSTOM SYSTEM PROMPT TEST 123", user_prompt=original["user_prompt"])
    assert modified["system_prompt"] == "CUSTOM SYSTEM PROMPT TEST 123"
    assert modified["is_customized"] is True
    
    # Verify persistence in temp dir
    reloaded = pm.load_prompt_definition("quiz")
    assert reloaded["system_prompt"] == "CUSTOM SYSTEM PROMPT TEST 123"
    
    # Reset back to default
    restored = pm.reset_prompt_to_default("quiz")
    assert restored["system_prompt"] == restored["default_system_prompt"]
    assert restored["is_customized"] is False
