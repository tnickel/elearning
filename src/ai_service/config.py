import os
from dotenv import load_dotenv

# We load dotenv with override=True on each call to reflect runtime updates from start.bat / admin panel.
def reload_config():
    # Load dotenv from parent folder where .env is stored
    env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), '.env')
    if os.path.exists(env_path):
        load_dotenv(dotenv_path=env_path, override=True)
    else:
        load_dotenv(override=True)

def get_llm_provider():
    reload_config()
    return os.getenv("LLM_PROVIDER", "openrouter")

def get_embedding_provider():
    reload_config()
    return os.getenv("EMBEDDING_PROVIDER", "local")

def get_openrouter_api_key():
    reload_config()
    return os.getenv("OPENROUTER_API_KEY", "")

def get_openrouter_model():
    reload_config()
    return os.getenv("OPENROUTER_MODEL", "google/gemini-2.5-pro")

def get_vllm_base_url():
    reload_config()
    return os.getenv("VLLM_BASE_URL", "http://localhost:8000/v1")

def get_vllm_model():
    reload_config()
    return os.getenv("VLLM_MODEL", "meta-llama/Meta-Llama-3-8B-Instruct")
