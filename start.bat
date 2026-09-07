@echo off
title KI E-Learning Platform Launcher
echo ==================================================
echo      KI E-LEARNING PLATFORM START-UP SCRIPT       
echo ==================================================
echo.

:: 1. Start Docker Containers
echo [1/5] Starte Docker-Compose (Postgres + Temporal)...
docker compose up -d
if %errorlevel% neq 0 (
    echo [ERROR] Docker-Compose konnte nicht gestartet werden.
    echo Bitte vergewissere dich, dass Docker Desktop geoeffnet und aktiv ist!
    pause
    exit /b %errorlevel%
)
echo.

:: 2. Wait for Postgres & Temporal to be healthy
echo [2/5] Warte auf Datenbank und Temporal Server...
timeout /t 5 /nobreak
echo.

:: 3. Run Database Migrations
echo [3/5] Führe Drizzle-Datenbank-Migrationen aus...
call npx.cmd tsx src/db/migrations.ts
if %errorlevel% neq 0 (
    echo [ERROR] Datenbank-Migrationen fehlgeschlagen.
    pause
    exit /b %errorlevel%
)
echo.

:: 4. Start Python AI FastAPI Service
echo [4/5] Starte Python AI-Service (in isolierter venv)...
start "AI Service (FastAPI)" cmd /k "echo Starte AI-Service... && cd /d %~dp0src\ai_service && if not exist .venv (python -m venv .venv) && call .venv\Scripts\activate.bat && .venv\Scripts\python.exe -m pip install -r requirements.txt && .venv\Scripts\python.exe main.py"

:: 5. Start Temporal Worker & Express API Server
echo [5/5] Starte Temporal Worker and Express Server...
start "Temporal Worker" cmd /k "echo Starte Temporal Worker... && cd /d %~dp0 && npm run dev:worker"

echo.
echo ==================================================
echo      SERVER ERFOLGREICH GESTARTET!
echo ==================================================
echo.
echo Hauptportal / Studio:      http://localhost:3010
echo Course Factory Inspector:  http://localhost:3010/inspector.html
echo Temporal Web UI:           http://localhost:8239
echo.
echo Oeffne Webbrowser...
start http://localhost:3010
npm run dev:server
pause
