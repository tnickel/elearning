# Codereview vom 06.09.2026

Geprüfter Stand: aktuelles Arbeitsverzeichnis einschließlich nicht eingecheckter Änderungen. Vier parallele Prüfbereiche: Backend/Datenbank, Frontend, Python/Prompts und Medien/Workflows/Tests. Berücksichtigt: README, `doc/konzept.md`, `doc/BENUTZERHANDBUCH.md`. Der als „nicht anschauen“ bezeichnete Entwicklungsordner wurde ausgelassen.

**Ergebnis: Der aktuelle Stand ist nicht produktionsreif.** Die Dokumentation behauptet stärkere Sicherheit, Datenintegrität und didaktische Vollständigkeit, als die Implementierung bietet. Besonders schwer wiegen die freie Vergabe von Adminrechten, ungeschützte Verwaltungsfunktionen, Dateipfad- und HTML-Injection sowie als Erfolg verbuchte Ersatzinhalte.

Von diesem Review wurden Anwendungscode, Prompts und vorhandene Ausgaben nicht verändert. Dieser Bericht ist das Reviewartefakt. Während der Prüfung waren weitere Änderungen im gemeinsamen Arbeitsverzeichnis erkennbar, unter anderem eine ergänzte JWT-Warnung in `auth.ts`; der unsichere Ersatzwert bleibt damit weiterhin erlaubt. Spätere Änderungen können Fundstellen verschieben.

## Prüfverfahren und Grenzen

- `npx --no-install tsc --noEmit`: erfolgreich, Exit 0.
- `node --check public/js/app.js`: erfolgreich.
- Backendtests erfolgreich **im ausdrücklich erzwungenen Offline-Modus**, mit unerreichbarer Test-DB und gesperrten HTTP-Aufrufen. Das ist keine erfolgreiche Integration gegen reale Dienste.
- Alle **19 Course-Factory-Testfunktionen und vier Promptmanager-Testfunktionen** erfolgreich direkt in einem isolierten Python-Harness ausgeführt. Temporäre Ausgabeverzeichnisse; Promptdateien ebenfalls auf temporäre Dateien umgeleitet. Kein regulärer pytest-Lauf: Im Projekt-venv fehlt pytest.
- Zusätzliche negative Tests an tatsächlichen Funktionen mit ersetzten DB-/LLM-/Dateisystemadaptern: Host-Header-Bypass, Prompt-Pfadzugriff, Heartbeat-Rennen und unzulässige Dauer, HTML-Formatierer, fehlerhafte Erfolgsanzeige, LLM-Request ohne Schema, Mock-Fallback, Übungsdateipfade, unzureichende Schemas und Checkpointfehler.
- Medien-Repro mit echtem Activity-Code in isolierter VM: erfolgreiche MiniMax-Antwort und ElevenLabs-HTTP-429 führen beide zu Demo-Medien statt einem Fehler.
- `npm audit --omit=dev --json`: 10 betroffene Paketpositionen, davon 5 „high“ und 5 „moderate“. Das ist kein Nachweis zehn ausnutzbarer Angriffe auf diese Anwendung.
- Kein vollständiger Browser-/PowerPoint-/FFmpeg-/Temporal-End-to-End-Lauf, keine produktiven DB-Schreibtests, keine kostenpflichtigen KI-Aufrufe. Python-Abhängigkeiten wurden nicht mit einem Vulnerability-Scanner geprüft.
- Ein vollständiges Review des vorliegenden Quellcodes kann Fehlerfreiheit nicht beweisen. Unten sind bestätigte Implementierungsfehler von offenen Prüfpunkten und didaktischen Einschätzungen getrennt.

P1 = vor produktivem Einsatz beheben. P2 = relevanter Funktions-/Robustheitsfehler. Quellpfade beziehen sich auf `D:/AntiGravitySoftware/GitWorkspace/elearning/`; Zeilen auf diesen Arbeitsstand.

## Bestätigte Befunde

### Sicherheit

**01 · P1 · Anonyme Clients können sich Adminrechte und fremde Identitäten geben.**  
Fundstelle: [app.ts:51](D:/AntiGravitySoftware/GitWorkspace/elearning/src/server/app.ts:51), insbesondere 51–79; Nutzerliste ab 96.  
Der Login übernimmt E-Mail, Rolle und Mandant aus dem Request ohne Identitätsnachweis. Bereits vorhandene Benutzer werden auf diese Werte umgeschrieben. Ein Request mit `role=admin` erhält ein regulär signiertes Admin-Token. Damit schützt die nachfolgende Rollenprüfung praktisch nicht. **Korrektur:** echte Anmeldung; Rolle und Mandant serverseitig bestimmen; Demo-Login ausschließlich explizit und isoliert aktivieren. Der feste JWT-Ersatzwert in `auth.ts:7` muss ebenfalls durch einen verpflichtenden sicheren Konfigurationswert ersetzt werden.

**02 · P1 · Manipulierbarer Host-Header umgeht Prompt-Adminprüfung.**  
Fundstelle: [app.ts:1702](D:/AntiGravitySoftware/GitWorkspace/elearning/src/server/app.ts:1702).  
`adminOrLocalAuth` akzeptiert unter anderem einen vom Client gesetzten Hostnamen als Lokalitätsnachweis. Tatsächliche Middleware mit fremder IP und `Host: localhost` getestet: Zugriff als Admin ohne Token. **Korrektur:** authentifizieren; Client-Header niemals als Berechtigungsnachweis verwenden.

**03 · P1 · Prompt-ID ermöglicht Lesen und Verändern fremder JSON-Dateien.**  
Fundstelle: [app.ts:1685](D:/AntiGravitySoftware/GitWorkspace/elearning/src/server/app.ts:1685), Schreibpfad 1763–1764.  
`path.join(PROMPTS_DIR, id + '.json')` begrenzt den resultierenden Pfad nicht auf das Promptverzeichnis. Der echte GET-Handler lieferte mit `id="../../package"` die Projekt-`package.json`. PUT kann solche erreichbaren bestehenden JSON-Dateien um Promptfelder verändern. In Verbindung mit 02 ohne Anmeldung erreichbar. **Korrektur:** bekannte Prompt-IDs erlauben; normalisierten Zielpfad auf Zugehörigkeit zum erlaubten Verzeichnis prüfen.

**04 · P1 · Factory-Verwaltung und Ausgaben sind ungeschützt.**  
Fundstelle: [app.ts:2599](D:/AntiGravitySoftware/GitWorkspace/elearning/src/server/app.ts:2599), Stop bei 2708, Leseendpunkte ab 2298.  
Start und Stop haben keine Authentifizierung. Anonyme Anfragen können Generierung mit externen Modellkosten starten, Neugenerierung verlangen und laufende Arbeit unterbrechen. Ausgaben einschließlich Musterlösungen sind öffentlich abrufbar. **Korrektur:** zentrale Authentifizierung und Rollen-/Mandantenprüfung für sämtliche Factory-Routen.

**05 · P1 · Gespeichertes XSS durch ungefiltertes Markdown/HTML.**  
Fundstelle: [app.js:838](D:/AntiGravitySoftware/GitWorkspace/elearning/public/js/app.js:838), Verwendung 644 und 825; [inspector.html:888](D:/AntiGravitySoftware/GitWorkspace/elearning/public/inspector.html:888).  
`formatMarkdown` lässt HTML und Ereignisattribute unverändert und das Ergebnis landet in `innerHTML`. Ein harmloser Test mit einem `img`-`onerror`-Attribut blieb erhalten. Generierte, importierte oder bearbeitete Inhalte können so JavaScript im angemeldeten Browser ausführen; das Token liegt in localStorage. **Korrektur:** Markdown-Ausgabe sanitizen und sonstige Inhalte passend zum HTML-Kontext escapen. Modellantworten sind nicht vertrauenswürdig.

**06 · P1 · Generierte Übungsdateinamen können den Ausgabeordner verlassen.**  
Fundstelle: [coding_exercise_agent.py:123](D:/AntiGravitySoftware/GitWorkspace/elearning/src/course_factory/agents/coding_exercise_agent.py:123), außerdem 130.  
LLM-Dateinamen werden ungeprüft an den Zielordner angehängt. `../escaped.txt` schrieb im isolierten Test außerhalb des Boilerplateordners; absolute Pfade können den Basispfad umgehen. Umgekehrt scheitert ein legitimes `src/main.py`, weil Elternordner nicht angelegt werden. **Korrektur:** absolute/ausbrechende Pfade ablehnen; erlaubte Unterordner sicher erstellen.

### Kursgenerierung, Persistenz und Import

**07 · P1 · Die Factory übermittelt ihr Antwortschema nicht an das Modell.**  
Fundstelle: [llm_client.py:141](D:/AntiGravitySoftware/GitWorkspace/elearning/src/course_factory/llm_client.py:141), 154–168.  
Der Request enthält nur Prompts und JSON-Modus. Das Pydantic-Schema wird erst zur nachträglichen Validierung benutzt. Die Factory-Prompts verlangen ein „gefordertes JSON-Format“, liefern aber dessen vollständige Struktur nicht. Abgefangener Request bestätigt das Fehlen. Das Modell muss Pflichtfelder und Verschachtelungen erraten. **Korrektur:** Schema über ein unterstütztes strukturiertes Antwortformat oder vollständig im Prompt mitgeben. Die Studio-Instructor-Aufrufe sind davon zu unterscheiden: Dort wird ein `response_model` übergeben.

**08 · P1 · Live-LLM-Fehler werden als erfolgreiche Mockinhalte gespeichert.**  
Fundstelle: [llm_client.py:189](D:/AntiGravitySoftware/GitWorkspace/elearning/src/course_factory/llm_client.py:189), besonders 192 und 204.  
Nach ausgeschöpften Netzwerk- oder Validierungsversuchen kommt `mock_fallback` als normales Resultat zurück. Alle fünf Generatoren stellen diesen bereit. Die Factory speichert die Ersatzdaten und überspringt sie später als fertigen Checkpoint. Fake-Liveclient mit Netzwerkfehler reproduzierte diesen Ablauf. **Korrektur:** Mock ausschließlich bei explizitem Testmodus; Livefehler persistent als fehlgeschlagen markieren.

**09 · P1 · Resume kann einen anderen Kursauftrag durch alte Inhalte ersetzen.**  
Fundstelle: [orchestrator.py:205](D:/AntiGravitySoftware/GitWorkspace/elearning/src/course_factory/orchestrator.py:205).  
Beim Laden des bestehenden Masters werden Wochen/Tage geprüft, aber nicht Kursthema, Zielgruppe oder Auftragsidentität. Test: Kurs A erzeugen, anschließend Kurs B im gleichen Ausgabeordner anfordern. Master bleibt A, alle acht Einheiten werden übersprungen. **Korrektur:** eigener Kurs-/Auftragsordner und Fingerprint aus relevanter Konfiguration einschließlich Prompt-/Schemaversion.

**10 · P2 · Checkpoints erkennen beschädigte oder unvollständige Artefakte nicht zuverlässig.**  
Fundstelle: [file_builder.py:43](D:/AntiGravitySoftware/GitWorkspace/elearning/src/course_factory/file_builder.py:43), [orchestrator.py:329](D:/AntiGravitySoftware/GitWorkspace/elearning/src/course_factory/orchestrator.py:329) und 393–405.  
Für Mikroartefakte genügt Dateiexistenz; Übungsverzeichnisse dürfen leer sein. Eine auf `{` gekürzte Quizdatei wurde als fertig übersprungen, Gesamtergebnis erfolgreich. Ein ebenso beschädigter Tagesplan bricht Resume dagegen dauerhaft mit `JSONDecodeError` ab. **Korrektur:** Artefakte parsen und validieren, erwartete Dateien vollständig prüfen, atomar schreiben und beschädigte Einheiten gezielt regenerieren.

**11 · P2 · Die „strikten“ Schemas erzwingen zentrale Kursregeln nicht.**  
Fundstelle: [schemas.py:24](D:/AntiGravitySoftware/GitWorkspace/elearning/src/course_factory/schemas.py:24), Tagesplan 77–80, Quiz 145–148.  
Der Summenvalidator endet mit `pass`; negative UE-Zahlen sind möglich. Acht Tagesplaneinträge müssen weder unterschiedliche Nummern noch passende Kombinationen aus Typ und Agent besitzen. Quiz erlaubt eine statt zehn Fragen. Alle Fälle isoliert reproduziert. Doppelte UE-Nummern kollidieren zusätzlich im Dateisystem. **Korrektur:** ausführbare Modellvalidatoren für Nummerierung, Summen, Agentzuordnung, exakte Quizlänge und eindeutige IDs.

**12 · P1 · Factory-Theoriefolien passen nicht zum Lernplayer.**  
Fundstelle: [app.ts:2512](D:/AntiGravitySoftware/GitWorkspace/elearning/src/server/app.ts:2512), [app.js:3000](D:/AntiGravitySoftware/GitWorkspace/elearning/public/js/app.js:3000).  
Import übernimmt die Factory-Folien unverändert. Diese verwenden `layout_type` und `on_slide_text.heading/bullet_points_or_code`; der Player erwartet `layout`, `title` und `bullets`. Normal importierte Theorieeinheiten erscheinen deshalb mit generischen Titeln und fehlendem Inhalt. **Korrektur:** gemeinsames kanonisches Format oder explizit getesteter Importadapter einschließlich Diagrammen, Code und Sprechertext.

**13 · P1 · Factory-Praxisübungen verlieren Starterdateien und Lösungen beim Import.**  
Fundstelle: [app.ts:2519](D:/AntiGravitySoftware/GitWorkspace/elearning/src/server/app.ts:2519), Payload 2539–2548; [index.html:214](D:/AntiGravitySoftware/GitWorkspace/elearning/public/index.html:214).  
Es wird nur die Aufgabenbeschreibung importiert. Boilerplate, Lösung und Kriterien fehlen anschließend im Lektionspayload. Der Schülerbereich besitzt auch keinen entsprechenden Praxisrenderer. Das im Handbuch beschriebene Praxis-Terminal mit Musterlösung ist damit nicht umgesetzt. **Korrektur:** Übungsartefakte strukturiert übernehmen und im Lernportal zugänglich machen; Lösungen kontrolliert freigeben.

**14 · P2 · Factory-Import erstellt keinen Tutorindex.**  
Fundstelle: [app.ts:2451](D:/AntiGravitySoftware/GitWorkspace/elearning/src/server/app.ts:2451), Tutor-Leerfall 1504–1508.  
Der Import schreibt Kurse/Module/Lektionen, aber keine Embeddings. Ein regulär importierter Kurs kann daher vom Tutor nicht erschlossen werden. Der angebotene Ausweg über Wizard-Schritt 2 erzeugt Inhalte neu. **Korrektur:** vorhandene Importinhalte indexieren, ohne sie zu überschreiben.

**15 · P2 · Stiller Wechsel des Embeddingmodells beschädigt die semantische Suche.**  
Fundstelle: [main.py:143](D:/AntiGravitySoftware/GitWorkspace/elearning/src/ai_service/main.py:143), 165–167 und 103–111.  
Bei externen API-Fehlern werden lokale MiniLM-Embeddings erzeugt und auf 1536 Dimensionen aufgefüllt. Gleiche Vektorlänge bedeutet nicht denselben semantischen Raum. Ein Index mit Providervektoren und Abfragen aus dem lokalen Modell liefert keine verlässlich vergleichbaren Ähnlichkeiten. **Korrektur:** Modell/Version am Index festlegen; bei Wechsel vollständig neu indexieren oder getrennte Indizes verwenden.

### Medien und Workflows

**16 · P1 · Erfolgreiche MiniMax-Antworten werden falsch ausgelesen.**  
Fundstelle: [activities.ts:251](D:/AntiGravitySoftware/GitWorkspace/elearning/src/temporal/activities.ts:251).  
Der Code erwartet `data.audio.audio` auf der Responsevariablen. Die HTTP-Antwort enthält `data.audio`, also im Code `data.data.audio`. Mit einer erfolgreichen Antwort im dokumentierten Format getestet: keine Audiodatei geschrieben, stattdessen Demo-MP4 gespeichert. **Korrektur:** Antwortschema validieren und richtigen Feldpfad lesen. Quelle: [MiniMax HTTP-TTS-Dokumentation](https://platform.minimax.io/docs/api-reference/speech-t2a-http).

**17 · P1 · TTS-Fehler führen trotzdem zur Freigabebereitschaft.**  
Fundstelle: [activities.ts:293](D:/AntiGravitySoftware/GitWorkspace/elearning/src/temporal/activities.ts:293), MiniMax-Catch 259; [workflows.ts:85](D:/AntiGravitySoftware/GitWorkspace/elearning/src/temporal/workflows.ts:85).  
API-Fehler werden abgefangen und durch ein fremdes Demo-Video ersetzt. Der Workflow bekommt Erfolg und setzt den Kurs auf `pending_approval`. HTTP 429 isoliert reproduziert. Auch der andere TTS-Pfad schreibt bei fehlendem Schlüssel eine leere MP3 und gibt deren URL zurück (`tts.ts:30`). **Korrektur:** Fehler weiterreichen; expliziter Demomodus separat kennzeichnen; Medien erst nach erfolgreicher Validierung als bereit markieren.

**18 · P1 · Echte HeyGen-Jobs sind nicht korrekt mit ihrem Workflow verknüpft.**  
Fundstelle: [activities.ts:342](D:/AntiGravitySoftware/GitWorkspace/elearning/src/temporal/activities.ts:342), [app.ts:1395](D:/AntiGravitySoftware/GitWorkspace/elearning/src/server/app.ts:1395).  
Die echte Generate-Antwort wird nicht ausgelesen, eine lokale Zufalls-ID wird als Video-ID zurückgegeben. Es fehlt eine gespeicherte Zuordnung zur Provider-ID und eine geeignete Callback-Korrelation. Der Handler erwartet das selbst definierte Mockformat mit `course_id/status/video_url`; die offizielle Webhook-Struktur verwendet Ereignistyp und `event_data`. **Korrektur:** gewählte API-Version durchgehend implementieren, Provider-ID speichern und Callback auf den passenden Kursjob abbilden. Kein Live-HeyGen-Test. Quelle: [HeyGen Webhook Events](https://developers.heygen.com/docs/webhook-events).

**19 · P2 · Avatarvideo der ersten Lektion überschreibt alle Lektionen.**  
Fundstelle: [activities.ts:315](D:/AntiGravitySoftware/GitWorkspace/elearning/src/temporal/activities.ts:315), 392–398.  
Es wird nur für die erste Lektion ein Avatarvideo angefordert. Beim erfolgreichen Callback schreibt `setCourseStatus` dessen URL in sämtliche Kurslektionen. Dadurch spielen unterschiedliche Lektionen dasselbe Video und verlieren ihre eigenen Medien-URLs. **Korrektur:** Video pro Lektion zuordnen oder ein separates Kursintro speichern.

**20 · P2 · Abbruch stoppt Wizard-Schritt 2 nicht.**  
Fundstelle: [app.ts:1320](D:/AntiGravitySoftware/GitWorkspace/elearning/src/server/app.ts:1320), Hintergrundarbeit 1040–1101.  
Cancel beendet nur einen Temporal-Workflow. Die Inhaltsgenerierung läuft jedoch als unabhängige asynchrone Funktion im Expressprozess. Sie verursacht nach Abbruch weitere Modellaufrufe und kann den Fehlerstatus wieder mit `content_draft` überschreiben. **Korrektur:** Arbeit verwaltet ausführen und Abbruch an API-Aufrufe sowie Schleifen weitergeben.

### Lernzeit, Oberfläche und Datenkonsistenz

**21 · P1 · Beliebige Lernzeiten werden als verifiziert akzeptiert.**  
Fundstelle: [app.ts:1420](D:/AntiGravitySoftware/GitWorkspace/elearning/src/server/app.ts:1420).  
Nur Vorhandensein von Session und Dauer wird geprüft. Keine Bindung an serverseitig verstrichene Zeit, keine wirksame Session-Eigentümerprüfung und keine geeignete Replaybegrenzung. `999999` Sekunden wurden im Test sofort gespeichert und als gültige Kette bewertet. **Korrektur:** serverseitig erzeugte Sessions, Eigentümerbindung und zeitlich begrenzte, idempotente Heartbeats. Ein Hash belegt keine tatsächliche Lernaktivität.

**22 · P2 · Gleichzeitige Heartbeats beschädigen die Kette.**  
Fundstelle: [timeTracking.ts:16](D:/AntiGravitySoftware/GitWorkspace/elearning/src/server/timeTracking.ts:16).  
Letzten Hash lesen und neuen Datensatz schreiben sind nicht serialisiert. Zwei parallele Requests können denselben Vorgänger verwenden. Test mit echten Funktionen: zwei gespeicherte Einträge, danach `valid:false, tamperedIndex:1`. **Korrektur:** je Session serialisieren und eindeutige Sequenznummern verwenden.

**23 · P1 · Hashprüfung erkennt wichtige Datenmanipulationen nicht.**  
Fundstelle: [timeTracking.ts:31](D:/AntiGravitySoftware/GitWorkspace/elearning/src/server/timeTracking.ts:31), leerer Verlauf 65–70.  
`userId` fehlt im Hash. Eine andere Nutzerzuordnung bleibt gültig; eine vollständig gelöschte/unbekannte Session ebenfalls. Beide Fälle reproduziert. Ohne unabhängigen Abschlusswert ist auch das Abschneiden des Endes nicht erkennbar. **Korrektur:** relevante Identitätsfelder einbeziehen, Sessionexistenz prüfen und manipulationsgeschützte Abschlussnachweise vorsehen. Die aktuelle Prüfung rechtfertigt die Aussage „manipulationssichere Lernzeit“ nicht.

**24 · P2 · Normales Video-/Audiozuschauen zählt nach 20 Sekunden nicht mehr.**  
Fundstelle: [app.js:697](D:/AntiGravitySoftware/GitWorkspace/elearning/public/js/app.js:697), Aktivitätserfassung 197–204.  
Nur Maus, Tastatur und Scrollen aktualisieren Aktivität. Bei laufender Wiedergabe ohne Eingabe werden Heartbeats deshalb eingestellt. **Korrektur:** legitime Medienwiedergabe in das Aktivitätsmodell aufnehmen; auch dies allein beweist keine Aufmerksamkeit.

**25 · P2 · Fehlgeschlagene Generierung erscheint als „Fertig“.**  
Fundstelle: [app.js:2312](D:/AntiGravitySoftware/GitWorkspace/elearning/public/js/app.js:2312), weiterer Pfad 2229; Fehlerstatus im Backend 1103.  
`percent >= 80` wird vor `status === 'failed'` als Erfolg bewertet. Der Backend-Fehlerpfad setzt 100 Prozent. Der Client beendet daher Polling und schaltet Weiter frei. Isoliert mit `failed/100` bestätigt. **Korrektur:** Status als maßgeblich behandeln, Fehler zuerst auswerten.

**26 · P2 · Inspector zeigt nur Dateien namens main.py.**  
Fundstelle: [inspector.html:912](D:/AntiGravitySoftware/GitWorkspace/elearning/public/inspector.html:912), 918.  
Die API liefert frei benannte Dateien, die UI greift fest auf `main.py` zu. Andere Pythondateien, JavaScript, SQL oder Dockerfiles erscheinen als fehlend. **Korrektur:** alle Artefakte mit Dateiauswahl und passender Sprachdarstellung anzeigen.

**27 · P2 · Fehlgeschlagene Curriculum-Neugenerierung kann alte Inhalte löschen.**  
Fundstelle: [app.ts:935](D:/AntiGravitySoftware/GitWorkspace/elearning/src/server/app.ts:935).  
Alte Module werden vor der Transaktion gelöscht. Scheitert später ein Insert, sind die alten Lektionen und abhängigen Daten trotzdem weg. **Korrektur:** Antwort zuerst validieren und Löschen sowie Ersetzen gemeinsam in einer Transaktion ausführen.

**28 · P2 · Globale Adminbearbeitung schreibt Daten in den falschen Mandanten.**  
Fundstelle: [app.ts:1090](D:/AntiGravitySoftware/GitWorkspace/elearning/src/server/app.ts:1090), zusätzlich 951.  
Admins sehen ausdrücklich mandantenübergreifend Kurse. Beim Bearbeiten eines fremden Kurses werden Lessons/Embeddings teilweise mit `user.tenantId` statt `course.tenantId` gespeichert. Der eigentliche Mandant kann diese Inhalte anschließend nicht korrekt per Tutor finden. **Korrektur:** den Mandanten des geprüften Kursobjekts konsistent verwenden.

**29 · P2 · Tutor erlaubt Zugriff vor Kursfreigabe.**  
Fundstelle: [app.ts:1455](D:/AntiGravitySoftware/GitWorkspace/elearning/src/server/app.ts:1455).  
Der Tutorfilter prüft Mandant und Kurs-ID, aber nicht die beim Kursdetail vorgeschriebene Freigabe. Ein Schüler mit bekannter Entwurfs-ID kann bereits indexierte Inhalte abfragen. **Korrektur:** dieselbe Kursberechtigungsprüfung vor Retrieval anwenden.

### Tests, Migrationen und Konfiguration

**30 · P2 · Tests können trotz kaputter API erfolgreich sein und Benutzerprompts überschreiben.**  
Fundstelle: [backend.test.ts:492](D:/AntiGravitySoftware/GitWorkspace/elearning/tests/backend.test.ts:492), [test_prompt_manager.py:42](D:/AntiGravitySoftware/GitWorkspace/elearning/tests/test_prompt_manager.py:42).  
Backendtests fangen auch fehlgeschlagene HTTP-Assertions ab und ersetzen sie durch einen direkten DB-/Mocktest. Im Offlinepfad werden RLS und Hashkette nachimplementiert statt an Produktivfunktionen geprüft. Der Prompttest schreibt außerdem in echte Konfiguration und setzt auf Factorydefaults zurück; vorhandene Anpassungen gehen verloren. **Korrektur:** Unit-/Integrationstests trennen, echte Fehler durchreichen, ausschließlich isolierte Testverzeichnisse/-datenbanken benutzen. Die Reviewausführung hat diese Schreibgefahr durch Umleitung vermieden.

**31 · P1 · Das Migrationsjournal referenziert eine nicht versionierte SQL-Datei.**  
Fundstelle: [\_journal.json:23](D:/AntiGravitySoftware/GitWorkspace/elearning/drizzle/meta/_journal.json:23), `.gitignore` für `drizzle/*.sql`.  
Das geänderte Journal verweist auf `0002_careless_mantis.sql`. Diese Datei existiert lokal, ist laut `git ls-files drizzle` aber nicht versioniert und wird ignoriert. Wird der aktuelle Journalstand ohne die SQL-Datei weitergegeben, bricht Migration in einem frischen Checkout ab. **Korrektur:** zusammengehörige Migrationen samt Journal versionieren; Generierung/Anwendung in einem frischen Testcheckout prüfen. Der bestehende lokale Checkout hat die Datei und ist von diesem konkreten Fehlerszenario nicht betroffen.

**32 · P2 · Zentrale Curriculum-Prompts gelten nicht für alle angebotenen Formate.**  
Fundstelle: [main.py:365](D:/AntiGravitySoftware/GitWorkspace/elearning/src/ai_service/main.py:365).  
`1_hour` und `1_day` verwenden fest eingebaute Prompts; nur andere Dauern rufen `get_prompt("curriculum_generation")` auf. Änderungen im zentralen Editor wirken somit für diese Formate nicht. **Korrektur:** dieselbe Vorlage benutzen und Dauer-/Strukturregeln als Parameter ergänzen; Overrides transparent darstellen.

## Bewertung der integrierten Prompts

**Die Grundstruktur ist sinnvoll, die aktuelle Umsetzung reicht für zuverlässige und fachlich überprüfte Kurse nicht aus.** Das ist eine begründete Einschätzung aus Promptinhalt, Übergabedaten und den oben nachgewiesenen Validierungslücken; kein Vergleich realer Modellleistungen.

| Prompt | Was sinnvoll ist | Was konkret fehlt oder angepasst werden sollte |
|---|---|---|
| macro_curriculum | Zerlegung in Wochen/Tage, Zielgruppe, Meilensteine | Voraussetzungen, überprüfbare Lernziele, explizite Zeit-/Tagesvalidierung und stabile IDs; vollständiges Zielschema |
| meso_day_plan | Acht UEs, Mischung aus Theorie/Praxis/Assessment, klare Agentzuordnung | Vorwissen und bisher vermittelte Inhalte weitergeben; Nummern, Verteilung und Routing im Code erzwingen |
| video_script | Trennung zwischen visueller Folie und gesprochenem Text, direkte Ansprache | Vortrags- und Aktivitätsbudget, Wortumfang, maschinenlesbare Visuals. 5–7 Wörter sind als Gestaltungsleitlinie vertretbar, als starre Regel für jede technische Folie zu eng |
| coding_exercise | Startercode, Musterlösung und Akzeptanzkriterien getrennt | Zielruntime, Abhängigkeiten, Start-/Testbefehle, ausführbare Prüfungen, sichere Dateipfade und Bezug zu vorherigen Übungen |
| quiz | Vier Optionen, eine richtige Antwort, plausible Distraktoren, Erklärungen | Bezug zum tatsächlich vermittelten Material; exakt zehn eindeutige Fragen validieren; Lösungsschlüssel fachlich prüfen |
| curriculum_generation | Kursthema und grobe Dauer | Klare Mengen-/Minutenvorgaben, Zielgruppe und gewünschte Kompetenzen; keine Umgehung durch Kurzformat-Sonderpfade |
| lesson_generation | Verständliche, praxisbezogene Trainerrolle | Enthält praktisch nur Kurs-, Modul- und Lektionstitel. Übergeordnete Beschreibung, Lernziele, Vorwissen, Lernzeit und Übungskontext müssen beim Aufruf mitkommen |
| slide_narration | Konkrete Ausgabeform, natürliche Sprache, 80–160 Wörter | Bei nicht lesbaren Bildern Unsicherheit ausgeben; nichts erfinden; Folieninhalt als Daten behandeln; Länge an vorhandenes Zeitbudget koppeln |

Zusätzlich existiert ein **fest eingebauter Tutor-Prompt** in `app.ts:1513` und `main.py:466`. Er fordert kursbasiertes Antworten, trennt aber Kontext/Frage nur textuell. Vertrauenswürdige Regeln gehören in die Systemnachricht; Kursmaterial sollte ausdrücklich als untrusted Daten behandelt werden. Fehlende Belege sollen zu einer klaren Wissensgrenze führen. Quellen-/Lektionsreferenzen in Antworten erleichtern fachliche Kontrolle. Ein konkreter erfolgreicher Prompt-Injection-Angriff wurde hier nicht getestet; die fehlende Abgrenzung ist ein Verbesserungsbedarf.

### Konkrete Auffälligkeiten vorhandener Kursausgaben

Die vorhandenen Dateien sind erkennbare Beispiel-/Mockinhalte. Sie beweisen nicht die Qualität eines bestimmten Live-Modells; durch Befund 08 können solche Inhalte jedoch auch als Ergebnis eines Liveauftrags gespeichert werden.

- Die drei Theorieeinheiten unter `course_output/week_1/day_1/ue_1_theory` bis `ue_3_theory` deklarieren jeweils **12 Minuten** Video und enthalten jeweils nur **159 Sprecherwörter**. Das entspricht rechnerisch 13,25 Wörtern pro deklarierter Minute. Die Zeitangabe ist durch diesen kurzen Text nicht plausibel belegt.
- Das Quiz enthält generische Optionen wie „Primäre Option und etablierter Standard“. Eine Frage nach einer Pydantic-Methode hat keine Methodenbezeichnung als Antwortoption.
- Die vier Praxisübungen wiederholen dieselbe JSON-Parser-Musterlösung. Unterschiedliche Titel ergeben noch keine didaktische Progression.
- Die geforderten „lauffähigen/getesteten“ Lösungen werden nicht automatisch ausgeführt und gegen echte Tests geprüft. Textuelle `validation_criteria` ersetzen diese Prüfung nicht.

### Sinnvolle gemeinsame Promptvorgaben

Als Ausgangspunkt für eine spätere Überarbeitung, nicht als bereits implementierte Lösung:

1. **Gemeinsamer Kontext:** Zielgruppe, konkrete Voraussetzungen, prüfbare Lernziele, bereits behandelte Inhalte, verfügbare Projektdateien, erlaubte Technologien und deren Versionen.
2. **Explizites Schema:** zentral aus dem Datenmodell ableiten und dem Modell wirklich übergeben. Pflichtregeln danach deterministisch prüfen.
3. **Zeitbudget:** beispielsweise 12 Minuten Vortrag, 25 Minuten angeleitete Anwendung, 8 Minuten Reflexion für eine 45-Minuten-Theorie-UE. Verteilung fachlich passend wählen und rechnerisch validieren.
4. **Fachliche Verlässlichkeit:** belegpflichtige/veränderliche Aussagen mit Quellen oder Verifikationsbedarf versehen; keine erfundenen APIs, Methoden oder Ausführungsergebnisse.
5. **Übungen:** Installations-/Startbefehle, sichere relative Dateipfade, mehrere konkrete Testfälle und eindeutige Abnahmekriterien.
6. **Assessment:** Fragen aus den tatsächlich vermittelten Lernzielen ableiten; Distraktoren fachlich prüfen; Umfang und ID-Eindeutigkeit automatisch validieren.
7. **Erfolgskriterium:** ungültige oder ungeprüfte Ausgabe bleibt Entwurf/Fehler. Ein Prompt allein kann weder Codekorrektheit noch didaktische Qualität garantieren.

## Dokumentation und zusätzliche Risiken

- `BENUTZERHANDBUCH.md` bezeichnet das System als produktionsreif. Die Sicherheits-, Import- und Zeitnachweisfehler widersprechen diesem Status.
- Praxis-Terminal, Code-Sandbox und Lösungs-Diff sind dokumentiert, im Teilnehmerfrontend aber nicht umgesetzt. Curriculumeditor-Hinzufügen/Löschen/Umordnen wird ebenfalls stärker beschrieben als implementiert.
- Das Handbuch nennt stellenweise Ports 3000/8000/5432, README/Launcher dagegen 3010/8085/5439. Konfiguration und Startanleitung müssen konsistent sein.
- Heartbeats laufen im Frontend alle zehn Sekunden; das Handbuch nennt 30 Sekunden.
- Die dokumentierte „manipulationssichere“ Lernzeit ist technisch nicht nachgewiesen. Eine rechtliche oder zertifizierungsbezogene Eignungsprüfung war nicht Teil dieses Reviews.
- npm-Audit meldet unter anderem Drizzle, Officeparser/PDF.js, Browserslist, fast-uri, qs und uuid. Advisories sind Anlass zur Versions-/Erreichbarkeitsprüfung; insbesondere der im Projekt verwendete uuid-v4-Pfad ist dadurch nicht automatisch als ausnutzbar bewiesen. Kein blindes `audit fix --force`: angebotene Änderungen enthalten inkompatible Versionswechsel beziehungsweise ein Officeparser-Downgrade. Quellen: [Drizzle-Advisory](https://github.com/advisories/GHSA-gpj5-g38j-94v9), [PDF.js-Advisory](https://github.com/advisories/GHSA-hq66-cqwq-w95j).
- Weiter zu prüfen: `config.py:9` lädt bei jedem Getter `.env` mit `override=True`; dadurch kann eine zuvor programmgesteuert gesetzte Providerwahl überschrieben werden. Konkrete Wirkung hängt von der Umgebung ab und wurde nicht als reproduzierter Hauptbefund gezählt.
- Weitere Robustheitslücken: Factory-Prozessstart ohne ChildProcess-`error`-Handler; langlaufende Medien-/Express-Hintergrundjobs ohne persistente Wiederaufnahme; Produktions-Dockerfile und reale Windows-PowerPoint-Konvertierung nicht end-to-end validiert.

## Empfohlene Behebungsreihenfolge

1. **Zugriff absichern:** Anmeldung, Admin-/Mandantenrechte, öffentliche Factory-Routen, Promptpfade und HTML-Ausgabe.
2. **Erfolg wahrheitsgemäß machen:** keine stillen Mock-Fallbacks, Mediafehler weitergeben, UI-Fehlerzustände und Abbruch korrigieren.
3. **Datenverträge schließen:** vollständige Schemas, inhaltlich geprüfte Checkpoints und Importadapter für Folien/Übungen/Tutorindex.
4. **Lernzeit neu absichern:** serverseitige Sessionlogik, Parallelität, Identitätsbindung und ehrliche Aussagekraft des Nachweises.
5. **Prompts didaktisch überarbeiten:** Kontext, Zeitbudget, prüfbare Übungen und inhaltsgebundene Quizze; anschließend echte Modelloutputs gegen fachliche Kriterien bewerten.
6. **Regression absichern:** isolierte negative Tests für die gefundenen Fehler sowie vollständiger Testkurs durch Import, Lernen, Tutor, Medien und Wiederaufnahme; Migrationen und Abhängigkeiten konsolidieren.
