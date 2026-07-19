# 🎓 KI-eLearning Platform

> **Zero-Ops AI-driven E-Learning Platform** – Personalisiertes Lernen mit KI-Avataren, adaptiver Inhaltsgenerierung und echtem Lernfortschritt-Tracking.

![Dashboard](doc/images/dashboard.png)

---

## 📋 Inhaltsverzeichnis

- [Überblick](#-überblick)
- [Features](#-features)
- [Architektur](#-architektur)
- [Tech Stack](#-tech-stack)
- [Voraussetzungen](#-voraussetzungen)
- [Installation & Setup](#-installation--setup)
- [Konfiguration](#-konfiguration)
- [Dienste starten](#-dienste-starten)
- [API-Dokumentation](#-api-dokumentation)
- [Projektstruktur](#-projektstruktur)
- [Tests](#-tests)
- [Contributing](#-contributing)

---

## 🌟 Überblick

Die KI-eLearning Platform ist ein vollständig KI-gesteuertes E-Learning-System, das:

- **Dynamisch Lernmaterial** auf Basis von Kursbeschreibungen generiert
- **AI-Avatare & Text-to-Speech** für immersives Lernen einsetzt (ElevenLabs / HeyGen)
- **Adaptive Quiz-Generierung** für jeden Lernenden individuell erstellt
- **Semantische Suche** über Kursinhalt mit pgvector Embeddings ermöglicht
- **Echtzeit-Lernfortschritt** mit kryptografisch sicheren Heartbeats trackt
- **Multi-Tenant-fähig** für verschiedene Organisationen ist

---

## ✨ Features

| Feature | Beschreibung |
|---|---|
| 🤖 **KI-Inhaltsgenerierung** | Kurse, Lektionen & Quizze werden vollautomatisch per LLM erstellt |
| 🎙️ **Text-to-Speech** | ElevenLabs-Integration für natürliche Sprachausgabe |
| 🎭 **Avatar-Videos** | HeyGen-Integration für KI-Präsentatoren (optional) |
| 🔍 **Semantische Suche** | pgvector-Embeddings für kontextuelle Inhaltssuche |
| 📊 **Lernfortschritt** | Zeitbasiertes Tracking mit Heartbeat-Chain-Verifizierung |
| 🏢 **Multi-Tenant** | Vollständige Datentrennung zwischen Organisationen |
| 🔐 **JWT Auth** | Sichere Token-basierte Authentifizierung |
| ⚡ **Temporal Workflows** | Robuste, fehlertolerante asynchrone Verarbeitung |

---

## 🏗 Architektur

![Architektur](doc/images/architecture.png)

Das System besteht aus drei Hauptschichten:

```
Browser (HTML/CSS/JS)
        │
        ▼
Node.js/Express API (Port 3010)
        │
   ┌────┴────┐
   │         │
   ▼         ▼
Temporal   Python FastAPI
Workflows  AI Service (Port 8085)
   │         │
   └────┬────┘
        │
        ▼
  PostgreSQL + pgvector
        │
   ┌────┴────────────┐
   │                 │
   ▼                 ▼
ElevenLabs       OpenRouter LLM
(TTS/Audio)    (Gemini 2.5 Pro)
```

### Workflow-Ablauf

1. **Admin** erstellt einen Kurs via Web-Interface
2. **Temporal Workflow** startet den Generierungsprozess
3. **Python AI Service** ruft das LLM (OpenRouter) auf und generiert Inhalte
4. **ElevenLabs** wandelt Text in natürliche Sprache um
5. **pgvector** speichert Embeddings für semantische Suche
6. **Student** kann den fertigen Kurs mit KI-Chat durcharbeiten

---

## 🛠 Tech Stack

### Backend (TypeScript / Node.js)
- **Express.js** – REST API Server
- **Drizzle ORM** – Type-safe PostgreSQL ORM
- **Temporal.io** – Workflow Orchestrierung
- **jsonwebtoken** – JWT Authentication
- **Zod** – Schema Validierung

### AI Service (Python)
- **FastAPI** – Async Python API
- **OpenRouter** – LLM Gateway (Gemini 2.5 Pro, Claude, etc.)
- **sentence-transformers** – Lokale Embeddings

### Frontend
- **Vanilla HTML/CSS/JS** – Leichtgewichtig, keine Build-Pipeline nötig
- **Glassmorphism Design** – Modernes dunkles Theme

### Infrastruktur
- **PostgreSQL 16 + pgvector** – Vektor-Datenbank
- **Docker Compose** – Lokale Entwicklungsumgebung
- **ElevenLabs** – Text-to-Speech
- **HeyGen** (optional) – KI-Avatar-Videos

---

## 📦 Voraussetzungen

| Tool | Version | Zweck |
|---|---|---|
| Node.js | ≥ 20.x | Backend Runtime |
| Python | ≥ 3.11 | AI Service |
| Docker & Docker Compose | aktuell | PostgreSQL + Temporal |
| npm | ≥ 10.x | Package Manager |

---

## 🚀 Installation & Setup

### 1. Repository klonen

```bash
git clone https://github.com/tnickel/elearning.git
cd elearning
```

### 2. Node.js Abhängigkeiten installieren

```bash
npm install
```

### 3. Python Abhängigkeiten installieren

```bash
cd src/ai_service
python -m venv .venv

# Windows
.venv\Scripts\activate

# Linux/macOS
source .venv/bin/activate

pip install -r requirements.txt
cd ../..
```

### 4. Umgebungsvariablen konfigurieren

```bash
# .env.example als Vorlage kopieren
cp .env.example .env
```

Dann `.env` mit eigenen Werten befüllen (siehe [Konfiguration](#-konfiguration)).

### 5. Infrastruktur starten

```bash
# PostgreSQL + Temporal via Docker
docker compose up -d

# Warten bis alle Services healthy sind
docker compose ps
```

### 6. Datenbank-Migrationen ausführen

```bash
npm run db:migrate
```

---

## ⚙ Konfiguration

Kopiere `.env.example` zu `.env` und trage folgende Werte ein:

```env
# Datenbank
DATABASE_URL=postgres://postgres:postgres@localhost:5439/elearning

# Server
PORT=3010
JWT_SECRET=<dein-sicherer-jwt-secret>

# Temporal Workflow Engine
TEMPORAL_ADDRESS=localhost:7233
TEMPORAL_QUEUE=elearning-tasks

# ElevenLabs (Text-to-Speech)
ELEVENLABS_API_KEY=<dein-elevenlabs-api-key>
ELEVENLABS_VOICE_ID=<voice-id>

# OpenRouter (LLM Gateway)
OPENROUTER_API_KEY=<dein-openrouter-api-key>
OPENROUTER_MODEL=google/gemini-2.5-pro

# HeyGen (optional, nur für Avatar-Videos)
HEYGEN_API_KEY=<dein-heygen-api-key>
GENERATE_VIDEO=false
```

> ⚠️ **Wichtig**: Die `.env` Datei wird **nie** in Git eingecheckt. Teile API-Keys niemals öffentlich!

---

## 🎬 Dienste starten

### Alle Dienste auf einmal (Windows)

```bat
start.bat
```

### Manuell (einzelne Terminals)

**Terminal 1 – Backend API:**
```bash
npm run dev:server
```

**Terminal 2 – Temporal Worker:**
```bash
npm run dev:worker
```

**Terminal 3 – Python AI Service:**
```bash
cd src/ai_service
.venv\Scripts\activate    # Windows
python main.py
```

### Verfügbare URLs

| Service | URL |
|---|---|
| Web Interface | http://localhost:3010 |
| REST API | http://localhost:3010/api |
| AI Service (FastAPI) | http://localhost:8085 |
| Temporal UI | http://localhost:8239 |
| Drizzle Studio (DB) | `npm run db:studio` |

---

## 📡 API-Dokumentation

### Authentifizierung

```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "student@example.com",
  "role": "student",
  "tenantId": "org-123"
}
```

**Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": { "id": "...", "email": "...", "role": "student" }
}
```

---

### Kurse

| Method | Endpoint | Beschreibung |
|---|---|---|
| `GET` | `/api/courses` | Alle Kurse des Tenants abrufen |
| `POST` | `/api/courses` | Neuen Kurs erstellen (Admin) |
| `GET` | `/api/courses/:id` | Kursdetails mit Modulen |
| `DELETE` | `/api/courses/:id` | Kurs löschen (Admin) |

### Lektionen

| Method | Endpoint | Beschreibung |
|---|---|---|
| `GET` | `/api/lessons/:id` | Lektion abrufen |
| `POST` | `/api/lessons/:id/complete` | Lektion als abgeschlossen markieren |
| `POST` | `/api/lessons/:id/heartbeat` | Lern-Heartbeat senden |

### KI-Chat

| Method | Endpoint | Beschreibung |
|---|---|---|
| `POST` | `/api/lessons/:id/chat` | KI-Frage zu einer Lektion stellen |
| `GET` | `/api/search?q=query` | Semantische Suche über Kursinhalt |

### Fortschritt

| Method | Endpoint | Beschreibung |
|---|---|---|
| `GET` | `/api/progress` | Lernfortschritt des Studenten |
| `GET` | `/api/admin/stats` | Admin-Übersicht & Statistiken |

---

## 📁 Projektstruktur

```
elearning/
├── src/
│   ├── server/
│   │   ├── app.ts              # Express API & alle REST Endpoints
│   │   ├── auth.ts             # JWT Authentication Middleware
│   │   └── timeTracking.ts     # Heartbeat & Lernzeit-Verifizierung
│   ├── db/
│   │   ├── index.ts            # Drizzle ORM Setup & Tenant-Helpers
│   │   ├── schema.ts           # Datenbankschema (Tabellen)
│   │   └── migrations.ts       # Migrationsskripte
│   ├── temporal/
│   │   ├── workflows.ts        # Temporal Workflow-Definitionen
│   │   ├── activities.ts       # Temporal Activities (AI-Aufrufe)
│   │   └── worker.ts           # Temporal Worker-Prozess
│   └── ai_service/
│       ├── main.py             # FastAPI AI-Service
│       ├── config.py           # Konfigurationshelfer
│       └── requirements.txt    # Python-Abhängigkeiten
├── public/
│   ├── index.html              # Single-Page Frontend
│   ├── css/style.css           # Stylesheet (Dark Theme)
│   └── js/app.js               # Frontend JavaScript
├── scripts/                    # Hilfsskripte
├── tests/                      # Backend-Integrationstests
├── drizzle/                    # Drizzle-Konfiguration
├── doc/
│   └── images/                 # Dokumentationsbilder
├── docker-compose.yml          # Lokale Infrastruktur
├── .env.example                # Vorlage für Umgebungsvariablen
├── package.json
├── tsconfig.json
└── README.md
```

---

## 🧪 Tests

```bash
# Backend-Integrationstests ausführen
npm test

# Oder mit PowerShell-Skript
.\run_tests.ps1

# Python AI Service Tests
cd src/ai_service
python test_config.py
python test_openrouter.py
```

---

## 🤝 Contributing

1. Fork das Repository
2. Feature-Branch erstellen: `git checkout -b feature/mein-feature`
3. Änderungen committen: `git commit -m 'feat: Neues Feature hinzufügen'`
4. Branch pushen: `git push origin feature/mein-feature`
5. Pull Request erstellen

### Commit-Konventionen

Wir verwenden [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` – Neues Feature
- `fix:` – Bugfix
- `docs:` – Dokumentation
- `refactor:` – Code-Umstrukturierung
- `test:` – Tests hinzufügen/ändern

---

## 📄 Lizenz

MIT License – siehe [LICENSE](LICENSE) für Details.

---

<div align="center">

**Entwickelt mit ❤️ und KI**

*KI-eLearning Platform – Personalisiertes Lernen der nächsten Generation*

</div>
