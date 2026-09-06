# Dritte lokale Sicherheitsprüfung vom 7. September 2026

Ausgangsstand: `2522563ed049934dd9841f423ecd54a491d9b17c` auf `main`.
Fortsetzung der Sicherheitsprüfung mit ausschließlich lokalen, synthetischen
Tests. Bestehende Live-Dienste und ihre Daten wurden nicht verändert.

## Reproduzierte Fehler und Korrekturen

### TOTP-Einrichtung bei gleichzeitig geänderten Zugangsdaten

Eine verzögerte Passwortprüfung konnte nach einem inzwischen abgeschlossenen
TOTP-Enrollment dessen Secret ersetzen und den Einrichtungsstatus zurücksetzen.
Auch zwischenzeitlicher Passwortreset, Kontosperre oder Wechsel auf ausschließliche
Hardwareanmeldung waren nicht an alle nachfolgenden Schreib- und Ausgabeschritte
gebunden. Die Bestätigung hatte eine weitere Lücke während des Hashens der
Recovery-Codes.

Der Ablauf bindet erneutes Lesen, Setup-Claim, QR-Ausgabe und Enrollment-Claim
an den geprüften Passwort-Hash, die Auth-Revision und den weiterhin zulässigen
Konto-/Faktorstand. Neue Secrets werden nur in einen noch offenen, unveränderten
Setupzustand geschrieben. Die Regressionen führen die echten öffentlichen
Actions mit kontrollierten Zustandswechseln aus. Der erste Nachweis enthielt
sechs vor der Korrektur rote Sicherheitsfälle und einen grünen Normalfall;
die finale gezielte Staff-Suite besteht mit 99 Fällen, darunter 13 in der
neuen Race-Datei. Regel: `ACCESS-TENANT-RLS-001`.

### Vollmacht: ersetzte Links und Signaturcodes

Ein bereits laufender Signaturversuch konnte einen alten Code noch akzeptieren,
obwohl eine parallele Codeanforderung bereits einen neuen Code gespeichert
und versandt hatte. Ebenso konnten eine alte Codeanforderung oder ein alter
Fehlversuch den Zustand eines zwischenzeitlich neu ausgegebenen Links verändern.

Codeausgabe, Fehlversuchsbelastung und Signaturabschluss prüfen ihren jeweils
aktuellen Link-/Codezustand nochmals atomar beim Schreiben. Ablaufzeiten und
Fehlversuchsgrenzen gelten auch nach zwischengeschalteten asynchronen Prüfungen.
Vier Angriffsfälle waren vor der Korrektur rot; anschließend bestehen diese
und der einmalige gültige Abschluss. Die gezielte Suite umfasst 84 bestandene
PoA-, GwG-Lifecycle- und Capability-Fälle. Regel:
`POA-SIGNING-CONFIRMATION-001`. Es ist keine Migration erforderlich.

Dabei wurde eine Dokumentationsabweichung ausdrücklich berichtigt: Die Regel
nannte bislang zehn „Tokenausgaben“, der bestehende Code begrenzt jedoch zehn
**Codeausgaben je Link-Lebenszyklus**. Das Laufzeitlimit wurde nicht geändert.
Die technische Erklärung bleibt ohne Zusage einer AES/QES oder rechtlichen
Wirksamkeit.

### Recherche: Klartext in Zusatzfeldern und falsche Rückzuordnung

Der tatsächliche n8n-Outbound enthielt bekannte Mandantendaten in Normankern
und Governance-Typ im Klartext, obwohl dieselben Angaben im Haupttext bereits
maskiert waren. Unabhängig erzeugte Mappings konnten außerdem Platzhalter
überschreiben: Im Reproduktionsfall wurde der Auftrag zu `beta@example.test`
und `2.000 €` nach der Rückzuordnung fälschlich zu `gamma@example.test` und
`3.000 €`. Eine weitere Regression zeigte wiederholte Ersetzung innerhalb
eines bereits eingesetzten Originals.

Alle ausgehenden Freitextfelder teilen jetzt einen Kontext. Vorschau und
Versand vergeben Platzhalter in gleicher Reihenfolge; bearbeitete Inhalte
ergänzen neue Zuordnungen. Kontakte werden in stabiler Reihenfolge gelesen.
Normanker und Governance-Typ durchlaufen dieselbe Maskierung. Die Rückzuordnung
ersetzt nur die Platzhalter im Antworttext, ohne Originalwerte erneut umzuschreiben.
Das Mapping bleibt ausschließlich im lokalen tenantgebundenen Request.
Alle drei neuen Regressionen waren vorher rot; nachher bestehen sämtliche
111 Risktests. Eine unabhängige Codeprüfung und Wiederholung bestätigten das.
Regel: `RISK-EXTERNAL-ANONYMIZATION-001`.

Die schon zuvor dokumentierte Grenze bleibt bestehen: Die editierbare Vorschau
ist nicht serverseitig an einen unveränderlichen Datenstand gebunden. Änderungen
an Quelle oder Stammdaten erfordern eine neue Vorschau; unbekannte oder nur aus
dem Kontext erkennbare Geheimnisse können weiterhin unmaskiert bleiben.
Die Regel bleibt `partial` und fachlich `unreviewed`.

### ZIP: Datei blockiert ein benötigtes Verzeichnis

Eine Datei `Belege` und eine zweite Datei unter `Belege/2026.pdf` konnten im
selben ZIP stehen. Beim tatsächlichen Entpacken blockierte die erste Datei
die Erstellung des Verzeichnisses; nur ein Dokument wurde geschrieben.

Die Namensvergabe reserviert nun zuerst alle benötigten Verzeichnisse samt
Elternpfaden. Dateinamen und erzeugte Suffixe umgehen diese Reservierungen,
einschließlich Groß-/Kleinschreibung und Unicode-Normalisierung. Sechs neue
GET-Regressionen waren vorher rot; die 21 Download-/ZIP-Fälle bestehen danach,
einschließlich tatsächlicher Extraktion und Prüfung aller Originalbytes.
Die technischen Transportnamen ändern keine gespeicherten Dokumentnamen,
Zugriffsrechte, Versionen oder Aufbewahrung. Ausnahme: `FK-EXC-20260907-001`.

## Prüfnachweise und Grenzen

- **Fünf echte Chromium-Browserfälle bestanden beim ersten Lauf** in
  33,6 Sekunden, ohne Retry oder Skip: TOTP-Einrichtung mit falscher und
  korrekter Bestätigung, falscher Login-Code, gültiger TOTP samt Replay-Sperre,
  einmaliger Recovery-Code sowie vollständiger PDF-Vollmachtablauf.
  Letzterer umfasst Anlegen, Versand, Prüfung der PDF-Bytes, zwei echte
  E-Mail-Codes, Ablehnung des alten Codes, einmalige Signatur, gesperrten
  Link-/Dokumentzugriff und Widerruf über die Benutzeroberfläche.
  Die beiden TOTP-Testausnahmen waren währenddessen deaktiviert.
- Unabhängige Datenbank-Nachkontrolle: eigenes synthetisches ADMIN-Konto
  deaktiviert und TOTP-/Backupgeheimnisse entfernt; eigene Vollmacht
  `REVOKED`, Link und OTP entwertet, Snapshot-/Signaturhashes unverändert,
  genau ein Signatur- und ein Widerrufsaudit. Bestehende Konten und
  Einstellungen blieben unverändert. Alle eigenen Testdienste wurden
  anschließend wieder gestoppt.
- Vollständiger Unit-Lauf ohne Cache: **3817 bestanden**, kein Fehler,
  13 Testpakete, 21 erfolgreiche Turbo-Tasks. Darin sind alle 27 neu
  hinzugekommenen Fälle sowie acht OpenSSL-Differenztests enthalten.
  Neun bewusst ausgelassene Opt-ins (sieben Mandats-DB- und zwei Redis-Fälle)
  werden nicht als bestanden gezählt. Die 13 geänderten Quell-/Testdateien
  blieben während des Laufs nach SHA-256-Vergleich unverändert.
- Beide frischen pnpm-Audits, Produktion und vollständiger Abhängigkeitsgraph:
  keine bekannten Schwachstellen aller Schweregrade gemeldet.
- Gitleaks 8.29.0: alle 612 Commits des Ausgangsstands, 22,79 MB gescannter
  Inhalt, keine Secrets gefunden; vollständiges Protokoll in
  `gitleaks-history.log`.
- Vollständiger Typecheck und ESLint bestanden; keine Fehler, unverändert
  75 bekannte Komplexitätswarnungen. React- und Komplexitätsbaselines bestanden.
- Das Web-Produktionsimage wurde beim ersten Versuch erfolgreich gebaut:
  frische Runner-Stage, 6 GiB Gesamtspeicher, kein Swap. Seine Image-ID ist
  `sha256:fe65a2de037186a8e58ecddd4ab251b91df7f75b699189e339d057b1f61bc0fd`.
  Der lokale HTTPS-Produktionsserver meldet Readiness; beide TOTP-Testausnahmen
  sind ausgeschaltet. Worker-Code und gemeinsam verwendete Pakete wurden in
  dieser Runde nicht geändert; das Worker-Image wurde deshalb nicht neu gebaut.
- Trivy auf exakt diesem Web-Image: CI-Report, Critical-Gate, vollständiger
  Scan ohne `ignore-unfixed` und SBOM jeweils erfolgreich. Keine bekannten
  Schwachstellen aller Schweregrade und keine Secrets gemeldet; CycloneDX 1.7
  mit 145 Komponenten. Die Offline-Probe bestätigte UID 1000, lesbare und
  geschützte Runtime-Dateien, benötigte Assets und `pg_restore` sowie fehlende
  `.env`-Dateien, Paketmanager und TOTP-Ausnahmen im Image.
- Fachkatalog: 80 Regeln aktuell, 33 Katalogregressionen bestanden und
  zehn geänderte Fachpfade konkret zugeordnet. Die fachlichen Reviewfelder
  aller 80 Regeln sind gegenüber dem Ausgangscommit unverändert.

Rohprotokolle und maschinenlesbare Ergebnisse dieses Nachlaufs liegen unter
`%TEMP%\kanzleikonsole-security3-20260907`. Dazu gehören `totp-setup-before.log`,
`auth-*.log`, `poa-otp-before.log`, `poa-*.log`, `research-before.log`,
`research-after.log`, `risk-independent-review.log` und `zip-*.log`.
Browsernachweise stehen unter `browser-smoke`, insbesondere `results.json`,
`totp-evidence.json` und `cleanup-verification.json`. Build- und Imagebelege
heißen `web-build-result.json`, `web-offline-probe.log`,
`web-trivy-result.json` und `web.cdx.json`.
Die gezielten Testzahlen überschneiden sich mit dem späteren vollständigen
Unit-Lauf und werden nicht zu einer künstlich erhöhten Gesamtsumme addiert.

Die neuen Parallelitätsregressionen verwenden echte Actions mit kontrolliertem
Persistenzmodell; sie sind keine Lastmessung einer verteilten Installation.
Der CI-gepinnte Trivy-Scanner 0.71 kennt Alpine 3.24 weiterhin nicht in seiner
EOL-Liste; die OS-Schwachstellenprüfung gegen Repository 3.24 wurde ausgeführt.
Der Prüfumfang umfasst die genannten Anwendungspfade und ist kein Nachweis
vollständiger Sicherheit, kein externer Penetrationstest und keine fachliche
Freigabe. Produktive Empfänger und VPS-Konfigurationen wurden nicht getestet.
