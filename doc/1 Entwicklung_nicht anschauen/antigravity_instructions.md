# Antigravity Task: Course Factory Orchestrator Completion

## 1. Context & North Star Architecture
We are building a "Course Factory" (Multi-Agent System) that fully automates the generation of a 320-Unit (UE) curriculum for an 8-week IT training course. The project already has an existing codebase, but it is incomplete.

Your overarching goal is to complete the orchestrator. The finished system MUST implement a 3-phase pipeline:
1. **Macro Generation:** Send a master prompt to generate an 8-week plan -> output as `master_curriculum.json`.
2. **Meso Generation:** Slice each day into 8 UEs (Units) -> output as `day_{n}_plan.json`. Each UE defines a `target_agent`.
3. **Micro Generation (Switchboard):** Route each UE to the correct agent based on `target_agent`:
   - `video_script_agent` -> generates `slides.json` and `elevenlabs_script.txt`
   - `coding_exercise_agent` -> generates boilerplate, solution, and markdown instructions
   - `quiz_agent` -> generates `quiz.json`

**Crucial System Requirements:**
- Strict JSON validation and parsing for all LLM responses.
- Retry-Logic / Self-Healing: If the LLM returns malformed JSON, catch the error and request a correction from the LLM.
- Output generation must match a strict directory tree: `/course_output/week_{n}/day_{n}/ue_{n}_{type}/`

---

## 2. Your Instructions (Multi-Step Execution)

To prevent context overload and protect the existing codebase, you will execute this task strictly in the following sequential phases. **Do not proceed to the next phase without explicit user approval.**

### PHASE 1: Status Quo Analysis & Gap Identification
1. Analyze the current workspace and read all existing files related to this orchestrator.
2. Identify what is already implemented (e.g., API connections, models, prompts, file structures).
3. Compare the existing codebase against the "North Star Architecture" described in Section 1.
4. Output a detailed **Gap Analysis** in Markdown format. List exactly what is missing, what needs to be refactored, and what is already working.
5. **STOP and ask the user:** "Do you agree with this analysis?"

### PHASE 2: Implementation Plan
1. Once the user approves the Gap Analysis, draft a step-by-step Implementation Plan.
2. Break down the missing features into small, logically separated tasks (e.g., Task 1: JSON Validation Logic, Task 2: Meso-Phase Routing, Task 3: File System Builder).
3. Specify which files you intend to modify or create for each task.
4. **STOP and ask the user:** "Should I proceed with executing Task 1 of the plan?"

### PHASE 3: Iterative Execution
1. Execute the plan exactly ONE task at a time.
2. When writing code, adhere to these rules:
   - **Do not break existing functionality** unless explicitly stated in the plan.
   - Keep the code modular. Separate LLM API calls, routing logic, and file system operations.
   - Ensure the code is robust against API timeouts or rate limits (e.g., exponential backoff).
3. After completing a task, summarize the changes, run any relevant tests or linters if available, and **STOP**. 
4. Ask the user: "Task X is complete. Please review. Should I proceed with Task Y?"