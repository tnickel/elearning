from openai import OpenAI
import os
from dotenv import load_dotenv

load_dotenv()
key = os.getenv("OPENROUTER_API_KEY")
print("Key:", key)

client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=key
)

try:
    response = client.chat.completions.create(
        model="google/gemini-2.5-pro",
        messages=[
            {"role": "user", "content": "Hello, write one word."}
        ]
    )
    print("Response:", response.choices[0].message.content)
except Exception as e:
    print("Error:", e)
