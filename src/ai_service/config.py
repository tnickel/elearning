import os
from pathlib import Path
from dotenv import load_dotenv

def reload_config():
    # Load dotenv from project root where .env is stored
    env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), '.env')
    if os.path.exists(env_path):
        load_dotenv(dotenv_path=env_path, override=True)
    else:
        load_dotenv(override=True)

def get_llm_provider() -> str:
    reload_config()
    provider = os.getenv("LLM_PROVIDER", "glm").strip().lower()
    if provider in ["glm", "zhipu", "zai"]:
        return "glm"
    if provider in ["gemini", "openrouter", "google"]:
        return "gemini"
    if provider == "vllm":
        return "vllm"
    return provider

def get_embedding_provider() -> str:
    reload_config()
    return os.getenv("EMBEDDING_PROVIDER", "local").strip().lower()

def get_glm_api_key() -> str:
    reload_config()
    return os.getenv("GLM_API_KEY") or os.getenv("ZHIPU_API_KEY") or ""

def get_zhipu_api_key() -> str:
    return get_glm_api_key()

def get_glm_base_url() -> str:
    reload_config()
    # Coding Plan Abo-Endpunkt als Standard (wie im MqlKiScanner ermittelt)
    url = os.getenv("GLM_BASE_URL") or os.getenv("ZHIPU_BASE_URL", "https://api.z.ai/api/coding/paas/v4/")
    if not url.endswith("/"):
        url += "/"
    return url

def get_zhipu_base_url() -> str:
    return get_glm_base_url()

def get_glm_model() -> str:
    reload_config()
    return os.getenv("GLM_MODEL") or os.getenv("ZHIPU_MODEL", "glm-5.3")

def get_zhipu_model() -> str:
    return get_glm_model()

def get_glm_vision_model() -> str:
    reload_config()
    return os.getenv("GLM_VISION_MODEL") or os.getenv("ZHIPU_VISION_MODEL", "glm-5.3-flash")

def get_zhipu_vision_model() -> str:
    return get_glm_vision_model()

def get_zhipu_embedding_model() -> str:
    reload_config()
    return os.getenv("ZHIPU_EMBEDDING_MODEL") or os.getenv("GLM_EMBEDDING_MODEL", "embedding-3")

def get_openrouter_api_key() -> str:
    reload_config()
    return os.getenv("OPENROUTER_API_KEY", "")

def get_openrouter_model() -> str:
    reload_config()
    return os.getenv("OPENROUTER_MODEL", "google/gemini-2.5-pro")

def get_vllm_base_url() -> str:
    reload_config()
    return os.getenv("VLLM_BASE_URL", "http://localhost:8000/v1")

def get_vllm_model() -> str:
    reload_config()
    return os.getenv("VLLM_MODEL", "meta-llama/Meta-Llama-3-8B-Instruct")
