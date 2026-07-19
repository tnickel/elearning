from openai import OpenAI
import os
import instructor
from pydantic import BaseModel, Field
from typing import List
from dotenv import load_dotenv

load_dotenv()
key = os.getenv("OPENROUTER_API_KEY")

class LessonSchema(BaseModel):
    title: str = Field(..., description="Titel der Lektion")
    description: str = Field(..., description="Kurzbeschreibung")

class ModuleSchema(BaseModel):
    title: str = Field(..., description="Titel des Moduls")
    lessons: List[LessonSchema] = Field(..., description="Lektionen")

class CurriculumSchema(BaseModel):
    course_title: str
    course_description: str
    modules: List[ModuleSchema]

client = instructor.from_openai(
    OpenAI(base_url="https://openrouter.ai/api/v1", api_key=key),
    mode=instructor.Mode.MD_JSON
)

try:
    response = client.chat.completions.create(
        model="google/gemini-2.5-pro",
        response_model=CurriculumSchema,
        messages=[
            {"role": "user", "content": "Erstelle einen Lehrplan für Docker."}
        ]
    )
    print("Success! Title:", response.course_title)
    print("Modules count:", len(response.modules))
    for m in response.modules:
        print("- Module:", m.title)
except Exception as e:
    print("Error:", e)
