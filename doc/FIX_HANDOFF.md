# Handoff: Fehlerbehebung nach Code Review

> **Für:** Coding-Agent / andere KI  
> **Repo:** `D:\AntiGravitySoftware\GitWorkspace\elearning`  
> **Kontext:** Vollständiges Review liegt in  
> `C:\Users\tnickel\.cursor\projects\d-AntiGravitySoftware-GitWorkspace-elearning\canvases\code-review.canvas.tsx`  
> und in der Chat-Analyse (Sep 2026).  
> **Docs zum Abgleich:** `doc/konzept.md`, `doc/BENUTZERHANDBUCH.md`

## Auftrag

Behebe die unten gelisteten Fehler **in der angegebenen Prioritätsreihenfolge**.  
Arbeite präzise, ohne Scope-Creep: keine neuen Features, kein Refactor „nebenbei“, keine unnötigen Doc-Rewrites außer wo Ports/Claims falsch sind (P2).

Nach jeder Prioritätsstufe: relevante Tests laufen lassen bzw. ergänzen.

---

## Regeln für dich

1. Lies zuerst die genannten Dateien, bevor du änderst.
2. Keine Secrets committen; keine echten API-Keys in Code schreiben.
3. Bestehende Patterns beibehalten (Express + Drizzle, FastAPI, Pydantic Factory).
4. Commits nur wenn der User das explizit verlangt.
5. Nach Fixes kurz melden: was geändert, welche Tests grün, was bewusst offen blieb.

---

## P0 — Sicherheit (zuerst)

### P0.1 Login härten
**Datei:** `src/server/app.ts` (`POST /api/auth/login`, ca. Z. 51–93)

**Problem:** Kein Passwort. Client sendet `role` + `tenantId`; bestehende User werden auf beliebige Rolle upgraded.

**Soll:**
- Demo-Modus klar trennen ODER Passwort-/Seed-Login.
- Mindestens: Rolle und Tenant **nicht** vom Client übernehmen für bestehende User; neue User nur aus Whitelist/Seed erlauben.
- Optional kurzfristig: Login nur gegen bekannte Demo-Accounts aus DB (email match), Rolle aus DB, nicht aus Request.

### P0.2 User-Liste absichern
**Datei:** `src/server/app.ts` (`GET /api/auth/users`, ca. Z. 96–103)

**Soll:** Endpoint hinter `authenticateToken` + Admin-Check, oder entfernen und Frontend Quick-Login auf feste Demo-Liste umstellen (`public/js/app.js`).

### P0.3 Course-Factory-API absichern
**Datei:** `src/server/app.ts` (ab ca. Z. 2293)

**Unprotected heute:**
- `GET /api/course-factory/overview`
- `GET /api/course-factory/day`
- `GET /api/course-factory/ue`
- `GET /api/course-factory/progress`
- `POST /api/course-factory/start-generation`
- `POST /api/course-factory/stop-generation`

**Soll:** Alle hinter `authenticateToken` + Admin-Rolle. Import ist bereits auth — gleiches Muster.

### P0.4 Path-Traversal verhindern
**Dateien:** `src/server/app.ts`

Stellen:
- Prompt-IDs: `path.join(PROMPTS_DIR, \`${id}.json\`)` — `id` sanitizen (`^[a-z0-9_-]+$`), resolve + Root-Check.
- Course-factory `week`/`day` Query-Params: nur Integers / `week_N`/`day_N`, resolve unter `COURSE_OUTPUT_DIR`.
- Slide `imageUrl`: nur unter `public/`, kein `..`.

### P0.5 Host-Header „localhost“-Admin-Bypass entfernen
**Datei:** `src/server/app.ts` (`adminOrLocalAuth`, ca. Z. 1691–1708)

**Soll:** Kein Auth-Bypass über `Host`-Header. Lokal nur über JWT/Admin oder explizites Env-Flag `ALLOW_LOCAL_ADMIN=true` **und** Loopback-IP aus Socket, nicht aus Header.

### P0.6 AI-Service absichern
**Datei:** `src/ai_service/main.py` (uvicorn `0.0.0.0:8085`)

**Soll:**
- Default bind `127.0.0.1` ODER Shared-Secret-Header prüfen (z. B. `X-AI-Service-Key` aus `.env`).
- Port mit `.env` / Docs angleichen (siehe P2.1): entweder überall 8085 oder überall 8000.

### P0.7 Secrets
**Dateien:** `src/server/auth.ts`, `.env.example`, `app.ts` `writeEnvFile`

**Soll:** Keine starken Default-Secrets in Produktionspfad. `.env.example` mit Platzhaltern; App startet mit Warnung wenn Default-JWT.

---

## P1 — Content-Qualität / echte Bugs

### P1.1 Kein stiller Mock-Fallback im Live-Modus
**Datei:** `src/course_factory/llm_client.py` (ca. Z. 190–205)

**Problem:** Nach Retries wird `mock_fallback` zurückgegeben → Fake-Kurs sieht „fertig“ aus.

**Soll:**
- Live/Provider-Modus: Exception werfen (oder strukturierter Fehler), **kein** Mock.
- Mock nur wenn `LLM_PROVIDER=mock` / explizites Offline-Flag.
- Optional: Progress mit `status: "failed"` / `degraded` schreiben.

### P1.2 Schema-Regeln erzwingen (Prompt ↔ Code)
**Datei:** `src/course_factory/schemas.py`

| Regel | Fix |
|-------|-----|
| Quiz exakt 10 Fragen | `questions: min_length=10, max_length=10` |
| `theory_ue + practice_ue + assessment_ue == 8` | Validator wirklich `raise` statt `pass` |
| `layout_type` Enum | `Literal["Title_Slide","Code_Snippet","Diagram","Icon_Grid","Comparison"]` |
| Meso: `ue_type` ↔ `target_agent` | Model-Validator auf `UnitPlan` / `DayPlanSchema` |
| Day-Number Clash | Macro `DayOverview.day_number` und `DayPlanSchema.day_number` angleichen (beide ≤365 oder beide ≤40 konsistent zu `max_days`) |

### P1.3 JSON-Schema in Factory-Prompts injizieren
**Dateien:** `src/course_factory/llm_client.py`, Generatoren/Agents

**Soll:** Bei `call_structured_llm` den `response_schema.model_json_schema()` in System- oder User-Message anhängen (kurz + klar), analog zu Instructor im `ai_service`.

### P1.4 Checkpoint-Verification härten
**Datei:** `src/course_factory/file_builder.py` `verify_ue_artifacts`

**Soll für coding_exercise:**
- `instructions.md` existiert und non-empty
- `boilerplate/` und `solution/` enthalten mindestens eine non-empty Datei
- optional `exercise.json` prüfen
- Switchboard soll bei fehlgeschlagenem Verify **nicht** als Success weiterlaufen (`switchboard.py`)

### P1.5 Tutor-SQL Join-Reihenfolge
**Datei:** `src/server/app.ts` (ca. Z. 1479–1495)

**Problem:** `.where(eq(modules.courseId, …))` steht **vor** `.innerJoin(modules, …)`.

**Soll:** Joins in korrekter Reihenfolge: embeddings → lessons → modules, dann where inkl. `modules.courseId`.

### P1.6 Embedding-Dimensionen
**Datei:** `src/ai_service/main.py` (Padding 384→1536)

**Soll:** Kein Zero-Padding. Vector-Dimension an tatsächliches Modell anpassen (DB-Schema/`vector(n)` + Embedding-Output konsistent). Wenn DB 1536 braucht: Modell mit 1536 nutzen oder Migration auf 384.

### P1.7 Zeiterfassung absichern (Minimal)
**Dateien:** `src/server/timeTracking.ts`, `app.ts` Heartbeat

**Soll:**
- `durationSec` cappen (z. B. max Interval + Toleranz, z. B. ≤ 60)
- Session an User binden (kein fremdes `sessionId` beschreiben)
- Leere Session bei Verify nicht als uneingeschränkt „valid: true“ für Audits verkaufen (klar kennzeichnen)

### P1.8 Corrupt day-plan Resume
**Datei:** `src/course_factory/orchestrator.py`

**Soll:** Meso-Reload wie Macro in try/except; bei corrupt JSON neu generieren oder fail mit klarem Status — nicht crashen.

### P1.9 Duration-Targeting CLI
**Datei:** `src/course_factory/orchestrator.py`

**Problem:** `--days 1` allein erzeugt 8-Wochen-Master und verarbeitet 1 Tag.

**Soll:** `max_days==1` → kompaktes 1-Tages-Curriculum (wie UI `durationPreset: '1day'` mit weeks+days).

---

## P2 — Prompts & Dokumentation

### P2.1 Ports / URLs angleichen
**Dateien:** `doc/BENUTZERHANDBUCH.md`, `.env.example`, `start.bat`, `src/ai_service/main.py`, `AI_SERVICE_URL`

Einheitlich dokumentieren und konfigurieren (Vorschlag: Server **3010**, AI **8085** — oder alles auf 8000/3000, aber **eine** Wahrheit).

### P2.2 Studio-Prompts anreichern
**Dateien:** `config/prompts/curriculum_generation.json`, `lesson_generation.json`

**Soll:** Explizite Output-Felder / Didaktik-Hinweise (Module, Lessons, Teleprompter, Markdown, Quiz-Shape), analog Factory-Prompts. Instructor hilft, aber Prompt soll nicht leer sein.

### P2.3 `slide_narration` Brace-Escape
**Datei:** `config/prompts/slide_narration.json`

**Problem:** System-Prompt enthält `{"speaker_notes":...}` → `str.format_map` bricht; Prompt-Manager schluckt Fehler.

**Soll:** Doppelte Klammern `{{` / `}}` für Literal-JSON, damit Variablen weiter substituieren.

### P2.4 Video-Prompt Dauer/Folien
**Datei:** `config/prompts/video_script.json`

**Soll:** Entweder Folienzahl realistisch erhöhen (z. B. 8–12) **oder** klar formulieren „Kurzvideo 10–15 Min innerhalb der 45-Min-UE“. Schema ggf. `min_length`/`max_length` anpassen.

### P2.5 Handbuch-Claims korrigieren
**Datei:** `doc/BENUTZERHANDBUCH.md`

Korrigieren:
- „Produktionsreif“ → „lokale Demo / Preview“ solange Auth offen war
- Heartbeat 30s → tatsächliches Interval (oder Code auf 30s)
- Praxis-Terminal/Code-Sandbox: als „geplant“ markieren oder Feature bauen (nicht bauen außer User will es)
- Import ≠ automatisch freigeschaltet für Schüler
- API-Key-Fallback-Pfad `D:/git/MQL/...` entfernen oder dokumentieren als Dev-only und entfernen aus `src/ai_service/config.py`

### P2.6 Hardcoded Machine-Pfade entfernen
**Dateien:** `src/ai_service/config.py` (`_read_external_mql_key`), `src/server/pptxRender.ts` (MiKTeX-User-Pfad)

Nur Env-Variablen / relative Defaults.

---

## Tests

**Vorhanden:**
- `tests/test_course_factory.py`
- `tests/test_prompt_manager.py`
- `tests/backend.test.ts`

**Ergänzen (mind.):**
1. QuizSchema akzeptiert nicht 3 Fragen.
2. UnitBreakdown Summe ≠ 8 → ValidationError.
3. `verify_ue_artifacts` False bei leerem boilerplate.
4. Live-LLM-Pfad ohne Mock-Fallback (Unit mit Fake failing API).
5. Auth: course-factory ohne Token → 401.
6. Tutor-Query Join läuft (Integration oder Query-Build-Smoke).

**Hinweis:** `test_prompt_manager.py` mutiert echte Prompt-Dateien — auf Temp-Dir umstellen, damit Crashes keine Repo-Prompts ruinieren.

---

## Explizit NICHT tun (ohne Rückfrage)

- Kein neues Auth-Produkt (OIDC/Keycloak) von Null, wenn Minimal-Härtung reicht.
- Kein HeyGen/Avatar-Full-Pipeline.
- Kein Student Code-Sandbox UI (außer User fordert es).
- Kein Force-Push, kein `.env` mit echten Keys committen.
- Keine großen UI-Redesigns.

---

## Akzeptanzkriterien

- [ ] Unauthentifizierte Clients können Course Factory nicht starten und keine UE-Lösungen lesen
- [ ] Login kann keine beliebige Admin-Rolle erzwingen
- [ ] Fehlgeschlagene LLM-Calls erzeugen keinen „erfolgreichen“ Mock-Kurs im Live-Modus
- [ ] Ungültige Quiz-/UE-Breakdown-Outputs scheitern an Pydantic
- [ ] Leere Coding-Ordner zählen nicht als fertig
- [ ] Tutor-RAG-Query wirft keinen SQL-Fehler wegen Join-Reihenfolge
- [ ] Ports in Docs und Code stimmen überein
- [ ] Bestehende Happy-Path-Tests weiterhin grün + neue Regressionstests für P1

---

## Einstiegsreihenfolge (konkret)

1. `src/server/app.ts` — Auth + Factory-Routen + Path-Sanitizing  
2. `src/ai_service/main.py` + `config.py` — Bind/Auth + Key-Fallback raus  
3. `src/course_factory/llm_client.py` + `schemas.py` + `file_builder.py` + `switchboard.py`  
4. Tutor-Join + Embeddings  
5. Prompts + Handbuch Ports/Claims  
6. Tests ergänzen und ausführen

Wenn etwas unklar ist: Prefer fail-closed (ablehnen/fehler) statt silent success.
