# Quellcodeprüfung vom 1. Oktober 2026

Arbeitsstand: Quellcodeprüfung, Korrekturen und lokale Abschlussprüfungen
sind abgeschlossen. Ausgangspunkt ist Commit
`528e4f87366d9773791a7676f4ccac1cd8418c98`, nach den separat
behobenen Dependency- und Web-Image-Fehlern. Dieser Bericht dokumentiert eine
technische Prüfung, keine fachliche Freigabe oder Softwarebescheinigung.

## Vorgehen und Abdeckung

Vier parallele Arbeitsstränge verbinden Quellcodeinventur, Prüfung konkreter
Aufrufketten, unabhängigen Gegenreview und ausführbare Nachweise. Authentifizierung
und Rechte, fachliche Abläufe, Datenintegrität und externe Ein-/Ausgabe sowie
CI/Deployment wurden getrennt untersucht und an ihren Schnittstellen erneut
zusammengeführt. Bestätigte Fehler wurden mit Regressionen korrigiert;
vermutete Probleme ohne belegten Ablauf gelten nicht als bestätigte Befunde.

| Bereich                     | Tatsächlich untersuchte Schwerpunkte                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Anmeldung und Zugriff       | Passwort/TOTP/Backup-Codes, WebAuthn, Session-Revisionen, Magic-Links, Portalprofile, RLS/RBAC, API- und Action-Inventur, Mandanten-/Modulrechte, Browser-Speicher, RSS-Eigentum                       |
| Dokumente und Kommunikation | Uploadjournal, Scanstatus, konkrete S3-Versionen, Downloads/Preview, Vollmacht-Snapshots, Rechnungsexporte, Inbox-Anlagen, Mailbox-Import, SMTP, HTTP-/DNS-/Redirect-Grenzen                           |
| Fachliche Abläufe           | BWA-Parser/Projektion, Rechnungsberechnung/Archiv/Versand, Fristen, GwG-Nachweise, StBVV-Rechenkern, Risk-Archiv und alle produktiven Writer, DSGVO-Anonymisierung                                     |
| Formulare und Personal      | Antwortvalidierung, eingefrorene Fragenstände, Revisionsdownloads, Arbeitnehmer-Capabilities, Arbeitgeber-RLS, Uploadabschluss, geprüfte PDF-/ZIP-Revisionen, technische DATEV-Sperre                  |
| Workflows                   | Claims, Transaktionsgrenzen, externe Mail-/n8n-Zustellung, dauerhafte Wiederaufnahme, expliziter Abschluss, Jahresend-Rückfragen, Feedback-Sperren                                                     |
| Audit und Wiederherstellung | Hashkette, Archiv-Wiederaufnahme, TSA-Transport, BackupRecord-Bindung, Restore-Zielschutz, private Laufdateien, reale Queue-/Backup-/Restore-Ausführung                                                |
| Betrieb und Lieferkette     | CI-Aufrufe, frische Linux-Installation, Versions-/Hook-Guards, Docker-/Compose-Verträge, signierte Updates, Release-Manifeste, Migrationen, historischer Upgradepfad, RLS, Secret- und Dependency-Scan |

Das ist eine Prüfung über das gesamte Repository mit vertieftem Review der
genannten Abläufe. Es ist kein Nachweis, dass jede Quellcodezeile manuell
bewertet wurde oder sämtliche Fehler ausgeschlossen sind. Die technische
Testabdeckung und die verbleibenden Grenzen sind getrennt aufgeführt.

## Bestätigte Befunde und Korrekturen

| Priorität | Auslöser und vorheriges Verhalten                                                                                                                                                                                                                                                | Korrektur und Regelbezug                                                                                                                                                                                                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1        | Bekanntes Passwort, wechselnde IPs und wiederholter Passwort-Precheck setzten die Sperre vor weiteren falschen TOTP-Versuchen zurück.                                                                                                                                            | Eigenes kontogebundenes Budget für TOTP und Backup-Codes, erst nach vollständig erfolgreicher Anmeldung zurückgesetzt. `ACCESS-TENANT-RLS-001`.                                                                                                                                                                       |
| P2        | Magic-Link-Vorschau und reguläre Bestätigung umgingen das Budget des alternativen Auth-Callbacks.                                                                                                                                                                                | Gemeinsames Verifikationsbudget und separates Vorschau-Limit an den wirklichen Einstiegspunkten. `ACCESS-TENANT-RLS-001`.                                                                                                                                                                                             |
| P2        | Gespeicherte Filter zeigten nach Kontowechsel Namen und Suchbegriffe des vorherigen Nutzers; persönliche RSS-Aktionen akzeptierten Feed-IDs anderer Mitarbeiter desselben Tenants.                                                                                               | Browserdaten an Tenant/Mitarbeiter gebunden, unzuordenbare Altdaten verworfen, RSS-Mutationen an Eigentümer gebunden. `ACCESS-SEARCH-SCOPE-001`, `ACCESS-TENANT-RLS-001`.                                                                                                                                             |
| P1        | Mehrere Dokumentleser ignorierten die gespeicherte S3-Version; alternative Downloads übersprangen den aktuellen Scanabschluss.                                                                                                                                                   | Konkrete Version an alle betroffenen Leser weitergegeben, kein Fallback bei fehlender ausdrücklich gebundener Version; gemeinsame Bereitschaftsprüfung für Vollmacht, Inbox und Wissensanlage. `DOC-VERSION-IMMUTABILITY-001`, `DOC-PORTAL-SHARING-001`, `POA-SIGNING-SNAPSHOT-001`, `INV-ARCHIVE-EINVOICE-001`.      |
| P1        | Der automatische Drill führte einen aus S3 geladenen Dump als DB-Owner aus, bevor sein Hash geprüft wurde.                                                                                                                                                                       | Genau eine private, größen- und hashgeprüfte lokale Kopie vor DB-Anlage/Prozessstart; getrennte Lauf-DB und Cleanup. Neuer ungeprüfter Entwurf `BACKUP-DRILL-INTEGRITY-001`.                                                                                                                                          |
| P1/P2     | Auditrotation prüfte weder die zu archivierende Kette noch den Inhalt eines bereits existierenden Recovery-Objekts.                                                                                                                                                              | Kettenprüfung vor Upload, bedingter PUT, exakter Größen-/Hashvergleich des Recovery-Streams. Der bisherige Widerspruch zwischen Code und `AUDIT-ARCHIVE-001` ist in der Regel dokumentiert.                                                                                                                           |
| P1        | Gleichzeitige Archivierung und Mutation konnten einen anderen Live-Stand als den S3-Archivinhalt festschreiben; verspätete Analyseergebnisse konnten archivierte Daten verändern.                                                                                                | Parent-Sperren, Vergleich des vollständigen Archivstands vor Commit, eindeutiger Uploadkey, DB-Backstop und erneute Quellenprüfung um externe Verarbeitung. `RISK-ARCHIVE-SNAPSHOT-001`, `RISK-AI-SUGGESTION-001`, `DSGVO-MANDATE-ANONYMIZATION-001`.                                                                 |
| P2        | Addison ordnete beliebige Dreimonatszeiträume demselben Kalenderquartal zu; ungültige/rückwärts laufende Perioden wurden normalisiert; DATEV-Leertext erschien als Nullbetrag.                                                                                                   | Echte Quartalsgrenzen verlangen, sonst tatsächlichen Zeitraum erhalten; ungültige Grenzen ablehnen; fehlende Werte von Null unterscheiden. `BWA-IMPORT-MAPPING-001`.                                                                                                                                                  |
| P1/P2     | GwG-Entscheidung verglich den Ausweisablauf mit dem UTC-Tag, während Regel und Ablaufworker den Berliner Kalendertag verwenden.                                                                                                                                                  | Gemeinsamer Berliner Datumshelper mit Sommer-/Winter-Mitternachtsregressionen. `GWG-IDENTIFICATION-EVIDENCE-001`.                                                                                                                                                                                                     |
| P2        | TSA-Fehler ließen ungelesene Bodies offen; n8n las beliebig große Fehlerantworten vor der Kürzung; Restore-Downloads nutzten vorhersagbare temporäre Dateien.                                                                                                                    | Request-/Body-Abbruch, begrenzte Fehlerdiagnose, private exklusive Laufdateien und Fehler-Cleanup. `AUDIT-RFC3161-ANCHOR-001`.                                                                                                                                                                                        |
| P2        | Der Fachkatalog-Diffguard überwachte katalogreferenzierte Dateien, verweigerte für solche Dateien aber zulässige neutrale Ausnahmeeinträge.                                                                                                                                      | Einheitliche Pfadmenge aus Basis- und Zielkatalog; historische unveränderliche Einträge bleiben auch nach Ausscheiden einer Referenz gültig. `ASSURANCE-PROFESSIONAL-REVIEW-001`.                                                                                                                                     |
| P1/P2     | Fünfzehn Admin-Mutationen einschließlich IBM-Token wurden vor ihrem Audit unabhängig committed. Ein Auditfehler meldete einen Fehlschlag, ließ etwa eine erweiterte Mandantenzugriffsregel aber aktiv.                                                                           | Setting und tatsächlicher Auditdatensatz teilen dieselbe Transaktion; Cache-Invalidierung erst nach Commit. 48 echte PostgreSQL-Tests prüfen Rollback, Erfolg und Rollengrenzen. `ACCESS-CLIENT-MODE-001`, `AUDIT-HASH-CHAIN-001`.                                                                                    |
| P1/P2     | Ein abgelaufener IMAP-Poll konnte nach einem neueren Poll Cursor/Lease überschreiben oder eine bereits importierte Anlage erneut auf CLEAN setzen.                                                                                                                               | Alle Mailboxschreibwege an die konkrete Lease und den Aktivstatus gebunden; Anlagenfreigabe nur aus erlaubten Ausgangszuständen ohne Dokumentbindung. `MAIL-INBOX-001`.                                                                                                                                               |
| P1        | Ein Fristenworker las die alte Konfiguration, eine Action änderte sie und löschte künftige Termine, anschließend stellte der alte Worker die überholten Termine wieder her.                                                                                                      | Materialisierung, Konfigurationswechsel und Änderung der Steuerregion verwenden dieselbe kurze Tenant-Transaktionssperre. Bestehende Termine werden bei Regionswechsel gemäß bestehender UI-Regel nicht neu berechnet. Fünf echte DB-Konkurrenztests. `TAX-DEADLINE-WORKDAY-001`, `TAX-DEADLINE-AUTOREQUEST-001`.     |
| P1        | Positionen ließen sich von einer festgeschriebenen Rechnung auf einen Entwurf umhängen; Positionsänderung und Versand konnten ihren Statuscheck gleichzeitig bestehen.                                                                                                           | Forward-only Migration bindet Positionsidentität und Rechnung unveränderlich und sperrt die Elternrechnung beim Schreiben. `INV-LIFECYCLE-FREEZE-001`.                                                                                                                                                                |
| P2        | Zwei parallele Zahlungsmarkierungen konnten beide auditieren; manuelle Preise/Mengen mit mehr als zwei Nachkommastellen wurden in der Datenbank anders gerundet als berechnet. Zulässige Einzelpositionen konnten zusammen oder einschließlich Steuer die Kopffelder überlaufen. | Atomarer Statusclaim mit Audit nur für den Gewinner; Eingabepräzision und Summenvalidierung entsprechen den Datenbankfeldern. `INV-LIFECYCLE-FREEZE-001`, `INV-VAT-TOTALS-001`.                                                                                                                                       |
| P2        | Gleichzeitige Zahlung und Stornoversand sperrten Originalrechnung und Audit in entgegengesetzter Reihenfolge. Beide Ausführungsreihenfolgen erzeugten im echten PostgreSQL-Test einen Deadlock.                                                                                  | Der Stornoversand sperrt das Original vor seinem ersten Audit. Die tatsächlichen Actions bestehen beide Konkurrenzproben mit echten App-Rollen und Audittransaktionen. `INV-LIFECYCLE-FREEZE-001`.                                                                                                                    |
| P2        | Risk-Exporte mit internationalen Titeln scheiterten an nicht-ASCII-fähigen HTTP-Headern oder einem beim Abschneiden halbierten Unicode-Zeichen.                                                                                                                                  | ASCII-Fallback und UTF-8-Dateiname bleiben getrennt; Begrenzung an Codepoint-Grenzen. Tests erzeugen echte Response-Header für beide Exportformate. `ACCESS-CLIENT-MODE-001`.                                                                                                                                         |
| P2        | Ein zweiter Schema-Driftcheck scheiterte an übrig gebliebenen Funktionen im Schema `app`; Prisma setzte nur `public` zurück.                                                                                                                                                     | Vor dem Reset wird ausschließlich das eigene Shadow-Schema entfernt. URL-Prüfung und tatsächliche Datenbankidentitäten beider Verbindungsseiten verhindern Ziel-/Pooler-Alias-Verwechslungen. CI wiederholt den vollständigen Check. `ASSURANCE-RELEASE-EVIDENCE-001`.                                                |
| P1/P2     | Zwei Abrufe derselben Losziehung konnten Aufgaben und Audit doppelt erzeugen oder den Pending-Zustand einer anderen Ziehung löschen. Gleichzeitige Starts überschrieben sich.                                                                                                    | Kurze Startreservierung vor externer I/O, atomarer Vergleich des gesamten Pending-Stands mit Aufgabenerzeugung und Audit. Unterbrochene Starts bleiben nachvollziehbar gesperrt und erhalten einen auditierten Admin-Recoverypfad, der vorhandene Antworten und Jobbindungen berücksichtigt. `TCMS-SAMPLE-PROOF-001`. |

## Ausführbare Nachweise

Der abschließende Browserlauf deckte zusätzlich einen Fehler im Testwerkzeug
auf: Der Redis-Aufräumhelfer ignorierte die Datenbanknummer aus der URL und
leerte DB 0, obwohl die Anwendung DB 5 verwendete. Absichtlich erzeugte
Login-Sperren blieben dadurch für nachfolgende Fälle aktiv. Der Helfer bestätigt
nun die explizite Datenbankauswahl vor dem Löschen und hat 18 verpflichtende
Node-Regressionen ohne Browserabhängigkeit. Der ungültige Lauf wurde gestoppt.
Die anschließende vollständige Wiederholung mit frischen Daten besteht alle
225 Fälle; Produktlimits wurden nicht gelockert. Der E2E-Workspace ist jetzt
auch in der verpflichtenden Typprüfung enthalten. Die dabei gefundenen
fehlenden Typangaben in vier Browser-Fixtures wurden ergänzt.

Die Linux-Nachweise liefen ausschließlich in eigenen Containern im Netzwerk
`taxtronik-review-20261001` mit synthetischen Testdaten. Bestehende lokale
Abhängigkeiten und Datenbanken wurden dafür nicht gelöscht oder verändert.
Rohprotokolle liegen lokal unter `.codex-run/full-review-20261001/`; sie sind
keine dauerhaft veröffentlichte CI-Attestation.

Abschließender integrierter Stand:

- Frische Installation mit Node 24, pnpm 12.4.1,
  `pnpm install --frozen-lockfile --prod=false`, leerem `node_modules`, eigenem
  leerem Store und aktivierten geprüften Installationshooks.
- **4.371 Unit-Tests erfolgreich**, alle 22 Turbo-Aufgaben bestanden. Die
  dabei bewusst ausgelassenen 70 Servicefälle bestehen separat gegen echte
  PostgreSQL-/Redis-Dienste; darunter 48 Settings- und zwei konkurrierende
  Rechnungs-Action-Fälle. Kein übersprungener Servicefall wird als bestanden
  mitgezählt.
- **472 PostgreSQL-Tests in 62 Dateien erfolgreich**, nach frischer Installation
  und erneut im Upgradepfad von Release `v0.2.1` auf alle 229 Migrationen.
- Zwei vollständige Schema-Driftprüfungen hintereinander, Migration-Ledger und
  RLS-Prüfung aller 140 Tabellen erfolgreich; historische GwG-/Onboarding-
  und bekannte Legacy-Upgradefälle erfolgreich.
- Abschließender vollständiger Playwright-Lauf ohne Dateiliste oder Filter:
  **225 Tests erfolgreich in 7,0 Minuten**, einschließlich Kontowechsel- und
  Saved-Views-Fällen, Zugriffsmatrizen, Parallelität und Barrierefreiheit.
  Ein erster vollständiger Lauf mit ebenfalls 225 erfolgreichen Fällen wurde
  nach den Folgekorrekturen vollständig wiederholt.
- Reale Workerqueues gegen PostgreSQL, Redis und SeaweedFS: Rotation einer
  nichtleeren Kette, idempotenter Wiederholungslauf, Seal, Ablehnung eines
  lokalen als externen Zeitankers, Kettenprüfung, `pg_dump`, S3-Backup und
  `pg_restore`-Drill einschließlich Datei-/DB-Cleanup erfolgreich.
- Deploy-Readiness 10/10 einschließlich Object-Lock, Speicher-Rundlauf,
  EICAR-Erkennung und 25-MiB-Virenscan.
- KoSIT/XRechnung: drei Referenzen mit Mischsätzen, Reverse-Charge und Storno
  als `ACCEPTABLE` validiert.
- Gitleaks über 633 bestehende Commits und zusätzlich den vollständigen
  aktuellen Quellbaum: keine Treffer; Allowlist-Gegenbeispiele
  erfolgreich. Vollständiges Dependency-Audit bis zur Stufe `low`: keine
  bekannten Schwachstellen.
- Root-Lint: keine Fehler, unverändert 66 bestehende Komplexitätswarnungen.
  Komplexitätsbaseline unverändert; keine React-Compiler-Warnungen.
  Alle 23 Typecheck-Aufgaben, Formatprüfung, Dokumentlinks, Supply-Chain-Guards,
  Fachkatalogprüfung und Diff-Gate erfolgreich: 82 Regeln und 105 konkret
  zugeordnete Änderungen an fachlich erfassten Pfaden.
- Ops-/Release-/Docker- und Windows-Setup-Tests erfolgreich. Signal-Provisioner
  mit Python 3.12 erfolgreich; der frühere Versuch mit Python 3.11.2 scheiterte
  an dessen fehlender Tarfile-Filter-API, nicht am vorgesehenen Laufzeitvertrag.

Beide Dockerfiles bauen erfolgreich. Der abschließende Next.js-Build umfasst
430 geprüfte Trace-Dateien ohne Backup-/Quellbaum-Leaks. Lokal geprüfte Images:

| Image                              | Lokale Image-ID                                                           |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `taxtronik/web:review-20261001`    | `sha256:1ca617fb1f1510f1ee587200d8345529e469d3fdedea23feae013a327cb7193a` |
| `taxtronik/worker:review-20261001` | `sha256:62f3c346d3ab170a0a40d75a61d91995d7377e23324d154f0c300d5ff3e6564d` |

Die Images wurden aus dem geprüften Arbeitsstand mit der Kennzeichnung
`528e4f87-dirty` gebaut. Sie sind lokale Prüfarbeitsstände und keine signierte
Release-Attestation.

Trivy 0.71.0 mit frisch geladener Schwachstellendatenbank meldet **keine
Schwachstellen** in beiden Images: Web 32 OS-/111 Node-Pakete, Worker
28 OS-/947 Node-Pakete. Keine Schweregradfilter, `ignore-unfixed`-, VEX- oder
Ignorefile-Ausnahmen wurden verwendet. Das ist ein Vulnerability-Scan,
kein zusätzlicher Secret- oder Konfigurationsscan. CycloneDX-SBOMs liegen
neben den lokalen JSON-Berichten.

Das Worker-Image besteht den Produktionslauf als UID 1000 mit schreibgeschütztem
Root-Dateisystem, ohne Capabilities und mit `no-new-privileges`, einschließlich
Healthcheck, erneuertem Heartbeat und sauberem SIGTERM. Der ausgelieferte
Drill-Helper prüft eine 65-MiB-Datei auf dem Backup-Volume trotz nur 64 MiB
`/tmp`, mit Dateimodus 0600, privatem Verzeichnis 0700 und vollständigem Cleanup.

Auch das Web-Image startet mit unverändertem Default-Entrypoint in Produktion
als UID 1000 unter denselben Dateisystem-/Capability-Beschränkungen: Liveness
und Readiness HTTP 200, Docker-Healthcheck erfolgreich. Ein echter
S3-Put/Get/Delete-Rundlauf mit eigener synthetischer Produktionscredential
liefert identische Bytes. Die Browser-Suite verwendet gesondert die reguläre
CI-Testkonfiguration mit Next.js-Produktionsbuild und `next start`.
Das vollständige Compose-Release-Smokeskript wurde wegen der bereits
bestehenden lokalen Taxtronik-Installation nicht gestartet; beide Images
wurden stattdessen in eigenen Produktionscontainern geprüft.

Ein paralleler Datenbanklauf überschritt beim Anlegen einer eigenen Shadow-DB
das fünfsekündige Unit-Standardbudget. Dieser Test erhält 30 Sekunden für
CREATE/DROP und wiederholte Reset-Prüfungen; seine Assertions bleiben unverändert.
Die danach vollständig wiederholten Fresh-/Upgrade-Suiten bestehen.
Ein Discovery-Check allein wird nicht als Browserlauf gezählt.

## Verbleibende Grenzen

- Fachliche Normauslegung und Freigaben bleiben offen. Kein
  `professional_review.status` wurde durch diese Prüfung auf `approved` gesetzt.
- Historische Dokumentversionen mit NULL-`storageVersionId` behalten die
  bestehende Kompatibilität. Ein belastbarer Backfill benötigt einen
  unabhängigen Byte-/Hashabgleich und darf keine Version raten.
- Ein nach S3-Upload verlorener Risk-Archivvergleich kann einen unverknüpften
  geschützten Blob hinterlassen. Der Gewinnerpointer bleibt korrekt;
  automatisches Reconcile dieser Risk-Objekte fehlt weiterhin.
- Harter Prozess-/Hostabbruch kann private Restore-Laufdateien oder eine
  eindeutig benannte Drill-DB zurücklassen. Reguläre Fehlerpfade räumen auf;
  Disk-Überwachung und Abgleich mit aktiven Läufen bleiben Betriebsaufgaben.
- Das externe Losprotokoll bindet keinen lokalen `attemptId` kryptographisch.
  Bei verlorenem Antwortkanal benötigt die Zuordnung eines bekannten Jobs eine
  dokumentierte Betreiberklärung. Eine belegte Nichtausführung darf nur ein
  berechtigter Admin oder Partner freigeben; ein Timeout allein löst keine neue Ziehung aus.
- Externe Produktivdienste, echte FIDO-Hardware, produktive ELSTER-/DATEV-
  Übertragung und externe TSA wurden nicht mit echten Kanzleidaten betrieben.
  Lokale/simulierte Zeitstempel gelten nicht als externer Zeitnachweis.
- Kein echter IBM-QPU-Lauf oder entsprechender Attestierungsnachweis wurde
  erzeugt. Die Los-Service- und Konkurrenztests verwenden eine injizierte
  Engine und beweisen die lokalen Zustandsübergänge.
- Der Restore-Drill prüft PostgreSQL und Auditdaten. Er ersetzt keinen
  vollständigen Wiederanlauf aller Objektspeicher, Schlüssel und Fremddienste.
