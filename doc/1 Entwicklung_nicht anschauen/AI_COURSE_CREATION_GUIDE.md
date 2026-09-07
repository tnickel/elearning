# 🎓 AI Course & Video Generation Guide: Aethel Learning

Diese Dokumentation dient als Schnittstellen- und Ablaufbeschreibung für andere KI-Agenten, die vollautomatisch Kurse, Foliensätze und vertonte Schulungsvideos in **Aethel Learning** erstellen möchten.

---

## 🚀 Ablauf der Kurserstellung (Reihenfolge)

Um ein Schulungsvideo bzw. einen Kurs zu erstellen, müssen die folgenden Phasen exakt in dieser Reihenfolge durchlaufen werden.

### Phase 1: Authentifizierung
Jeder REST-Endpunkt erfordert ein gültiges, zustandslose JWT-Token (Bearer-Token).
*   **Endpunkt:** `POST /api/auth/login`
*   **Request-Body:**
    ```json
    {
      "email": "student@tenant-alpha.com",
      "role": "admin",
      "tenantId": "de305d54-75b4-431b-adb2-eb6b9e546014"
    }
    ```
*   **Response-Body:** `{ token, user }`. Extrahiere den `token` und sende ihn in allen nachfolgenden Requests als Header mit: `Authorization: Bearer <DEIN_TOKEN>`.

---

### Phase 2: Kurs-Entwurf erstellen (Option A oder Option B)

#### Option A: Generativer KI-Ablauf (Prompt-to-Course)
1.  **Lehrplan (Curriculum) entwerfen:**
    *   **Endpunkt:** `POST /api/courses/wizard/step1-curriculum`
    *   **Body:**
        ```json
        {
          "courseId": "new",
          "topic": "Docker & Kubernetes Grundlagen",
          "duration": "2_weeks",
          "customPrompt": "Fokus auf Container-Sicherheit und RLS"
        }
        ```
    *   **Aktion:** Der API-Server ruft den Python-AI-Service auf, welcher über Gemini 2.5 Pro Module und Lektionstitel entwirft und in der DB anlegt. Der Kurs erhält den Status `curriculum_draft`.
2.  **Inhalte & Sprechskripte generieren:**
    *   **Endpunkt:** `POST /api/courses/wizard/step2-content`
    *   **Body:**
        ```json
        {
          "courseId": "<COURSE_UUID>"
        }
        ```
    *   **Aktion:** Loops über alle Lektionen, generiert didaktische Markdown-Theorie, Quizfragen, Folien und das **Teleprompter-Sprecherskript** (Text, den die KI spricht). Der Kurs wechselt in den Status `content_draft`.

#### Option B: PowerPoint-Import (.pptx)
Wenn bereits eine fertige PowerPoint-Präsentation vorliegt:
*   **Endpunkt:** `POST /api/courses/import-pptx?filename=meine_praesentation.pptx`
*   **Body:** Der binäre Dateiinhalt der `.pptx`-Datei (Multipart/Stream).
*   **Aktion:** Das Backend extrahiert mittels `officeparser` Slide-Strukturen, Titel und Bulletpoints, legt Kurse/Module/Lektionen in PostgreSQL an und setzt den Status direkt auf `content_draft`.

---

### Phase 3: Vertonung & Medien-Rendering
Sobald die Folien und Skripte in der Datenbank liegen, muss die Audiosynthese angestoßen werden.
*   **Endpunkt:** `POST /api/courses/wizard/step3-media`
*   **Body:**
    ```json
    {
      "courseId": "<COURSE_UUID>"
    }
    ```
*   **Aktion:** Startet den **Temporal.io Workflow** (`CourseGenerationWorkflow`). Dieser ruft für jede Lektion die ElevenLabs-Schnittstelle auf und erzeugt die fertige Audiodatei (`public/audio/audio-<course>-<lesson>.mp3`).
*   **Status:** Der Kurs befindet sich während des Renderings in `generating` und wechselt nach Abschluss automatisch in `pending_approval`.

---

### Phase 4: Freigabe (Aktivierung)
Damit Schüler das Schulungsvideo im Dashboard sehen können, muss der Admin den Kurs freigeben.
*   **Endpunkt:** `POST /api/courses/<COURSE_UUID>/approve`
*   **Body:** (leer)
*   **Aktion:** Der Kursstatus wechselt auf `active`. Der Kurs ist jetzt für alle Schüler des Mandanten freigeschaltet.

---

## ⚠️ Wichtige Design- & Ablaufregeln für KIs

Beim Generieren der Folien und Sprechtexte müssen folgende Punkte zwingend beachtet werden, um eine professionelle Qualität zu garantieren:

### 1. Folien-spezifische Text-Aufteilung (Proportionaler Split)
*   **Achtung:** Die Anwendung teilt das `teleprompter_script` einer Lektion anhand von Leerzeilen (`\n\n`) auf die Folien auf.
*   **Regel:** Generiere **exakt so viele Absätze** (getrennt durch doppelte Zeilenumbrüche), wie die Lektion **Folien** hat!
*   *Beispiel:* Hat die Lektion 3 Folien, schreibe exakt 3 zusammenhängende Textabschnitte in das Sprechskript. Abschnitt 1 erklärt Folie 1, Abschnitt 2 erklärt Folie 2 (z. B. das Diagramm) und Abschnitt 3 erklärt Folie 3.

### 2. Slide Layout & Typen
Jedes Slide-Objekt im JSON-Array der Lektion benötigt ein passendes Layout:
*   `"bullets"`: Standardtext mit Stichpunkten und optionaler Bild-URL.
*   `"code"`: Code-Ansicht. Erfordert zusätzlich `"code_language"` (z. B. `"yaml"`, `"dockerfile"`) und `"code_snippet"`.
*   `"mermaid"`: Diagramm-Ansicht. Erfordert ein gültiges, einfaches Mermaid-Ablaufdiagramm in `"mermaid_code"` (z. B. `graph TD` oder `graph LR`). Vermeide HTML-Tags in Mermaid-Labels.

### 3. Vektorgrafik-Fallbacks
*   Besitzt eine Folie mit dem Layout `bullets` keine explizite `image_url`, durchsucht die App den Folientitel und Text nach Begriffen. Benutze gezielt Schlüsselwörter in Folientiteln für thematisch passende Neon-Visualisierungen:
    *   *Docker, Container, DevOps* -> zeigt Docker-Motivationsgrafiken
    *   *Cyber, Security, Passwort, Auth, OWASP* -> zeigt Cybersecurity-Schutzschild-Grafik
    *   *Datenbank, SQL, Postgres, Cloud, Server* -> zeigt Server-Rack-Datenbankgrafik
    *   *Programmieren, Node, Code, JS* -> zeigt allgemeine Entwicklergrafik

### 4. Row-Level Security (RLS) & Tenant-Kontext
*   Wenn du direkt SQL-Operationen auf der Datenbank offiziell ausführst (z. B. über Drizzle), musst du die Transaktionen zwingend mit der Mandanten-ID wrappen (`withTenant(tenantId, async (tx) => { ... })`), da PostgreSQL RLS (Row-Level Security) aktiv validiert und Zugriffe ohne gesetzte `app.current_tenant_id` blockiert.
