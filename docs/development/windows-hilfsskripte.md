# Windows-Hilfsskripte prüfen

`scripts/setup.ps1` unterstützt Windows PowerShell 5.1 und PowerShell 7. Die
Datei verwendet UTF-8 mit BOM, damit auch Windows PowerShell 5.1 ihre deutschen
Texte und Satzzeichen korrekt einliest. Beim Bearbeiten diese Kodierung erhalten.

Ein Reset entfernt die vorhandene `.env` erst, wenn `docker compose down -v`
erfolgreich abgeschlossen wurde. Scheitert Docker, endet das Setup mit einem
Fehler und erhält die Konfiguration. Ein erfolgreicher Reset bleibt eine
ausdrücklich angeforderte Löschung der lokalen Daten und Konfiguration.

`setup.ps1`, `scripts/win/Start-TaxTronik.ps1` und `scripts/win/Start-SignalDev.ps1`
lesen und schreiben die `.env` wie `scripts/setup.sh` über `scripts/env-tool.mjs`:
Werte werden wörtlich als UTF-8 ohne BOM geschrieben und nie über die
Kommandozeile übergeben, Secrets sind base64url. Bekannte Dev-/CI-Defaults
erkennt die Hilfe anhand derselben Liste wie das Prod-Gate von
`@taxtronik/config` (`packages/config/src/dev-default-secrets.json`).
`Start-TaxTronik.ps1` ersetzt sie für `AUTH_SECRET`, `N8N_HMAC_SECRET` und
`N8N_ENCRYPTION_KEY`; für Datenbank-, S3- und n8n-DB-Zugänge, die bereits in
Volumes stehen, und in den übrigen Skripten gibt es nur eine Warnung. Die
Logik prüft `pnpm test:ops` (`scripts/tests/env-tool.test.mjs`); die
PowerShell-Hüllen decken nur die manuellen Tests unten ab.

Der Launcher `scripts/win/Start-TaxTronik.ps1` lädt die Docker-Aufrufe aus
`scripts/win/docker-commands.ps1`. Die Befehle erhalten unveränderte Argumente,
einschließlich `-d`; Ausgaben werden angezeigt, während der Rückgabewert allein
der Exitcode ist. Image-Referenzen werden als Argument übergeben, ohne sie durch
eine zusätzliche Shell auszuwerten.

Seit S-01 verbinden app und worker als `taxtronik_owner`, der Restore-Drill des
Workers als `taxtronik_drill`. Der Launcher erzeugt dafür
`TAXTRONIK_OWNER_PASSWORD` und `TAXTRONIK_DRILL_PASSWORD`, startet Postgres
vorab und führt das idempotente Init-Skript (`infra/scripts/postgres-init.sh`)
im Container erneut aus, damit auch ein bestehendes Volume beide Rollen
erhält. Die Grants vergibt danach der `migrate`-Service. Manuelle Abnahme auf
Windows: zweiter Start mit vorhandenem Volume, danach meldet
`docker exec taxtronik-postgres psql -U taxtronik -d taxtronik -c "\du"` beide
Rollen ohne Superuser-Attribut, und der Login funktioniert.

Die Regressionstests laufen ohne Docker-Zugriff mit simulierten Befehlen. Der
Reset-Test kopiert das Setup in ein eigenes temporäres Verzeichnis und prüft
einen fehlgeschlagenen Reset mit einer synthetischen Konfiguration. Der
Parser-Test liest alle PowerShell-Skripte unter `scripts/` mit dem
PowerShell-Parser ein, ohne sie auszuführen. Die Tests jeweils in Windows
PowerShell 5.1 und PowerShell 7 aus dem Repository starten:

```powershell
powershell.exe -NoProfile -File scripts/tests/windows-docker-commands.test.ps1
powershell.exe -NoProfile -File scripts/tests/windows-setup-reset.test.ps1
powershell.exe -NoProfile -File scripts/tests/windows-scripts-parse.test.ps1
pwsh.exe -NoProfile -File scripts/tests/windows-docker-commands.test.ps1
pwsh.exe -NoProfile -File scripts/tests/windows-setup-reset.test.ps1
pwsh.exe -NoProfile -File scripts/tests/windows-scripts-parse.test.ps1
```

Im CI-Job `quality` laufen alle `scripts/tests/*.test.ps1` mit PowerShell 7
unter Linux; das Release-Archiv ist mit Version und SHA-256 gepinnt
(`.forgejo/workflows/ci.yml`, Schritt „PowerShell installieren“). Windows
PowerShell 5.1 bleibt eine manuelle Prüfung auf Windows.

Diese Tests prüfen Argumentübergabe, Fehlerbehandlung und Skriptkodierung. Einen
vollständigen Windows-Installationslauf mit einer echten Docker-Installation
ersetzen sie nicht.
