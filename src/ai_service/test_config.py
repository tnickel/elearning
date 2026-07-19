import os
import config

env_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '.env'))
print("Expected env path:", env_path)
print("File exists:", os.path.exists(env_path))
print("Key from config:", config.get_openrouter_api_key())
