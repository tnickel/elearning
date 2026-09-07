# Ausführliches Benutzerhandbuch: KI E-Learning & Course Factory Plattform

> **Dokumentenversion:** 2.1  
> **Zielgruppe:** Administratoren, IT-Dozenten, Curriculum-Designer, Schulungsträger (AZAV/AVGS) und Teilnehmende (Schüler)  
> **System-Status:** Lokale Entwicklungs- und Preview-Umgebung mit Multi-Agenten-Orchestrierung, GLM-5.3 / Gemini LLM-Anbindung und kryptographischer Lernzeit-Verifikation.

---

## Inhaltsverzeichnis

1. [Systemübersicht & Architektur](#1-systemübersicht--architektur)
2. [Installation & Schnellstart](#2-installation--schnellstart)
3. [Die zwei Generierungswege im Vergleich](#3-die-zwei-generierungswege-im-vergleich)
4. [Course Factory (Multi-Agenten Pipeline mit bis zu 320 UE)](#4-course-factory-multi-agenten-pipeline-mit-bis-zu-320-ue)
   - [Kursdauer & Kursumfänge (1 Tag bis 2 Monate)](#kursdauer--kursumfänge)
   - [Die 5 Spezial-Agenten im Detail](#die-5-spezial-agenten-im-detail)
   - [Checkpointing, Pause & Nahtlose Fortsetzung](#checkpointing-pause--nahtlose-fortsetzung)
   - [Inspector-Dashboard: Entwürfe prüfen & freigeben](#inspector-dashboard-entwürfe-prüfen--freigeben)
5. [Studio Kurs-Designer & 3-Stufen-Wizard](#5-studio-kurs-designer--3-stufen-wizard)
   - [Schritt 1: Lehrplan-Konzeption](#schritt-1-lehrplan-konzeption)
   - [Schritt 2: Generierung von Lektionsinhalten & Sprechertexten](#schritt-2-generierung-von-lektionsinhalten--sprechertexten)
   - [Schritt 3: Medien-Synthese & Freigabe](#schritt-3-medien-synthese--freigabe)
   - [PowerPoint (.pptx) Import](#powerpoint-pptx-import)
6. [Zentrales Prompt-Management (Prompt-Schablonen)](#6-zentrales-prompt-management-prompt-schablonen)
7. [KI-Modelle, LLM-Provider & API-Key-Sicherheit](#7-ki-modelle-llm-provider--api-key-sicherheit)
8. [Teilnehmer-Bereich (Lernportal für Schüler)](#8-teilnehmer-bereich-lernportal-für-schüler)
9. [Zeiterfassung mit Hash-Kette (lokale Demo / AZAV-Vorbereitung)](#9-zeiterfassung-mit-hash-kette-lokale-demo--azav-vorbereitung)
10. [Fehlerbehebung & FAQ](#10-fehlerbehebung--faq)

---

## 1. Systemübersicht & Architektur

Die Plattform ist ein duales E-Learning-Ökosystem:
1. **Das interaktive Studio:** Für Dozenten zur schnellen Konzeption von Modulen, Folien und Skripten per Wizard oder PowerPoint-Import.
2. **Die autonome Course Factory:** Ein Multi-Agenten-System, das vollständige, standardkonforme Curricula für geförderte IT-Weiterbildungen (bis zu 8 Wochen / 320 Unterrichtseinheiten à 45 Minuten) vollautomatisch plant, ausdetailliert und qualitätsgesichert bereitstellt.

```mermaid
graph TD
    A[start.bat] --> B[Docker: PostgreSQL + pgvector :5439]
    A --> C[Node.js / Express Backend :3010]
    A --> D[Python AI Service & Course Factory :8085]
    
    subgraph UI & Frontends
        E[Admin Dashboard: index.html]
        F[Course Factory Inspector: inspector.html]
        G[Schüler Lernportal: index.html]
    end
    
    C <--> E
    C <--> F
    C <--> G
    C <--> D
    
    subgraph AI Engine & Provider
        D --> H[GLM-5.3 / Z.ai PaaS]
        D --> I[Gemini 2.5 Pro / OpenRouter]
        D --> J[ElevenLabs TTS]
        D --> K[Offline Mock-Modus]
    end
```

---

## 2. Installation & Schnellstart

### Voraussetzungen
* **Betriebssystem:** Windows 10/11 (64-Bit)
* **Software:** Docker Desktop (aktiv), Node.js (>= v18), Python (>= 3.10)
* **Hardware:** Mindestens 8 GB RAM (empfohlen: 16 GB), stabiler Internetzugang für LLM-APIs

### Ein-Klick-Start
Das gesamte System (Datenbank, Node-Server, Python-Service und UI) wird über eine einzige Datei im Projektstammverzeichnis gestartet:

```powershell
# Im Projektverzeichnis ausführen:
start.bat
```

Was `start.bat` im Hintergrund ausführt:
1. Prüft Docker und startet PostgreSQL mit Vektorerweiterung (`pgvector`) auf Port 5439 (gemappt auf 5432 im Container).
2. Führt Drizzle-Migrationen aus, um Tabellenstrukturen und Indizes aufzubauen.
3. Startet das Node.js-Backend unter `http://localhost:3010`.
4. Startet den Python FastAPI AI-Service unter `http://localhost:8085`.
5. Öffnet den Browser automatisch auf `http://localhost:3010`.

### Standard-Zugänge
| Rolle | E-Mail | Mandant (Tenant ID) | Funktion |
| :--- | :--- | :--- | :--- |
| **Administrator / Dozent** | `admin@tenant-alpha.com` | `de305d54-75b4-431b-adb2-eb6b9e546014` | Voller Zugriff auf Kursdesigner, Factory, Prompt-Editor und Revisionsprüfung |
| **Schüler (Teilnehmer)** | `student@tenant-alpha.com` | `de305d54-75b4-431b-adb2-eb6b9e546014` | Lernansicht, Folien, Video-Player, Quizfragen, kryptographisches Tracking |

---

## 3. Die zwei Generierungswege im Vergleich

| Eigenschaft | Studio Kurs-Designer (`index.html`) | Course Factory (`inspector.html`) |
| :--- | :--- | :--- |
| **Hauptzweck** | Schrittweise Konzeption von Kursen im 3-Stufen-Wizard | Vollautonome Großkurs-Produktion (AZAV/AVGS) |
| **Kursumfang** | 1 Stunde, 1 Tag (8 UE) bis 8 Wochen (320 UE) | 1 Tag (8 UE), 1–6 Wochen, 8 Wochen (320 UE) |
| **Agenten-Architektur** | 1 Instructor-LLM (Curriculum + Lesson Content) | 5 spezialisierte Agenten (Macro, Meso, Video, Coding, Quiz) |
| **Prüfung** | Direkt im Wizard vor dem Speichern | Im interaktiven Inspector mit Diff-Prüfung |
| **Stopp & Resume** | Nicht erforderlich (schrittweise synchron) | Vollständig checkpoint-gesichert via `progress.json` |
| **Aufgaben-Typen** | Folien, Markdown, 1-3 Quizfragen | Folien, ElevenLabs-Audio, Coding-Boilerplate, 10-Fragen-Quiz |

---

## 4. Course Factory (Multi-Agenten Pipeline mit bis zu 320 UE)

Die Course Factory ist für die Erstellung vollständiger Bildungsmaßnahmen konzipiert. Jeder Unterrichtstag umfasst **exakt 8 Unterrichtseinheiten (UE) à 45 Minuten** (6 Zeitstunden netto).

### Kursdauer & Kursumfänge

| Dauer-Preset | Tage | UEs gesamt | Typischer Verwendungszweck |
| :--- | :---: | :---: | :--- |
| **⚡ 1 Tag (Test-Modus)** | 1 | 8 UE | Testläufe, Prompt-Validierung, 1-Tages-Workshop |
| **📅 1 Woche (Kompaktkurs)** | 5 | 40 UE | Einführungskurs, Kompaktseminar |
| **📅 2 Wochen (Crashkurs)** | 10 | 80 UE | Intensivkurs, Technologie-Upgrade |
| **📅 4 Wochen (1 Monat)** | 20 | 160 UE | Standardmodul in geförderten Weiterbildungen |
| **📅 6 Wochen (Intensivkurs)**| 30 | 240 UE | Vertiefungsmodul mit Zwischenprojekt |
| **🏆 8 Wochen (2 Monate)** | 40 | 320 UE | **Vollständiges IT-Bootcamp** (AZAV/AVGS-Maßnahme) |
| **⚙️ Benutzerdefiniert** | *n* × 5 | *n* × 40 UE | Frei wählbare Wochenanzahl (1 bis 52 Wochen) |

---

### Die 5 Spezial-Agenten im Detail

```
                 [Thema & Zielgruppe]
                          │
                          ▼
               ┌──────────────────────┐
               │ 1. Macro Generator   │ ── Erstellt Wochen- & Tagesstruktur
               └──────────────────────┘
                          │
                          ▼
               ┌──────────────────────┐
               │ 2. Meso Generator    │ ── Teilt jeden Tag in 8 exakte UEs ein
               └──────────────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
 ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
 │ 3. Video-    │  │ 4. Coding-   │  │ 5. Quiz-     │
 │    Script    │  │    Exercise  │  │    Agent     │
 └──────────────┘  └──────────────┘  └──────────────┘
  (Theorie 3-4 UE)  (Praxis 3-4 UE)  (Wissen 1-2 UE)
```

#### 1. Macro Generator (`macro_generator.py`)
* **Aufgabe:** Erstellt den didaktischen Gesamtplan über alle Wochen und Tage.
* **Ergebnis:** `master_curriculum.json` mit Tages-Themen, didaktischen Ansätzen und Meilensteinen.

#### 2. Meso Generator (`meso_generator.py`)
* **Aufgabe:** Analysiert jeden Tag einzeln und teilt ihn in exakt 8 UEs auf.
* **Routing:** Weist jede UE deterministisch dem passenden Spezialagenten zu:
  * Theorie-Einheit ➔ `video_script_agent`
  * Programmier-Einheit ➔ `coding_exercise_agent`
  * Wissensüberprüfung ➔ `quiz_agent`

#### 3. Video Script Agent (`video_script_agent.py`)
* **Aufgabe:** Erstellt Foliensätze und gesprochene Texte.
* **Foliendesign:** Erzeugt Titel, Aufzählungen, Mermaid-Diagrammcodes oder Code-Snippets (max. 5–7 Worte pro Aufzählungspunkt).
* **ElevenLabs-Optimierung:** Formuliert Texte sprechoptimiert mit Sprechpausen (`...`), ohne Folientexte stur abzulesen.

#### 4. Coding Exercise Agent (`coding_exercise_agent.py`)
* **Aufgabe:** Erstellt praxistaugliche Programmieraufgaben für die Übungseinheiten.
* **Komponenten:**
  * `instructions.md`: Aufgabenstellung mit Kontext, Anforderungen und Praxistipps.
  * `starter_code`: Lauffähiges Code-Skelett mit klaren `# TODO:` Markierungen.
  * `solution`: Vollständige, getestete Musterlösung.
  * `validation_criteria`: Prüfkriterien für automatische oder manuelle Bewertung.

#### 5. Quiz Agent (`quiz_agent.py`)
* **Aufgabe:** Erstellt für jede Assessment-UE exakt **10 Multiple-Choice-Fragen**.
* **Qualitätskriterien:**
  * 4 Antwortoptionen (A, B, C, D) mit genau einer korrekten Option.
  * Plausible Distraktoren (typische Anfängerfehler).
  * Ausführliche `explanation`: Erklärt, warum die Antwort richtig ist und worin der Denkfehler der Distraktoren liegt.

---

### Checkpointing, Pause & Nahtlose Fortsetzung

Große Curricula (z. B. 320 UEs) beanspruchen je nach Modell und Parallelität einige Zeit. Die Plattform verfügt über ein robustes Checkpoint-System:

1. **Automatisches Speichern:** Nach jeder fertig generierten UE wird das Zwischenergebnis auf die Festplatte (`course_output/`) geschrieben und `progress.json` aktualisiert.
2. **Pause / Abbruch:** Ein Klick auf **„Generierung stoppen“** (oder ein Neustart des Systems) beendet den Vorgang sauber.
3. **Nahtlose Fortsetzung:** Beim erneuten Klick auf **„Generierung starten“** erkennt der Orchestrator den bestehenden Checkpoint und fährt **exakt an der letzten unvollständigen UE fort**. Bereits erstellte Einheiten werden übersprungen.
4. **Clean Start erzwingen:** Über die Checkbox *„Neu generieren (Clean Start)“* können bestehende Dateien auf Wunsch verworfen und von vorne begonnen werden.

---

### Inspector-Dashboard: Entwürfe prüfen & freigeben

Erreichbar über `http://localhost:3010/inspector.html` oder den Button **„Course Factory Entwürfe prüfen“** im Navigationsbereich.

* **Fortschrittsbalken:** Zeigt in Echtzeit z. B. `48 von 320 UEs generiert (15.0%)`.
* **Wochen- und Tages-Navigation:** Schneller Wechsel zwischen Wochen 1–8 und Tagen 1–40.
* **Einheiten-Inspektor:**
  * **Theorie-Tab:** Folienvorschau (inklusive Mermaid-Diagramm-Rendering) und ElevenLabs-Sprechertext.
  * **Praxis-Tab:** Markdown-Aufgabenstellung, Starter-Code und Musterlösung im Syntax-Highlighter.
  * **Quiz-Tab:** Alle 10 Fragen mit markierter Lösung und didaktischer Begründung.
* **Import & Freigabe:** Über den Button **„In Live-System importieren“** wird das geprüfte Curriculum strukturiert in die PostgreSQL-Datenbank überführt (initial im Entwurfsstatus, bis der Dozent ihn zur Freigabe bestätigt).

---

## 5. Studio Kurs-Designer & 3-Stufen-Wizard

Der Studio-Generator auf der Startseite (`index.html`) richtet sich an Dozenten, die flexibel einzelne Kurse zusammenstellen und visuell anpassen möchten.

### Ablauf im Studio-Designer

```mermaid
sequenceDiagram
    autonumber
    actor Dozent
    participant UI as Browser (index.html)
    participant Server as Node.js Backend
    participant AI as Python AI Service

    Dozent->>UI: Thema eingeben + Dauer wählen (z.B. 2 Monate / 320 UE)
    Dozent->>UI: Klick auf "Kurs automatisch erstellen"
    UI->>Server: POST /api/courses/generate
    Server-->>UI: Entwurf angelegt (courseId)
    UI->>UI: Wizard öffnet Schritt 1
    UI->>Server: POST /api/courses/wizard/step1-curriculum
    Server->>AI: POST /generate-curriculum
    AI-->>Server: Modul- & Lektionsbaum
    Server-->>UI: Lehrplan fertig
    Dozent->>UI: Module editieren / anpassen -> Klick auf "Weiter"
    UI->>Server: POST /api/courses/wizard/step2-content
    Server->>AI: POST /generate-lesson (parallel für Lektionen)
    AI-->>Server: Teleprompter + Begleittext + Quizzes
    Server-->>UI: Lektionsinhalte synchronisiert
    Dozent->>UI: Klick auf "Fertigstellen" -> Freigabe für Schüler
```

### Schritt 1: Lehrplan-Konzeption
* Das System formuliert anhand des Themas und der gewählten Dauer (z. B. `8_weeks` für 320 UE oder `1_day` für 8 UE) eine vollständige Gliederung.
* **Interaktives Editieren:** Dozenten können Titel umbenennen, Lektionen hinzufügen, löschen oder die Reihenfolge anpassen.

### Schritt 2: Generierung von Lektionsinhalten & Sprechertexten
* Für jede Lektion werden automatisch Begleittexte (Markdown), Programmierbeispiele und Sprechertexte generiert.
* Der Live-Fortschritt zeigt den Fortschritt jeder einzelnen Lektion an.

### Schritt 3: Medien-Synthese & Freigabe
* **Audio-Synthese:** Sprechertexte werden über die ElevenLabs API in natürliche Sprache umgewandelt.
* **Folien-Rendering:** Folien werden über HTML5 Canvas oder integrierte Mermaid-Diagramme für das Abspielen gerendert.
* **Freigabe:** Durch Klick auf *„Kurs freigeben“* wird der Kurs für alle eingeschriebenen Schüler im Mandanten sichtbar.

### PowerPoint (.pptx) Import
Bestehende Präsentationen können direkt per Drag & Drop importiert werden:
1. `.pptx`-Datei auf die Dropzone im Dashboard ziehen.
2. Der Server konvertiert die Folien pixelgenau 1:1 in optimierte Web-Bilder (`.png`).
3. Aus den Folientiteln und Texten wird automatisch ein neuer Kurskatalog erstellt.

---

## 6. Zentrales Prompt-Management (Prompt-Schablonen)

Jede Formulierung, jedes Didaktik-Prinzip und jedes Ausgabeformat der KI-Modelle ist im Admin-Bereich einsehbar und editierbar.

### Zugriff auf den Prompt-Editor
* **Im Dashboard:** Klicke im Bereich *„KI-Modelle & API-Keys konfigurieren“* auf **„Prompt-Schablonen anpassen“**.
* **Im Inspector:** Klicke in der Steuerungsleiste auf den Button **„Prompts anpassen“**.

### Verfügbare Schablonen
1. **`macro_curriculum`:** Erstellt das Master-Curriculum für 1 Tag bis 8 Wochen (320 UE).
2. **`meso_day_plan`:** Zuständig für die 8-UE-Tagesaufteilung und das Agenten-Routing.
3. **`video_script`:** Generiert Folien und ElevenLabs-optimierte Sprechertexte.
4. **`coding_exercise`:** Erstellt praxisorientierte Programmieraufgaben mit Starter-Code und Musterlösung.
5. **`quiz`:** Generiert die 10 Multiple-Choice Fragen mit Erklärungen.
6. **`curriculum_generation`:** Gliederungserstellung für den Studio-Wizard.
7. **`lesson_generation`:** Ausarbeitung von Telepromptertexten und Lektionsinhalten im Studio.

### Bedienung
* **Variablen:** Alle Schablonen nutzen Platzhalter wie `{course_title}`, `{duration_desc}`, `{ue_title}` etc. Eine Tabelle unter dem Textfeld zeigt alle gültigen Variablen an.
* **Speichern:** Änderungen werden in `config/prompts/{prompt_id}.json` gesichert und wirken sich sofort auf alle künftigen Generierungen aus.
* **Zurücksetzen:** Über **„Auf Werkseinstellung zurücksetzen“** kann jederzeit das getestete Werksprompt wiederhergestellt werden.

---

## 7. KI-Modelle, LLM-Provider & API-Key-Sicherheit

### Modell-Umschaltung

In beiden Generierungs-Oberflächen kann zwischen den folgenden Modellen umgeschaltet werden:

| Modell | Provider | Stärken | Typische Konfiguration |
| :--- | :--- | :--- | :--- |
| **GLM-5.3** *(Standard)* | Z.ai PaaS / ZhipuAI | Hervorragende Strukturtreue, exakte JSON-Compliance, wirtschaftlich bei 320 UE Großaufträgen | `ZHIPUAI_API_KEY` oder `GLM_API_KEY` |
| **Gemini 2.5 Pro** | OpenRouter | Sehr hohe didaktische Tiefe, elaborierte Programmierbeispiele | `OPENROUTER_API_KEY` |
| **Offline Mock-Modus** | Lokal (ohne API) | Sofortige Generierung realistischer Test-Curricula ohne API-Kosten | Checkbox *„Offline Mock-Modus“* |

### Sicherheitsrichtlinie für API-Schlüssel
* **Niemals Schlüssel in Git committen:** Die `.env`-Datei ist in `.gitignore` eingetragen.
* Alle Schlüssel verbleiben ausschließlich lokal in deiner `.env`-Datei:

```ini
# .env Konfiguration
PORT=3010
AI_SERVICE_URL="http://localhost:8085"
DATABASE_URL="postgres://postgres:postgres@localhost:5439/elearning"
JWT_SECRET="dein-sicheres-geheimnis"

# LLM Provider Keys
ZHIPUAI_API_KEY="dein-glm-key"
OPENROUTER_API_KEY="dein-openrouter-key"

# Audio & Video
ELEVENLABS_API_KEY="dein-elevenlabs-key"
```

---

## 8. Teilnehmer-Bereich (Lernportal für Schüler)

Nach dem Login als `student@tenant-alpha.com` sieht der Teilnehmende ausschließlich für seinen Mandanten freigegebene Kurse.

### Funktionen der Lernoberfläche
1. **Lektions-Navigator:** Schneller Zugriff auf Module, Tage und Einheiten mit visuellem Fortschrittsstatus.
2. **Interaktiver Video- & Folienplayer:**
   * Umschalten zwischen Folien, Mermaid-Diagrammen und Vollbild.
   * Teleprompter-Transkript zum Mitlesen der gesprochenen Inhalte.
3. **Praxis-Aufgaben & Code-Viewer:**
   * Strukturierte Aufgabenstellung im Markdown-Format.
   * Starter-Code und Musterlösung mit Syntax-Highlighting im Tab **Praxis** (serverbasierte Ausführungs-Sandbox optional als spätere Ausbaustufe).
4. **Wissensüberprüfung (Quiz):**
   * Multiple-Choice Fragen mit Sofort-Auswertung.
   * Nach Abgabe erscheint die ausführliche didaktische Erklärung (`explanation`).

---

## 9. Zeiterfassung mit Hash-Kette (lokale Demo / AZAV-Vorbereitung)

Für geförderte Maßnahmen verlangen Kostenträger oft einen revisionssicheren Lernzeitnachweis. Diese Plattform implementiert dafür eine **SHA-256-Hash-Kette** als technische Grundlage.

> **Hinweis (lokaler Demo-Betrieb):** Die Kette belegt, dass gespeicherte Heartbeats unverändert sind (Integrität). Sie ersetzt **keine** unabhängige Anwesenheitskontrolle: Dauerwerte kommen vom Client (serverseitig begrenzt), und ein fehlender Passwort-Login ist für reine Localhost-Demos akzeptabel, aber nicht für produktive AZAV-Abrechnung.

### Funktionsweise der SHA-256 Hash-Kette

Während ein Schüler eine Lerneinheit aktiv bearbeitet, sendet der Browser regelmäßig (Intervall ca. 15–30 Sekunden) einen kryptographischen Heartbeat an das Backend:

```
Block n:   SHA256( SessionID | Timestamp | ActiveDuration | Hash_des_Blocks_(n-1) )
```

Jeder neue Eintrag signiert mathematisch den Vorgängereintrag. Eine nachträgliche Manipulation gespeicherter Blöcke in der Datenbank bricht die Kette.

### Revisionsprüfung im Admin-Dashboard
1. Melde dich als Administrator an.
2. Im Bereich **„Lernzeit Revisionsprüfung“** die gewünschte Sitzung (Session ID) auswählen.
3. Klicke auf **„Kryptographische Kette prüfen“**.
4. Das System validiert alle Blöcke von Block 1 bis zum aktuellen Zeitpunkt:
   * **Ergebnis Grün:** *Kette integer – Keine Manipulation der gespeicherten Blöcke erkannt.*
   * **Ergebnis Rot:** *Manipulationsverdacht! Block x weicht von der Signatur ab.*

---

## 10. Fehlerbehebung & FAQ

### 1. Die Generierung stoppt oder meldet einen Fehler
* **Prüfung:** Läuft der Python AI-Service? Teste `http://localhost:8085/docs` im Browser.
* **API-Key prüfen:** Ist in der `.env` ein gültiger Schlüssel für GLM oder OpenRouter eingetragen?
* **Mock-Modus testen:** Aktiviere im Inspector die Checkbox *„Offline Mock-Modus“*. Wenn die Generierung nun sofort durchläuft, liegt das Problem an einem abgelaufenen oder fehlerhaften API-Key.

### 2. Nach einem Abbruch soll die Generierung an der gleichen Stelle weitergehen
* Belasse die Checkbox *„Neu generieren (Clean Start)“* **deaktiviert**.
* Klicke einfach erneut auf **„Generierung starten“**. Der Orchestrator liest die vorhandenen JSON-Dateien aus `course_output/` und fährt an der ersten noch fehlenden Unterrichtseinheit fort.

### 3. Diagramme werden nicht dargestellt
* Das System nutzt die moderne Mermaid.js-Bibliothek. Stelle sicher, dass im Browser JavaScript aktiv ist und die Foliendefinition gültigen Mermaid-Code (`graph TD`, `sequenceDiagram` etc.) enthält.

### 4. Ein Kurs erscheint nicht bei den Schülern
* Neu generierte Kurse befinden sich im Status `curriculum_draft` oder `content_draft`.
* Der Dozent muss den Entwurf im Admin-Dashboard oder im Inspector über die Schaltfläche **„Kurs freigeben“** bestätigen. Erst dann wechselt der Status auf `active`.

---
*Ende des Benutzerhandbuchs. Bei weiteren Fragen oder Erweiterungswünschen konsultiere die internen Architektur-Dokumente im Ordner `doc/`.*
