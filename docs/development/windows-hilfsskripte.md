# Windows-Hilfsskripte prüfen

`scripts/setup.ps1` unterstützt Windows PowerShell 5.1 und PowerShell 7. Die
Datei verwendet UTF-8 mit BOM, damit auch Windows PowerShell 5.1 ihre deutschen
Texte und Satzzeichen korrekt einliest. Beim Bearbeiten diese Kodierung erhalten.

Ein Reset entfernt die vorhandene `.env` erst, wenn `docker compose down -v`
erfolgreich abgeschlossen wurde. Scheitert Docker, endet das Setup mit einem
Fehler und erhält die Konfiguration. Ein erfolgreicher Reset bleibt eine
ausdrücklich angeforderte Löschung der lokalen Daten und Konfiguration.

Der Launcher `scripts/win/Start-TaxTronik.ps1` lädt die Docker-Aufrufe aus
`scripts/win/docker-commands.ps1`. Die Befehle erhalten unveränderte Argumente,
einschließlich `-d`; Ausgaben werden angezeigt, während der Rückgabewert allein
der Exitcode ist. Image-Referenzen werden als Argument übergeben, ohne sie durch
eine zusätzliche Shell auszuwerten.

Die Regressionstests laufen ohne Docker-Zugriff mit simulierten Befehlen. Der
Reset-Test kopiert das Setup in ein eigenes temporäres Verzeichnis und prüft
einen fehlgeschlagenen Reset mit einer synthetischen Konfiguration. Beide Tests
jeweils in Windows PowerShell 5.1 und PowerShell 7 aus dem Repository starten:

```powershell
powershell.exe -NoProfile -File scripts/tests/windows-docker-commands.test.ps1
powershell.exe -NoProfile -File scripts/tests/windows-setup-reset.test.ps1
pwsh.exe -NoProfile -File scripts/tests/windows-docker-commands.test.ps1
pwsh.exe -NoProfile -File scripts/tests/windows-setup-reset.test.ps1
```

Diese Tests prüfen Argumentübergabe, Fehlerbehandlung und Skriptkodierung. Einen
vollständigen Windows-Installationslauf mit einer echten Docker-Installation
ersetzen sie nicht.
