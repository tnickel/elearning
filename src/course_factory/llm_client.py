"""Self-Healing LLM Client for Course Factory Multi-Agent System.

Handles:
- OpenAI-compatible provider connection (OpenRouter, Zhipu/Z.ai, vLLM, Mock).
- Strict JSON parsing (robust extraction from markdown code fences or raw JSON).
- Self-Healing Retry Loop: On malformed JSON or Pydantic ValidationError, catches
  the error, formats feedback to the LLM, and requests corrected JSON.
- Exponential backoff for network/rate-limit errors.
"""

import json
import re
import sys
import os
import time
from typing import Type, TypeVar, Optional, List, Dict, Any
from pydantic import BaseModel, ValidationError

# Add src/ai_service to sys.path so config can be imported directly
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_src = os.path.dirname(current_dir)
ai_service_path = os.path.join(parent_src, "ai_service")
if ai_service_path not in sys.path:
    sys.path.insert(0, ai_service_path)

try:
    import config
except ImportError:
    config = None

T = TypeVar("T", bound=BaseModel)


def extract_json_string(text: str) -> str:
    """Extracts valid JSON string from raw LLM output, handling markdown blocks."""
    text = text.strip()
    # 1. Check for markdown code blocks ```json ... ``` or ``` ... ```
    match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    if match:
        return match.group(1).strip()

    # 2. Look for outermost JSON object { ... } or array [ ... ]
    first_brace = text.find("{")
    last_brace = text.rfind("}")
    if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
        return text[first_brace : last_brace + 1].strip()

    first_bracket = text.find("[")
    last_bracket = text.rfind("]")
    if first_bracket != -1 and last_bracket != -1 and last_bracket > first_bracket:
        return text[first_bracket : last_bracket + 1].strip()

    return text


def get_configured_llm_client():
    """Returns an initialized OpenAI client, model name, is_mock, and provider label based on environment."""
    from openai import OpenAI
    import httpx

    raw_provider = os.getenv("LLM_PROVIDER", "")
    if not raw_provider and config is not None:
        raw_provider = config.get_llm_provider()
    provider = (raw_provider or "glm").strip().lower()

    if provider in ["glm", "zhipu", "zai"]:
        provider_name = "glm"
        if config is not None:
            base_url = config.get_glm_base_url()
            api_key = config.get_glm_api_key()
            model_name = config.get_glm_model()
        else:
            base_url = os.getenv("GLM_BASE_URL") or os.getenv("ZHIPU_BASE_URL", "https://api.z.ai/api/coding/paas/v4/")
            api_key = os.getenv("GLM_API_KEY") or os.getenv("ZHIPU_API_KEY", "")
            model_name = os.getenv("GLM_MODEL") or os.getenv("ZHIPU_MODEL", "glm-5.3")
    elif provider == "vllm":
        provider_name = "vllm"
        if config is not None:
            base_url = config.get_vllm_base_url()
            api_key = "token"
            model_name = config.get_vllm_model()
        else:
            base_url = os.getenv("VLLM_BASE_URL", "http://localhost:8000/v1")
            api_key = "token"
            model_name = os.getenv("VLLM_MODEL", "meta-llama/Meta-Llama-3-8B-Instruct")
    else:  # gemini / openrouter
        provider_name = "gemini"
        if config is not None:
            base_url = "https://openrouter.ai/api/v1"
            api_key = config.get_openrouter_api_key()
            model_name = config.get_openrouter_model()
        else:
            base_url = "https://openrouter.ai/api/v1"
            api_key = os.getenv("OPENROUTER_API_KEY", "")
            model_name = os.getenv("OPENROUTER_MODEL", "google/gemini-2.5-pro")

    is_mock = not api_key or api_key in ["mock-openrouter-key", "mock-zhipu-key", "mock-glm-key"]
    # We pass http_client=httpx.Client() to avoid httpx 0.28+ keyword argument 'proxies' incompatibility in older openai
    http_client = httpx.Client()
    client = OpenAI(base_url=base_url, api_key=api_key or "mock-key", http_client=http_client)
    return client, model_name, is_mock, provider_name


def call_structured_llm(
    prompt: str,
    system_prompt: str,
    response_schema: Type[T],
    mock_fallback: Optional[T] = None,
    max_retries: int = 3,
    force_mock: bool = False,
) -> T:
    """Calls the LLM with self-healing retry logic.

    If the LLM returns invalid JSON or violates the Pydantic schema:
    1. The error is caught.
    2. A correction message is appended to the conversation context.
    3. The LLM is re-invoked with the correction prompt up to max_retries.
    """
    if force_mock:
        if mock_fallback is not None:
            print(f"[LLM Client] Running in FORCED MOCK mode for schema: {response_schema.__name__}")
            return mock_fallback
        raise RuntimeError(f"force_mock=True but no mock_fallback provided for {response_schema.__name__}.")

    llm_res = get_configured_llm_client()
    if len(llm_res) == 4:
        client, model_name, is_mock, provider_name = llm_res
    else:
        client, model_name, is_mock = llm_res[:3]
        provider_name = "llm"

    if is_mock:
        if mock_fallback is not None:
            print(f"[LLM Client] Running in MOCK mode for schema: {response_schema.__name__} (provider: {provider_name})")
            return mock_fallback
        raise RuntimeError(
            f"No API key provided and no mock_fallback provided for {response_schema.__name__} (provider: {provider_name})."
        )

    # P1.3: Append Pydantic model JSON schema to system prompt for explicit schema grounding
    try:
        schema_json = json.dumps(response_schema.model_json_schema(), indent=2, ensure_ascii=False)
        effective_system_prompt = (
            f"{system_prompt.strip()}\n\n"
            f"VERBINDLICHES JSON-SCHEMA (Antworte AUSSCHLIESSLICH als valides JSON-Objekt gemäß dieser Struktur):\n"
            f"```json\n{schema_json}\n```"
        )
    except Exception:
        effective_system_prompt = system_prompt

    # Initial conversation history
    messages: List[Dict[str, str]] = [
        {"role": "system", "content": effective_system_prompt},
        {"role": "user", "content": prompt},
    ]

    last_raw_response = ""
    last_error_detail = ""

    for attempt in range(1, max_retries + 1):
        try:
            print(
                f"[LLM Client] Requesting {response_schema.__name__} (Attempt {attempt}/{max_retries}) using [{provider_name.upper()}] {model_name}..."
            )
            response = client.chat.completions.create(
                model=model_name,
                messages=messages,
                response_format={"type": "json_object"},
                temperature=0.3,
            )

            last_raw_response = response.choices[0].message.content or ""
            cleaned_json_str = extract_json_string(last_raw_response)

            # Step 1: Parse JSON syntax
            parsed_dict = json.loads(cleaned_json_str)

            # Step 2: Validate against Pydantic schema
            validated_obj = response_schema.model_validate(parsed_dict)
            print(f"[LLM Client] Validation successful for {response_schema.__name__}.")
            return validated_obj

        except (json.JSONDecodeError, ValidationError) as parse_err:
            last_error_detail = str(parse_err)
            print(
                f"[LLM Self-Healing] Attempt {attempt}/{max_retries} failed for {response_schema.__name__}: {last_error_detail}"
            )

            if attempt < max_retries:
                # Add assistant reply and user correction prompt into history
                messages.append({"role": "assistant", "content": last_raw_response})
                correction_prompt = (
                    f"FEHLER: Deine vorherige Antwort enthielt ungültiges JSON oder verletzte das Schema:\n"
                    f"Fehlermeldung: {last_error_detail}\n\n"
                    f"Bitte korrigiere den Fehler und antworte AUSSCHLIESSLICH mit dem korrigierten, validen JSON-Objekt gemäß der vorgegebenen Struktur. Kein Begleittext!"
                )
                messages.append({"role": "user", "content": correction_prompt})
                time.sleep(1.5 * attempt)
            else:
                print(f"[LLM Self-Healing] Max retries reached for {response_schema.__name__}.")
                # P1.1: Live mode must NEVER silently fallback to mock!
                raise RuntimeError(
                    f"Failed to obtain valid {response_schema.__name__} after {max_retries} attempts: {last_error_detail}"
                )

        except Exception as api_err:
            print(f"[LLM Client] API / Network Error on attempt {attempt}: {api_err}")
            if attempt < max_retries:
                time.sleep(2.0 * attempt)
            else:
                # P1.1: Live mode must fail cleanly with the actual network error
                print(f"[LLM Client] Network failed after {max_retries} attempts.")
                raise api_err

    raise RuntimeError(f"Unexpected termination in call_structured_llm for {response_schema.__name__}")
