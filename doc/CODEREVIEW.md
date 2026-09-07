# CODE-REVIEW — KI E-Learning & Course Factory Plattform

```yaml
# ---- Metadaten (maschinenlesbar) ----
dokument: CODEREVIEW.md
datum: "2026-09-06"
repository: D:\AntiGravitySoftware\GitWorkspace\elearning
branch: master
commit: 3393214 ("feat: Implement PowerPoint import feature and enhance admin dashboard")
arbeitsstand: "Working Tree MIT uncommitteten Aenderungen (~917 Zeilen geaendert in src/server/app.ts, inkl. P0-Security-Fixes)"
reviewer: "ZCode (KI-Agent), verifiziert per Datei-Lektuere + Test-Ausfuehrung"
tests_beim_review: "23/23 Python-Tests gruen; Backend-Integrationstests gruen (Live-DB)"
sprache: deutsch
zielgruppe: "KI-Agents und Entwickler; alle Befunde mit file:line und Ist-Code belegt"
```

---

## 0. Nutzungshinweise für KI-Agents

1. **Finding-IDs sind stabil und referenzierbar**: `P#` = Prompts, `F#` = Python/Course Factory, `B#` = Node-Backend, `FE#` = Frontend, `X#` = bereits behoben (nicht erneut fixen).
2. **Jedes Finding enthält**: Schweregrad, Datei:Zeile, Ist-Code, Auswirkung, Fix-Empfehlung. Zeilennummern beziehen sich auf den Arbeitsstand vom 2026-09-06; bei Abweichung nach Edits gilt der zitierte Code als Wahrheit, nicht die Zeilennummer.
3. **Verifikationsstatus**: Alle `P/F/B/FE`-Findings wurden im Arbeitsstand per direkter Code-Lektuere verifiziert (die meisten durch den Haupt-Agent Zeile für Zeile; einige FE-Details durch einen spezialisierten Sub-Review mit Cross-Check).
4. **Wichtig**: Die Sektion 7 (X-Findings) listet Probleme auf, die im Arbeitsstand bereits durch `P0.x FIX`-Kommentare behoben wurden. Diese NICHT erneut "entdecken" oder fixen.
5. Abarbeitungsreihenfolge: Sektion 9 (Prioritätenliste) beachten.

### Schweregrad-Skala

| Grad | Bedeutung |
|---|---|
| KRITISCH | Sofort fixen; blockiert jeden Nicht-Demo-Einsatz (Sicherheit, Datenverlust) |
| HOCH | Fixen bevor die Plattform Dritten/Netzwerk ausgesetzt wird |
| MITTEL | Korrektheit/Kosten/Robustheit; geplant fixen |
| NIEDRIG | Kosmetik, Drift, Tothutz |

### Systemkontext (für Agent-Orientation)

- **Dualsystem**: (1) "Studio"-Wizard in `public/index.html` (3 Schritte: Curriculum → Lektionscontent → Medien/Freigabe) für Dozenten; (2) "Course Factory" in `public/inspector.html` (Multi-Agenten-Pipeline, schreibt nach `course_output/`, Import in PostgreSQL).
- **Services**: Node/Express-Backend (`src/server/app.ts`, Port aus `.env` = 3010), Python FastAPI AI-Service (`src/ai_service/main.py`, lauscht bei Direktstart auf `0.0.0.0:8085`), PostgreSQL + pgvector (docker-compose, Host-Port 5439), Temporal (Worker + Workflows, derzeit weitgehend ungenutzt), ElevenLabs/MiniMax TTS, LLM über Z.ai (GLM) oder OpenRouter (Gemini).
- **Course Factory Pipeline**: `orchestrator.py` → Makro (`macro_generator.py`) → Meso pro Tag (`meso_generator.py`) → Mikro via `switchboard.py` an 3 Agenten (`video_script_agent.py`, `coding_exercise_agent.py`, `quiz_agent.py`). Checkpointing über vorhandene Dateien + `course_output/progress.json`.
- **Prompts**: 8 Schablonen in `config/prompts/*.json`, Werkdefault gespiegelt in `src/course_factory/prompt_manager.py` (`DEFAULT_PROMPTS`), editierbar über Admin-UI `/api/admin/prompts*`.
- **Doku**: `doc/konzept.md` (Architektur), `doc/BENUTZERHANDBUCH.md` (Betrieb). Beachte: Doku behauptet u. a. "manipulationssichere SHA-256-Zeiterfassung" und Port 8000/3000 — beides weicht vom Code ab (siehe B10, B7, F7).

---

## 1. Prompt-Review (config/prompts/ + prompt_manager.py)

**Gesamturteil: didaktisch stark und konsistent, aber mit einem konzeptionellen Konstruktionsfehler (P1) und schwacher Schema-Durchsetzung (P3/P4).**

### P1 — JSON-Zielschema wird dem LLM nie mitgeteilt [KRITISCH für Effizienz/Kosten]

- **Datei:** alle Factory-Prompts (`macro_curriculum.json`, `meso_day_plan.json`, `video_script.json`, `coding_exercise.json`, `quiz.json`) + `src/course_factory/llm_client.py:104-170`
- **Problem:** Jeder Systemprompt endet mit *"Antworte AUSSCHLIESSLICH im geforderten JSON-Format"* bzw. *"Generiere das Curriculum vollständig gemäß Schema"* — **aber kein Prompt enthält das Schema**. Die Pydantic-Modelle in `src/course_factory/schemas.py` existieren nur serverseitig zur Validierung. Das Modell muss Feldnamen wie `units_breakdown`, `ue_number`, `target_agent`, `on_slide_text.bullet_points_or_code` erraten.
- **Folge:** Der Erstversuch fast jeder Generierung scheitert an der `ValidationError` und läuft durch den Self-Healing-Retry (`llm_client.py:172-195`) = komplette Neu-Generierung + Korrekturrunde. Bei 320 UEs entstehen hunderte vermeidbare LLM-Calls (Kosten + Laufzeit).
- **Fix:** In `call_structured_llm()` (zentral, ein Ort) vor dem Aufruf anhängen:
  ```python
  schema_json = json.dumps(response_schema.model_json_schema(), ensure_ascii=False, indent=2)
  full_system = f"{system_prompt}\n\nGEFORDERES JSON-SCHEMA (exakt einhalten):\n```json\n{schema_json}\n```"
  ```
  Alternativ je Prompt ein `{json_schema}`-Platzhalter. Nicht in beiden Ebenen doppelt einbauen.

### P2 — Didaktischer Widerspruch: 3–6 Folien für eine 45-Minuten-UE [MITTEL]

- **Datei:** `config/prompts/video_script.json` (user_prompt, letzte Zeile) + Vergleich `doc/konzept.md` Abschnitt 2.2
- **Problem:** *"Erstelle zwischen 3 und 6 Folien mit vollständigem Sprechertext pro Folie"* für eine behauptete 45-Minuten-Theorieeinheit. Bei ~1 Minute Rede pro Folie entsteht ein 3–6-minütiges Video. Das Konzept fordert 10–15 Minuten Vortragszeit pro 45-Min-UE. Die erzeugte Einheit kann die AZAV-Sollarbeitszeit nicht erklären.
- **Fix:** Entweder Folienanzahl auf 10–15 erhöhen (entspricht 10–15 Min Sprechzeit) oder die Rolle ehrlich als "Videolektion ~10 Min + begleitete Selbstlernphase mit Übungsaufgaben" formulieren und das Prompt entsprechend anpassen.

### P3 — "Exakt 10 Quizfragen" wird schematisch nicht erzwungen [MITTEL]

- **Datei:** `src/course_factory/schemas.py:145-148`
- **Ist-Code:**
  ```python
  class QuizSchema(BaseModel):
      ...
      questions: List[QuizQuestionItem] = Field(..., min_length=1, description="10 Multiple-Choice Fragen")
  ```
- **Problem:** Prompt fordert exakt 10 Fragen, Schema akzeptiert 1+. Duplikate von `question_id` sind ebenfalls erlaubt. Inspector/Import/UI behaupten überall "10 Fragen".
- **Fix:** `min_length=10, max_length=10` plus Validator auf eindeutige, lückenlose `question_id` 1..10.

### P4 — UnitBreakdown-Validator ist ein No-Op; Meso-Verteilung wird nicht geprüft [MITTEL]

- **Datei:** `src/course_factory/schemas.py:25-33`
- **Ist-Code:**
  ```python
  @field_validator("assessment_ue")
  @classmethod
  def validate_total_units(cls, v, info):
      theory = info.data.get("theory_ue", 0)
      practice = info.data.get("practice_ue", 0)
      if theory + practice + v != 8:
          # We enforce warning or tolerance, but for schema perfection, total should be 8
          pass          # <-- tut nichts
      return v
  ```
- **Problem:** Liefert das Makro z. B. 3+4+2=9, gibt `meso_day_plan` diese Verteilung an das LLM weiter und verlangt zugleich *"exakt 8 Einheiten, deren Typ-Summe der Verteilung entspricht"* = unlösbare Aufgabe → Self-Healing-Retries verbrennen. `DayPlanSchema` prüft ebenfalls nicht, ob die `ue_type`-Zählung der angeforderten Verteilung entspricht.
- **Fix:** Validator `raise ValueError` bei Summe ≠ 8; in `generate_day_plan` Nachprüfung, dass `Counter(unit.ue_type)` der `units_breakdown` entspricht (Abweichung → lokal korrigieren oder Retry).

### P5 — Prompt-Doppelung und fehlende Platzhalter-Validierung im Editor [NIEDRIG]

- **Datei:** `src/course_factory/prompt_manager.py:21-273` (`DEFAULT_PROMPTS`) vs. `config/prompts/*.json`; `save_prompt()` ebenda (Zeile 334-345)
- **Problem:** Werkdefault-Prompts werden doppelt gepflegt (Code + JSON-Dateien mit `default_*`-Spiegeln) → Änderungen müssen synchron erfolgen. `save_prompt()` prüft nicht, ob die deklarierten Platzhalter (`{course_title}` etc.) im neuen Prompt erhalten bleiben — ein Admin kann die Generierung unbemerkt brechen.
- **Fix:** Redundanzen akzeptieren (Reset-Mechanik braucht den Code-Default), aber im `PUT /api/admin/prompts/:id`-Handler (oder `save_prompt`) warnen/ablehnen, wenn ein im `variables`-Array deklarisierter Platzhalter im Text fehlt.

### Positive Feststellungen zu den Prompts

- Konsistente Struktur (Rolle → Regeln → Variablen), didaktisch hochwertig: AZAV/8-UE-Regel (Makro), Agenten-Routing-Regeln (Meso), "Schreiben für das Ohr, nicht ablesen" + 5–7-Wörter-Folienregel (Video), Distraktoren-Qualität + Erklärungszwang (Quiz).
- `get_prompt()` (`prompt_manager.py:363-388`) ist robust: `SafeDict.__missing__` + try/except. Verifiziert: Literal-JSON im slide_narration-Systemprompt übersteht `format_map` unbeschadet; Werte mit geschweiften Klammern werden nicht rekursiv interpoliert (keine Prompt-Injection über Inhalte).
- Studio-Prompts (`curriculum_generation`, `lesson_generation`) dürfen dünn sein, weil dort Instructor/Pydantic die Struktur erzwingt — anders als in der Factory (siehe P1).

---

## 2. Course Factory / Python (src/course_factory, src/ai_service)

### F1 — Wochenberechnung invertiert: Tage-only-Anforderung erzeugt 8-Wochen-Makro [HOCH]

- **Datei:** `src/course_factory/orchestrator.py:193-195`
- **Ist-Code:**
  ```python
  elif max_days:
      target_weeks = max(8, (max_days + 4) // 5)
      target_days = None
  ```
- **Problem:** Wer nur `--days 10` angibt, erhält `target_weeks = max(8, 2) = 8` → Makro-Generierung eines 40-Tage-Curriculums inkl. Prompt-Text "8 Wochen" statt "10 Tage". Token-Verschwendung; verarbeitete Tage werden danach zwar via `days_processed >= max_days` begrenzt, aber `master_curriculum.json` enthält 40 Tage für einen 10-Tage-Kurs.
- **Fix:** `target_weeks = max(1, (max_days + 4) // 5)` (ceil-Division) und `duration_desc` aus den effektiven Tagen bilden.

### F2 — Checkpoint/Resume ignoriert den Kurstitel [HOCH]

- **Datei:** `src/course_factory/orchestrator.py:203-227`
- **Problem:** Die Resume-Logik prüft nur Wochen-/Tage-Anzahlen des vorhandenen `master_curriculum.json`, nie `course_title`. Ein Themenwechsel im Inspector ohne "Clean Start" setzt still den **alten** Kurs fort (alter Titel, alter Inhalt, alte UEs werden übersprungen).
- **Fix:** Beim Laden vergleichen: `if curriculum.course_title.strip().lower() != course_title.strip().lower(): should_reload = True`.

### F3 — Meso-Day-Plan-Load ohne Fehlerbehandlung [MITTEL]

- **Datei:** `src/course_factory/orchestrator.py:329-332`
- **Ist-Code:**
  ```python
  if os.path.exists(day_plan_path) and not self.force_regenerate:
      with open(day_plan_path, "r", encoding="utf-8") as f:
          day_plan_dict = json.load(f)
      day_plan = DayPlanSchema.model_validate(day_plan_dict)
  ```
- **Problem:** Korruptes/nicht schema-konformes `day_{n}_plan.json` wirft ungefangen → kompletter Pipeline-Absturz. (Das analoge Makro-Laden in Zeilen 205-227 hat try/except.)
- **Fix:** try/except umladen; im Fehlerfall `day_plan` neu generieren und Datei überschreiben.

### F4 — Stiller Mock-Fallback nach fehlgeschlagenen Retries [KRITISCH für Zuverlässigkeit]

- **Datei:** `src/course_factory/llm_client.py:188-208`
- **Ist-Code (Auszug):**
  ```python
  else:
      print(f"[LLM Self-Healing] Max retries reached for {response_schema.__name__}.")
      if mock_fallback is not None:
          print(f"[LLM Self-Healing] Falling back to mock response.")
          return mock_fallback
  ```
- **Problem:** Nach 3 Fehlversuchen (JSON-/Schema-Fehler **oder** Netzwerk/API-Fehler, Zweites in `llm_client.py:197-205`) wird unbemerkt Mock-Inhalt zurückgegeben und von den Agenten als echter Content gespeichert — inkl. Platzhalter-Quiz ("Antwort A: Primäre Option und etablierter Standard"). Es gibt kein Flag in `progress.json`, keine Warnung im Inspector. Ein Total-Qualitätskollaps, der erst beim Schüler auffällt.
- **Fix (minimal):** In `call_structured_llm` Rückgabetyp erweitern oder Exception werfen; Agenten setzen bei Fallback `on_progress("WARNUNG: Mock-Fallback ...")` und `update_progress(mock_fallback_used=True)`; Inspector zeigt Banner. **Fix (sauber):** Mock nur noch bei explizitem `force_mock`; echte Fehler nach Retries hart failen lassen (Checkpoint erlaubt Resume).

### F5 — DayPlanSchema deckelt day_number auf 40, Handbuch verspricht bis 52 Wochen [MITTEL]

- **Datei:** `src/course_factory/schemas.py:78` vs. `doc/BENUTZERHANDBUCH.md` (Kursdauertabelle: "Benutzerdefiniert … 1 bis 52 Wochen")
- **Ist-Code:** `day_number: int = Field(..., ge=1, le=40, ...)`
- **Problem:** Custom-Kurse > 8 Wochen: ab Tag 41 validiert keine LLM-Antwort mehr → kaskadiert in F4 (stiller Mock-Fallback für den Rest des Kurses). `DayOverview` (Makro) erlaubt dagegen `le=365` — inkonsistent.
- **Fix:** `le=365` in `DayPlanSchema` (oder beide auf denselben konfigurierten Max-Wert).

### F6 — Makro-Ergebnis wird nicht gegen angeforderte Kursgröße geprüft [MITTEL]

- **Datei:** `src/course_factory/macro_generator.py:167-173`
- **Problem:** Das Schema erzwingt keine Wochen-/Tage-Mindestzahl. Liefert das LLM für "8 Wochen" nur 3 Wochen, wird das unbemerkt akzeptiert und verarbeitet (Erkennung erst beim nächsten Resume-Versuch über `existing_total_days < max_days`).
- **Fix:** Nach `call_structured_llm`: `sum(len(w.days) for w in curriculum.weeks)` gegen `target_days`/`total_weeks*5` prüfen; Abweichung → Retry mit Fehlermeldung (Self-Healing-Pattern existiert bereits).

### F7 — AI-Service: Port-/Bindungs-Drift und fehlende Auth [MITTEL (lokal), HOCH im Netz]

- **Datei:** `src/ai_service/main.py:567`
- **Ist-Code:** `uvicorn.run(app, host="0.0.0.0", port=8085)`
- **Problem:** (a) Konfig-Drift: `.env.example`/`doc/BENUTZERHANDBUCH.md`/`app.ts`-Default sagen Port `8000`, `writeEnvFile` schreibt `8085`, tatsächlicher Start via `start.bat` = `8085`. Lokal funktioniert es nur, weil die lokale `.env` `AI_SERVICE_URL=http://127.0.0.1:8085` setzt; ein frischer Clone ohne `.env` bricht. (b) `0.0.0.0` ohne jegliche Auth: jeder im LAN kann `/generate-*`-Endpoints aufrufen und LLM-Credits verbrennen.
- **Fix:** Port auf EINEN Wert vereinheitlichen (empfohlen 8000 überall oder 8085 überall inkl. Doku), `host="127.0.0.1"`, optional simplen Shared-Secret-Header gegen den Node-Backend prüfen lassen.

### F8 — Versteckter GLM-Key-Fallback aus fremdem Projekt [NIEDRIG/MITTEL]

- **Datei:** `src/ai_service/config.py:13-33`
- **Problem:** `_read_external_mql_key()` liest `GLM_API_KEY` aus `D:/git/MQL/MqlKiScanner/.env` bzw. `config/secrets.local.json`, wenn lokal kein Key gesetzt ist. Überraschende Cross-Projekt-Abhängigkeit: unbemerkte Kosten, schwer debuggbares Verhalten ("warum geht es ohne Key?").
- **Fix:** Entfernen oder hinter expliziten Opt-in-Env (`ALLOW_EXTERNAL_KEY_FALLBACK=true`) stellen und im Log laut melden.

---

## 3. Node-Backend (src/server, src/db, src/temporal)

### B1 — Passwortloses Login; Admin-Whitelist enthält die Studenten-E-Mail [KRITISCH]

- **Datei:** `src/server/app.ts:51-93` (Login), Zeile ~62
- **Ist-Code:**
  ```js
  const allowedAdminEmails = (process.env.ADMIN_EMAILS || 'admin@tenant-alpha.com,student@tenant-alpha.com')
  ```
- **Problem:** (a) Es gibt keinerlei Authentifizierung (kein Passwort/OTP): wer eine E-Mail kennt, IST der Nutzer — inkl. `admin@tenant-alpha.com`. Für lokale Demo ok, für jeden Netz-Einsatz disqualifizierend. (b) Die Default-`ADMIN_EMAILS`-Whitelist enthält `student@tenant-alpha.com`: bei Erstregistrierung mit dieser E-Mail und `role:"admin"` erhält der Account die Admin-Rolle (existierende Nutzer behalten ihre Rolle, aber frische DB = Eskalation).
- **Fix:** (a) Richtige Authentifizierung einführen (Passwort-Hash oder OIDC) ODER deployment-seitig strikt auf localhost beschränken und im Handbuch als Demo-Beschränkung ausweisen. (b) Default-Whitelist auf `admin@tenant-alpha.com` reduzieren.

### B2 — Course-Factory-API vollständig ohne Auth + Path Traversal Read + Pfad-Leak [KRITISCH]

- **Datei:** `src/server/app.ts` — Routen ohne `authenticateToken`:
  `GET /api/course-factory/overview` (2315), `GET /api/course-factory/day` (2356), `GET /api/course-factory/ue` (2394), `GET /api/course-factory/progress` (2581), `POST /api/course-factory/start-generation` (2616), `POST /api/course-factory/stop-generation` (2725)
- **Ist-Code (Auszug, /day):**
  ```js
  const week = req.query.week as string;
  const day = req.query.day as string;
  ...
  const dayPlanPath = path.join(COURSE_OUTPUT_DIR, `week_${week}`, `day_${day}`, `day_${day}_plan.json`);
  if (!fs.existsSync(dayPlanPath)) {
    return res.status(404).json({ error: `Day plan not found at ${dayPlanPath}` });   // <- absoluter Pfad-Leak
  }
  ```
- **Problem:** (a) `week`/`day`/`ue` fließen ungeprüft in `path.join` — Express dekodiert `%2F`, `path.join` normalisiert `..` → unauthentisierter beliebiger Datei-Lese-Zugriff (der `/ue`-Endpoint liefert Inhalte aller gefundenen Dateien: slides.json, instructions.md, alle Dateien in boilerplate/ und solution/, quiz.json). (b) 404-Meldungen leaken absolute Serverpfade. (c) `start-generation` spawnt unauthentifiziert einen Python-Prozess (Kosten-/CPU-DoS), `stop-generation` killt ihn.
- **Fix:** Alle 6 Routen hinter `authenticateToken` + Admin-Rollenprüfung; `week/day/ue` mit `/^\d+$/` validieren; Fehlermeldungen ohne absolute Pfade.

### B3 — Mock-HeyGen-Endpoint ohne Auth: SSRF + server-signierte Webhook-Fälschung [HOCH]

- **Datei:** `src/server/app.ts:2270-2311`
- **Ist-Code (Kern):**
  ```js
  app.post('/api/mock/heygen/generate', (req, res) => {
    const { videoId, courseId, script, audioUrl, webhookUrl } = req.body;
    ...
    const computedSignature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(JSON.stringify(webhookPayload)).digest('hex');
    const response = await fetch(webhookUrl, { ... headers: { 'X-Signature': computedSignature }, ... });
  ```
- **Problem:** Unauthentifiziert. Angreifer lässt den Server an **beliebige URLs** POSTen (SSR-Primitive) — insbesondere an den eigenen `/api/webhooks/heygen`, dessen HMAC-Prüfung die so erzeugte Signatur akzeptiert (Signature wird über dasselbe `JSON.stringify`-Roundtrip-Muster berechnet, V8 erhält die Key-Reihenfolge) → Kurs-"Fertigstellung" mit attacker-kontrollierter `video_url` fälschbar.
- **Fix:** Endpoint hinter Admin-Auth UND Env-Gated (`NODE_ENV !== 'production'` / `ENABLE_MOCK_ENDPOINTS=true`); `webhookUrl` auf eigene Origin beschränken.

### B4 — Hash-Chain-Zeiterfassung erfüllt den AZAV/AVGS-"Manipulationsschutz"-Claim nicht [HOCH]

- **Datei:** `src/server/app.ts:1416-1440` (Endpoint), `src/server/timeTracking.ts:10-45` (record), `:47-108` (verify)
- **Ist-Code:**
  ```js
  const { sessionId, durationSec } = req.body;
  if (!sessionId || durationSec === undefined) { ... }   // einzige Prüfung
  const log = await recordHeartbeat(user.id, sessionId, durationSec);
  ```
- **Problem (vier Teile):**
  1. `durationSec` ist ein reiner Client-Wert ohne Typ-/Range-Prüfung: Ein Schüler kann alle 10 s einen Heartbeat mit `durationSec: 3600` senden; die Kette verifiziert tadellos, weil sie nur belegt, *dass diese Werte geschrieben wurden*, nicht dass sie wahr sind.
  2. Read-then-Insert ohne Transaktion (`timeTracking.ts:16-26`): parallele Heartbeats (zwei Tabs, Retry) lesen denselben `previousHash` → **Kette gabelt**, ehrliche Daten werden als "manipuliert" gemeldet.
  3. Session ist nicht an den User gebunden: Student A kann in die Session von Student B posten (Endpoint authentifiziert `user.id`, `recordHeartbeat`/`verifyHashChain` filtern nur nach `sessionId`).
  4. Kein Index auf `activity_logs.session_id` (Schema hat gar keine Indizes) → jeder Heartbeat = Full-Scan `ORDER BY`; `verifyHashChain` sortiert nur nach `timestamp` ohne `id`-Tiebreaker (gleiches ms = falsche Reihenfolge möglich).
- **Fix:** `durationSec` serverseitig clampen (0..Intervall, z. B. 0..30) und gegen Wall-Clock-Delta zum Vorgänger-Block prüfen; Insert in Serialisierbare-Transaktion/`SELECT ... FOR UPDATE` mit Session-User-Bindung (`lastLog.userId === userId` sonst 403); Index auf `(session_id, timestamp)` + `ORDER BY timestamp ASC, id ASC`; danach den Claim in der Doku erneut prüfen.

### B5 — Webhook-HMAC über re-serialisierten Body, nicht timing-safe [MITTEL]

- **Datei:** `src/server/app.ts:1389-1395`
- **Ist-Code:**
  ```js
  const bodyString = JSON.stringify(req.body);
  const computedSignature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(bodyString).digest('hex');
  if (signature !== computedSignature) { ... }
  ```
- **Problem:** Echte Provider signieren die **Rohbytes**; `JSON.stringify(req.body)` reproduziert fremde Serialisierung (Whitespace/Key-Order) nicht → eine echte HeyGen-Signatur würde nie validieren (aktuell funktioniert nur der hauseigene Mock, siehe B3). `!==` ist nicht constant-time.
- **Fix:** Route mit `express.raw` ausstatten, HMAC über `req.body` (Buffer) und Vergleich via `crypto.timingSafeEqual`.

### B6 — Default-Secrets aktiv in Nutzung [HOCH]

- **Datei:** `src/server/auth.ts:7-9`, `src/server/app.ts:29`
- **Ist-Code:**
  ```js
  const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkeyforauthentication123!';  // nur console.warn
  const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'heygen-webhook-secret-key-12345';
  ```
- **Problem:** Beide Defaults stehen in `.env.example` und in `writeEnvFile` (`app.ts:1591`); der Testlauf warnt aktiv, d. h. die lokale `.env` verwendet den JWT-Default. Mit öffentlich bekanntem Secret sind Admin-Tokens und Webhooks fälschbar.
- **Fix:** Bei fehlendem/Default-Wert Startup verweigern oder kryptografisches Zufalls-Secret generieren und persistieren; Default aus `.env.example`/`writeEnvFile` entfernen.

### B7 — Pfad-Traversal in Medien-Pipelines [HOCH]

- **Datei 1:** `src/server/app.ts:592-644` (Slide-TTS) — `courseId` aus `:id` fließt ungeprüft in den Ausgabepfad:
  ```js
  const rel = `audio/${courseId}/slide-${String(slideIndex).padStart(3, '0')}-${Date.now()}.mp3`;
  ```
  Dazu `src/server/tts.ts:23`: `path.join(process.cwd(), 'public', opts.outRelativePath...)` → `..%2F` in `:id` = beliebiger Datei-Write (Admin-only, aber siehe B1). Der Endpoint prüft nicht, ob der Kurs existiert/zum Lesson passt.
- **Datei 2:** `src/server/videoExport.ts:41-44`:
  ```js
  function publicPathFromUrl(url: string): string {
    const rel = String(url || '').replace(/^\//, '').split('?')[0];
    return path.join(process.cwd(), 'public', rel);
  }
  ```
  `slide.image_url`/`audio_url` kommen aus DB-Payloads (Admin-editierbar) → `../..`-URLs lassen ffmpeg beliebige lokale Dateien in ein **öffentlich** ausgeliefertes MP4 kodieren (Exfiltration-Kanal).
- **Fix:** In beiden Fällen: Pfad auflösen und prüfen, dass `path.dirname(abs)` innerhalb von `<cwd>/public` bleibt (Common-Prefix-Check); im TTS-Endpoint Kurs-Existenz und Kurs↔Lesson-Beziehung validieren; `courseId` auf UUID-Format prüfen.

### B8 — Quiz-Lösungen im Studenten-Payload; Auswertung rein clientseitig [MITTEL]

- **Datei:** `src/server/app.ts:1242-1280` (`GET /api/courses/:id` liefert `lessons` inkl. vollem `contentPayload` mit `quiz[].correct_option_index` und `explanation`)
- **Problem:** Schüler können Lösungen per Devtools/Netzwerk-Tab lesen; es gibt keinen serverseitigen Score-Endpoint.
- **Fix:** Für Studenten-Rolle `correct_option_index`/`explanation` aus der Antwort strippen und einen `POST /api/courses/:id/lessons/:lessonId/quiz-submit` mit serverseitiger Auswertung nachziehen.

### B9 — Wizard Step 1: Delete außerhalb der Transaktion; keine Course-Tenant-Prüfung [MITTEL]

- **Datei:** `src/server/app.ts:~934-979`
- **Ist-Code:**
  ```js
  // Delete existing modules/lessons if regenerating
  await db.delete(modules).where(eq(modules.courseId, courseId));   // NICHT in der Tx
  await db.transaction(async (tx) => { /* Inserts ... */ });
  ```
- **Problem:** Schlägt die Transaktion fehl (kaputte AI-Antwort, FK-Fehler), ist das alte Curriculum bereits gelöscht → leerer Kurs. Zudem wird `courseId` nie auf Existenz/Tenant-Zugehörigkeit geprüft (Admin Tenant A überschreibt Kurs von Tenant B).
- **Fix:** Delete in die Transaktion ziehen; vorab `curriculum.modules`-Struktur validieren (Zod o.ä.); Course auf `tenantId === user.tenantId` prüfen.

### B10 — CORS offen, RLS dekorativ, keine Indizes, nicht-deterministische Lektions-Sortierung [MITTEL]

- `src/server/app.ts:25`: `app.use(cors())` reflektiert jede Origin → auf konfigurierte Frontend-Origin beschränken.
- `src/db/migrations.ts:54-55`: `CREATE ROLE elearning_app WITH LOGIN PASSWORD 'elearning_app_password'` (hartkodiert); die App verbindet sich als `postgres`-Superuser (`DATABASE_URL`), Superuser umgeht RLS immer → Tenant-Isolation beruht allein auf handgeschriebenen `eq(tenantId, ...)`-Filtern. Fix: App unter `elearning_app` (Zufallspasswort) betreiben.
- `src/db/schema.ts`: keinerlei Indizes — `modules.course_id`, `lessons.module_id`, `embeddings.lesson_id`, `activity_logs.session_id/user_id` fehlen (vgl. B4). Fix: nachziehen + Migration.
- `src/server/app.ts:1270`: Lektionen nur `orderBy(asc(lessons.createdAt))` — Step 1 fügt alle Lektionen in EINER Transaktion ein → identische Transaktions-Zeitstempel → willkürliche Reihenfolge im Client. Fix: zusätzliche `sequenceOrder`-Spalte nutzen bzw. nach Modul-Sequenz sortieren.

### B11 — writeEnvFile verwirft unbekannte Keys; Default-Drift bei Ports [MITTEL]

- **Datei:** `src/server/app.ts:~1566-1621` (writeEnvFile), `src/server/app.ts:30` (`AI_SERVICE_URL`-Default 8000), `src/db/index.ts:11` + `drizzle.config.ts` (DB-Fallback 5432) vs. `docker-compose.yml` (Host-Port 5439) vs. `.env.example` (5439) vs. `tests/backend.test.ts:43` (Fallback 5432)
- **Problem:** Beim ersten Speichern der Config via Admin-UI werden in `.env` vorhandene, aber nicht in der festen Key-Liste enthaltene Variablen (z. B. `GLM_MODEL`, `GLM_BASE_URL`, `GLM_VISION_MODEL`) still gelöscht. Default-Ports widersprechen sich (8000/8085, 3000/3010, 5432/5439) → frischer Clone ohne `.env` bricht an mehreren Stellen. Außerdem werden `AI_SERVICE_URL`/`TEMPORAL_ADDRESS` beim Modul-Load gelesen — Speichern im Config-UI wirkt nicht auf den laufenden Server.
- **Fix:** writeEnvFile auf Preserve-Unknown-Keys umstellen (nur bekannte Keys ersetzen, Rest unverändert übernehmen); alle Defaults auf je einen Wert vereinheitlichen.

### B12 — Kleinere Backend-Befunde [NIEDRIG]

- `src/server/app.ts:2565`: `correct_option_index: ['A','B','C','D'].indexOf(q.correct_option)` → bei ungültigem/kleingeschriebenem Buchstaben entsteht still `-1`; Factory-Import läuft zudem ohne Transaktions-Wrapper (Teilimport bei Fehler).
- `src/server/tts.ts:26-33`: Mock-TTS schreibt 0-Byte-`.mp3` (Player bricht ab; Kommentar im Code räumt es selbst ein).
- `src/server/app.ts:~2246`: interner Dispatch über `app._router.handle(...)` (privat, in Express 5 weg) — gemeinsame Handler-Funktion extrahieren.
- `src/temporal/workflows.ts` + `activities.ts`: `generateCurriculum`/`generateLessonsAndEmbeddings`/Compensations werden vom Workflow nicht mehr aufgerufen (toter Saga-Pfad); `activities.ts` würde bei Reaktivierung `contentPayload` komplett überschreiben. Entfernen oder fixen.
- `src/temporal/worker.ts:22`: `workflowsPath` zeigt auf `.ts`-Datei — funktioniert nur unter tsx, bricht in kompiliertem Build.
- Floating async-IIFEs mit DB-Writes im `catch` (z. B. `app.ts` step2-Content-Hintergrundjob): schlägt das DB-Update im Fehlerfall fehl, crasht es den Prozess (unhandled rejection) — catch-Body absichern.
- `GET /api/courses/:id/approve`: kein Zustandscheck — Freigabe aus jedem Status (inkl. `failed`/leerer Draft) möglich.

---

## 4. Frontend (public/js/app.js, public/index.html, public/inspector.html)

### FE1 — Systemisches XSS: 92 innerHTML-Sinks, kein escapeHtml [KRITISCH]

- **Datei:** `public/js/app.js` (92 `innerHTML`-Vorkommen, `grep -c escapeHtml` = 0)
- **Belegte Sinks mit LLM-/User-Inhalt:**
  ```js
  // app.js:620 — LLM-Lektionstext ungefiltert als HTML:
  document.getElementById('lesson-text').innerHTML = formatMarkdown(payload.text_content || '# Keine Theorie vorhanden');
  // app.js:633 — Quizfrage (Optionen/Erklärung nutzen korrekt textContent, Frage nicht):
  qBlock.innerHTML = `<h5>Frage ${qIndex + 1}: ${q.question}</h5>`;
  // app.js:801 — RAG-Tutor-Antwort:
  tutorMsg.innerHTML = `<div>${response.answer}</div>`;
  ```
  Weitere: Kurs-Thema (387, 980), Modul-/Lektionstitel (395, 406), Fortschrittstext mit Lektionstiteln (918), Wizard-Editor `value="${...}"`-Attribut-Injektion (2576-2620, 2817-2831), Teleprompter-Preview (3318-3323), Prompt-Editor (3678).
- **Verschärfend:** JWT + User liegen in `localStorage` (`app.js:3-4, 290-291`) → injiziertes Script kann Token exfiltrieren. Mermaid `securityLevel: 'loose'` (`public/index.html:23`) + ungefiltertes `<pre class="mermaid">${slide.mermaid_code}</pre>` ist ein weiterer Injektionspfad. `public/inspector.html:888`: `marked.parse(instructions)` ohne DOMPurify in innerHTML (LLM-Markdown aus der Factory).
- **Fix (einheitlich):** zentrale `escapeHtml(s)`-Helper-Funktion einführen und ALLE Interpolationen durchreichen (oder DOM-API/textContent wie bei den Quiz-Optionern); marked-Ausgaben durch `DOMPurify.sanitize(...)`; Mermaid auf `securityLevel: 'strict'`; Token auf `sessionStorage` + kürzere Laufzeit.

### FE2 — Heartbeat-Client: falsches Intervall, "undefined"-Anzeige, Session-Fragmentierung [MITTEL]

- **Datei:** `public/js/app.js:668` (`const intervalTime = 10000` — Doku sagt 30 s), `app.js:690` (`durationSec: Math.floor(intervalTime / 1000)` konstant), `app.js:746` (rendert `block.durationSec`, aber der Server antwortet ohne dieses Feld, `app.ts:1431-1436` → Anzeige "Dauer: undefineds"), `app.js:678 + 685-688` (jede Lektionsauswahl startet NEUE Session und wischt `state.hashChain`), kein `visibilitychange`-Handler (verdeckter Tab zählt weiter).
- **Fix:** Intervall auf dokumentierten Wert + Konstante zentral; Server `durationSec` im Heartbeat-Response echoen; eine Session pro Kurs-Betreten, nicht pro Lektion; `document.hidden`-Gate; tatsächliche Vergangenheit seit letztem Beat senden statt Konstante.

### FE3 — Wizard Step 2: Regenerierungs-Race → doppelte LLM-Kosten [HOCH]

- **Datei:** `public/js/app.js:2404` (`goToWizardStep(2)` auto-triggert Generierung wenn `!hasAnyContent`) + `app.js:2707` (`wizardGenerateLessonsContent` ohne In-Flight-Guard, anders als Step 1 mit `btn.dataset.busy`).
- **Problem:** Step2→Step1→Weiter während laufender Generierung startet einen zweiten parallelen Hintergrundjob über dieselben Lektionen (Doppel-Kosten, interleaved DB-Writes).
- **Fix:** Guard einführen (Button-Disabled-Status oder Course-Status `generating` abfragen und früh returnen).

### FE4 — Mermaid-Fehlerbehandlung ist toter Code [NIEDRIG]

- **Datei:** `public/js/app.js:3030-3041` und `3370-3381`
- **Problem:** `try { mermaid.run({ nodes: [...] }) } catch { ... }` — `mermaid.run()` gibt ein Promise zurück; Parse-Fehler lehnen asynchron ab → sync-catch greift nie, "[Diagramm-Fehler]"-Fallback erscheint nie, stattdessen Unhandled Rejections.
- **Fix:** `await` in async-Funktion + try/catch oder `.catch()` am Promise.

### FE5 — Gefälschte Verifikations-Daten in der Produktions-UI [MITTEL]

- **Datei:** `public/js/app.js:1028-1034` (injiziert Demo-Sessions `sess_demo_chain_123` / `sess_demo_chain_broken`), `app.js:1467-1486` (kurzschließt `sess_demo_chain_broken` mit hartkodiertem "Kette manipuliert!" ohne Serverkontakt).
- **Problem:** Demo-Code, der das zentrale Vertrauensfeature (Revisionsprüfung) untergräbt und in echten Audits zu Verwirrung führt.
- **Fix:** Entfernen oder hinter Dev-Flag (`?demo=1`) stellen.

### FE6 — Fehlerbehandlung/Polling-Kleinigkeiten [NIEDRIG]

- `public/inspector.html:664-676` (`init()` ruft `resp.json()` ohne `resp.ok`-Check; bei 500/HTML hängt die Seite im "Lade Kurs...") und `inspector.html:982` (`importCourseToDb` ebenso).
- `public/js/app.js:1371-1391`: `pptxPollUntilIdle`-Interval wird nach Modal-Schließen nicht gecleart (läuft bis zu 120× alle 2,5 s weiter).
- `public/index.html:14-16` + `public/inspector.html:11-13`: unpinned CDNs (`lucide@latest`, `mermaid`, `marked`) — Major-Bump bricht Rendering still. Fix: Versionen pinnen/local vendoren.

---

## 5. Bereits behobene Probleme im Arbeitsstand (NICHT erneut fixen)

Der Arbeitsstand enthält partielle Security-Härtung (erkennbar an `P0.x FIX`-Kommentaren in `src/server/app.ts`). Diese Befunde eines Erst-Reviews sind **gegenstandslos**:

| ID | Thema | Status |
|---|---|---|
| X1 | Rollen-Eskalation beim Login (Client konnte `role`/`tenantId` bestehender Nutzer überschreiben) | Behoben: bestehende Nutzer behalten DB-Rolle (`app.ts` "P0.1 FIX"); Restrisiko siehe B1 |
| X2 | `GET /api/auth/users` unauthentifiziert | Behoben: `authenticateToken` + Admin-Check (`app.ts:97-102`) |
| X3 | Host-Header-Admin-Bypass in `adminOrLocalAuth` + Path-Traversal in Prompt-Dateipfaden | Behoben: Bypass nur noch via `ALLOW_LOCAL_ADMIN=true` + `req.socket.remoteAddress`-Loopback-Check; `getSafePromptPath()` mit `/^[a-zA-Z0-9_-]+$/` und Containment-Check (`app.ts:1688-1724`) |

---

## 6. Explizit geprüft und NICHT defekt (damit keine Zeit darauf verschwendet wird)

- **SQL-Injection:** drizzle parametrisiert überall, inkl. `sql\`1 - (${embeddings.embedding} <=> ${...}::vector)\`` und `inList`.
- **Command-Injection:** ffmpeg/pdftoppm/PowerShell/python via `spawn`/`execFile` mit Argument-Arrays, keine Shell-Strings.
- **JWT-Verifikation:** `jwt.verify` prüft issuer/audience/expiry; jsonwebtoken v9 (keine alg-Konfusion). Problem ist nur der Default-Secret (B6).
- **Hash-Chain-Schreib/Lese-Symmetrie:** `recordHeartbeat` und `verifyHashChain` hashen identisch über `timestamp.toISOString()`; Verifikationslogik ist für die gespeicherten Daten korrekt (Problem ist, WELCHE Daten gespeichert werden → B4).
- **Cascade-Deletes** modules→lessons→embeddings korrekt deklariert; Migrations-SQL konsistent zum Schema.
- **`.gitignore`:** `.env`, `public/audio|slides|exports`, `course_output/`, `node_modules`, `.venv` sind korrekt ignoriert; keine Mediendateien im Repo.
- **Frontend-/Backend-API-Verträge:** alle `fetch`-URLs in app.js/inspector.html existieren als Routen; `progress.json`-Felder (completed_ues, percent, current_*) matchen zwischen Orchestrator und Inspector; Quiz-Index-Konvention (A–D ↔ 0–3) ist über Wizard, Factory-Import und Player konsistent.

---

## 7. Priorisierte Maßnahmenliste (Abarbeitungsempfehlung)

| Prio | Maßnahmen | Findings |
|---|---|---|
| 1 | XSS schließen: zentrale `escapeHtml` + DOMPurify für marked + Mermaid `strict` + Token aus localStorage | FE1 |
| 2 | Course-Factory-Routen authentifizieren, week/day/ue validieren, Mock-Heygen env-gaten, Pfad-Leaks entfernen | B2, B3 |
| 3 | Heartbeat härten (Server-Clamping, User-Session-Bindung, Transaktion, Index) oder Doku-Claim anpassen | B4, FE2 |
| 4 | Secrets: Default-JWT/WEBHOOK-Secret ablehnen bzw. randomisieren; `student@` aus Admin-Whitelist | B6, B1 |
| 5 | JSON-Schema in Systemprompts injizieren (ein Ort: `call_structured_llm`) | P1 |
| 6 | Mock-Fallback sichtbar machen (progress.json-Flag + Inspector-Banner) oder hart failen | F4 |
| 7 | Pfad-Containment in TTS/videoExport; Kurs-Tenant-Checks in Wizard-Endpoints | B7, B9 |
| 8 | Orchestrator-Fixes: `max→ceil`, Resume-Titelvergleich, Meso-Load try/except | F1, F2, F3 |
| 9 | Schema-Striktheit: Quiz==10, UnitBreakdown-Summe==8, day_number-Limit angleichen | P3, P4, F5 |
| 10 | Port-/Default-Vereinheitlichung (8000 vs 8085, 5432 vs 5439, 3000 vs 3010), writeEnvFile preserve unknown keys | B11, F7 |
| 11 | Quiz-Scoring serverseitig; Indizes + Lektions-Sortierung; CORS konfigurieren | B8, B10 |

---

## 8. Verifikationshinweise (Reproduktion)

```bash
# Python-Tests (alle 23 muessen gruen sein; benoetigt pytest im System-Python):
python -m pytest tests/test_prompt_manager.py tests/test_course_factory.py -v

# Backend-Integrationstests (benoetigt laufende Postgres-Docker-Instanz):
npx tsx tests/backend.test.ts

# Prompt-Rendering pruefen (SafeDict/JSON-Braces):
src/ai_service/.venv/Scripts/python.exe -c "import sys; sys.path.insert(0,'src'); from course_factory.prompt_manager import get_prompt; print(get_prompt('slide_narration', course_topic='X', position='Folie 1 von 1', slide_title='T', bullets_txt='- a'))"

# XSS-Sinks zaehlen:
grep -c innerHTML public/js/app.js   # erwartetes Ergebnis Stand 2026-09-06: 92

# Routen ohne Auth-Middleware auflisten:
grep -n "app\.get(\|app\.post(\|app\.put(\|app\.delete(" src/server/app.ts | grep -v "authenticateToken\|adminOrLocalAuth"
```

---

*Ende des Code-Reviews. Bei Abweichungen zwischen Zeilennummern und Code gilt der zitierte Code.*
