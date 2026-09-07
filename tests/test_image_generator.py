import os
import pytest
from PIL import Image
from src.course_factory.schemas import VideoScriptSchema, Slide, SlideOnSlideText, ImageCue
from src.course_factory.image_generator import (
    create_mock_cue_image,
    resize_and_save_image,
    format_web_image_url,
    generate_slide_images,
    generate_single_cue_image,
    get_image_api_key,
    call_openrouter_image_api,
)


def test_mock_cue_image_dimensions(tmp_path):
    """Verifies that mock cue image has exact 512x256 resolution and valid PNG format."""
    out_file = str(tmp_path / "images" / "slide_1_cue_0.png")
    create_mock_cue_image(
        output_path=out_file,
        slide_num=1,
        cue_ts=0,
        prompt="Fotorealistischer Kleisterauftrag auf Tapetenbahn",
        target_size=(512, 256),
    )
    assert os.path.exists(out_file)
    with Image.open(out_file) as img:
        assert img.size == (512, 256)
        assert img.format == "PNG"


def test_strict_api_key_check_in_live_mode(tmp_path):
    """Verifies strict failure if no API key is provided in live mode (no silent fallback)."""
    cue = ImageCue(
        timestamp_percent=0,
        prompt="Fotorealistische Aufnahme von Tapetenkleister und Quast",
        transition="fade",
    )
    with pytest.raises(RuntimeError, match="Kein gültiger OPENROUTER_API_KEY"):
        generate_single_cue_image(
            cue=cue,
            slide_num=1,
            visual_style="Fotorealistisch",
            output_dir=str(tmp_path),
            force_mock=False,
            api_key="",  # Missing key
            model="google/gemini-2.5-flash-image",
            target_size=(512, 256),
        )


def test_web_url_formatting():
    """Verifies format_web_image_url normalizes path to /course_output/..."""
    p1 = "D:/AntiGravitySoftware/GitWorkspace/elearning/course_output/week_1/day_1/ue_1/images/slide_1_cue_0.png"
    assert format_web_image_url(p1) == "/course_output/week_1/day_1/ue_1/images/slide_1_cue_0.png"
    
    p2 = "C:\\projects\\elearning\\course_output\\week_2\\day_3\\ue_1\\images\\slide_2_cue_35.png"
    assert format_web_image_url(p2) == "/course_output/week_2/day_3/ue_1/images/slide_2_cue_35.png"


def test_resize_and_save_image(tmp_path):
    """Verifies PIL resizes arbitrary source image to target 512x256."""
    from io import BytesIO
    src_img = Image.new("RGB", (1024, 768), color=(255, 100, 50))
    buf = BytesIO()
    src_img.save(buf, format="PNG")
    raw_bytes = buf.getvalue()

    out_file = str(tmp_path / "resized.png")
    resize_and_save_image(raw_bytes, out_file, target_size=(512, 256))
    
    with Image.open(out_file) as img:
        assert img.size == (512, 256)


def test_generate_slide_images_mock_pipeline(tmp_path):
    """Verifies that generate_slide_images generates placeholders for all cues and updates slides.json."""
    script = VideoScriptSchema(
        ue_title="Einführung in Kleister und Klebetechnik",
        estimated_video_duration_minutes=10,
        visual_style="Fotorealistisch, warme Töne, Werkstatt-Setting",
        slides=[
            Slide(
                slide_number=1,
                layout_type="Illustrated",
                visual_description="Titelfolie mit Werkstatt-Impressionen",
                on_slide_text=SlideOnSlideText(
                    heading="Klebetechnik Grundlagen",
                    bullet_points_or_code=["Kleisterarten", "Werkzeuge", "Verarbeitung"],
                ),
                elevenlabs_script="Willkommen zur Lerneinheit über Klebetechnik im Handwerk...",
                image_cues=[
                    ImageCue(
                        timestamp_percent=0,
                        prompt="Professionelle Nahaufnahme verschiedener Kleistersorten in Eimern",
                        transition="fade",
                    ),
                    ImageCue(
                        timestamp_percent=50,
                        prompt="Handwerker rührt Tapetenkleister klumpenfrei in einem Eimer an",
                        transition="slide_left",
                    ),
                ],
            ),
            Slide(
                slide_number=2,
                layout_type="Illustrated",
                visual_description="Vergleich der Kleisterarten",
                on_slide_text=SlideOnSlideText(
                    heading="Tapeten- vs. Holzleim",
                    bullet_points_or_code=["Viskosität", "Trocknungszeit"],
                ),
                elevenlabs_script="Schauen wir uns nun die Unterschiede zwischen Tapetenkleister und Holzleim an...",
                image_cues=[
                    ImageCue(
                        timestamp_percent=0,
                        prompt="Vergleich: Links transparenter Tapetenkleister, rechts weißer Holzleim",
                        transition="fade",
                    ),
                ],
            ),
            Slide(
                slide_number=3,
                layout_type="Illustrated",
                visual_description="Zusammenfassung und Arbeitssicherheit",
                on_slide_text=SlideOnSlideText(
                    heading="Sicherheitshinweise",
                    bullet_points_or_code=["Schutzbrille", "Lüftung"],
                ),
                elevenlabs_script="Achte bei der Verarbeitung stets auf gute Raumbelüftung und Hautschutz...",
                image_cues=[
                    ImageCue(
                        timestamp_percent=0,
                        prompt="Geordnete Schutzausrüstung mit Handschuhen und Schutzbrille in Werkstatt",
                        transition="fade",
                    ),
                ],
            ),
        ],
    )

    out_dir = str(tmp_path / "course_output" / "week_1" / "day_1" / "ue_1_theory")
    os.makedirs(out_dir, exist_ok=True)

    progress_log = []
    updated_script = generate_slide_images(
        video_script=script,
        output_dir=out_dir,
        force_mock=True,
        on_progress=lambda msg: progress_log.append(msg),
    )

    # 4 total cues across 3 slides
    assert len(progress_log) >= 4
    for s in updated_script.slides:
        assert s.image_cues is not None
        for cue in s.image_cues:
            assert cue.image_url is not None
            assert cue.image_url.startswith("/course_output/")
            assert cue.image_url.endswith(".png")
            # Verify file exists on disk
            rel_from_course_output = cue.image_url.replace("/course_output/", "")
            full_path = os.path.join(tmp_path, "course_output", rel_from_course_output.lstrip("/\\"))
            assert os.path.exists(full_path)
            with Image.open(full_path) as img:
                assert img.size == (512, 256)

    # Verify slides.json on disk contains the populated image_url fields
    import json
    slides_json_path = os.path.join(out_dir, "slides.json")
    assert os.path.exists(slides_json_path)
    with open(slides_json_path, "r", encoding="utf-8") as f:
        saved_data = json.load(f)
    assert saved_data["slides"][0]["image_cues"][0]["image_url"].startswith("/course_output/")


def test_live_openrouter_single_image_if_key_available(tmp_path):
    """Live smoke-test using OpenRouter API key if present in environment."""
    api_key = get_image_api_key()
    if not api_key or api_key.startswith("mock"):
        pytest.skip("No real OpenRouter API key available for live image test.")

    cue = ImageCue(
        timestamp_percent=0,
        prompt="Fotorealistischer Farbeimer mit Pinsel auf einer Holzwerkbank, warmes Studiolicht, keine Beschriftung",
        transition="fade",
    )
    out_dir = str(tmp_path / "live_test")
    web_url = generate_single_cue_image(
        cue=cue,
        slide_num=1,
        visual_style="Fotorealistisch",
        output_dir=out_dir,
        force_mock=False,
        api_key=api_key,
        model="google/gemini-2.5-flash-image",
        target_size=(512, 256),
    )
    assert web_url.endswith("slide_1_cue_0.png")
    local_path = os.path.join(out_dir, "images", "slide_1_cue_0.png")
    assert os.path.exists(local_path)
    with Image.open(local_path) as img:
        assert img.size == (512, 256)
