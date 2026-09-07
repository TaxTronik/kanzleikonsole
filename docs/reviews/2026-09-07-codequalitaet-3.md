# Gemeinsamer Qualitäts- und Funktionstest vom 7. September 2026

Ausgangsstand: `46a5de1c362b892303602f8090ebd47ab2a208bb` auf `main`.
Dieser Durchlauf verbindet einen breiten Code-Review mit konkreten
Fehlerreproduktionen, Korrekturen und lokalen Gesamttests. Die Abnahme ist
ausschließlich lokal; vorhandene produktive Dienste und Daten bleiben
unverändert. Es wurden keine fachlichen Freigaben erteilt.

## Bestätigte Fehler und Änderungen

| Bereich                   | Reproduktion und Korrektur                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audit-Kanonisierung       | Ein eigener JSON-Schlüssel `__proto__` wurde beim Aufbau eines gewöhnlichen JavaScript-Objekts ausgelassen. Ein Objekt ohne Prototyp erhält sämtliche eigenen Schlüssel. Rekursive JSON-, Hash-, Archiv- und Manipulationsfälle prüfen die Bindung; gewöhnliche Hashbytes einschließlich numerischer Schlüssel bleiben unverändert.                                                                                                |
| Dokumentauslieferung      | Allgemeiner Download, Vorschau, Bulk- und DATEV-ZIP konnten eine noch nicht finalisierte neueste Version auswählen. Eine gemeinsame Bedingung verlangt `CLEAN` und `scanCompletedAt`. Es gibt keinen stillen Rückfall auf ältere Versionen. Reguläre Uploads, erzeugte Rechnungsdokumente und ältere sauber finalisierte Versionen bleiben kompatibel.                                                                             |
| Restore                   | Ein echter Dump enthielt korrekte ACLs, doch ein vorbereitetes Ziel vergab beim Tabellenaufbau über Defaultprivilegien zusätzliche Audit-Schreibrechte. Die CLI meldete trotzdem Erfolg. Eine obligatorische Rollen-/ACL-/RLS-Prüfung vor Erfolg sperrt diesen Fall, auch ohne optionalen Datensmoke. Sie berücksichtigt zusätzlich erreichbare privilegierte `SET ROLE`-Ziele und prüft Tabellen ausdrücklich im Schema `public`. |
| BWA-Kennzahlen            | DATEV-Gesamtleistung wurde als Umsatz behandelt und das Betriebsergebnis als Ersatz für das Vorsteuerergebnis. Die Zuordnung verwendet Erlöse 1020 und Ergebnis vor Steuern 1345. Kosten benötigen belegte Positionen. Der Cashflow-Proxy verwendet Abschreibung 1240 statt Werbe-/Reisekosten 1200. Fehlende Angaben bleiben unbekannt.                                                                                           |
| BWA-Planung und Vergleich | Fehlende Werte wurden zu Null, Ergebnisachsen aus unvollständigen Teilachsen neu berechnet und sonstige Erträge dem Umsatz zugeschlagen. Quellwerte bleiben nullable und getrennt. Automatische Vorbelegung verlangt vollständige DATEV-/Addison-Achsen und eine passende Ergebnisidentität. MANUAL ohne dokumentierte Zuordnung wird nicht als Importschema ausgelegt; manuelle Planung bleibt möglich.                           |
| Steuerschätzung           | Eine fehlende Vorsteuerbasis wurde durch das vorläufige Ergebnis ersetzt. Die Oberfläche berechnet jetzt nur mit einer bekannten endlichen Vorsteuerbasis; die Engine lehnt ausdrücklich als Nachsteuerergebnis markierte Eingaben ab. Eine echte Null bleibt zulässig.                                                                                                                                                            |
| Vollmachtsablauf          | Statuswechsel und Benachrichtigungen lagen in getrennten Transaktionen; ein Fehler konnte Hinweise dauerhaft verlieren. Row-Lock, frischer Status-/Empfängerabgleich, Ablauf, Audit und Benachrichtigungen bilden nun eine Transaktion. Auch ohne Empfänger wird ein tatsächlich abgelaufener Status korrekt verarbeitet.                                                                                                          |
| Terminabsage              | Eine Portalabsage konnte eine inzwischen angenommene oder abgelehnte Anfrage überschreiben. Ein atomarer Statusclaim verlangt weiterhin PENDING; nur der Gewinner schreibt den Erfolgsnachweis.                                                                                                                                                                                                                                    |
| SMTP                      | Ein neues Passwort gleicher Länge ließ den alten SMTP-Transport im Cache. Eine gehashte strukturierte Konfigurationssignatur erkennt jetzt auch diesen Wechsel und vermeidet Trennzeichenkollisionen.                                                                                                                                                                                                                              |
| DATEV-Belegexport         | Generische XML-Erkennung gab Office-Dokumenten falsche Endungen. Exakte Office-MIME-Typen haben Vorrang. Ungültige Kalenderdaten und umgekehrte Datumsintervalle werden abgewiesen.                                                                                                                                                                                                                                                |
| Subsumtionseditor         | Ein Import verlor bestehende Rich-Text-Formatierung und konnte währenddessen bearbeitete Titel überschreiben. Import hängt jetzt an den aktuellen Dokumentzustand an. Fehlgeschlagene Formatierungssaves wiederholen den neuesten zulässigen Stand. Erfassung, Prüfung, Auswahl und Speichern sind in kleinere Komponenten und Hooks aufgeteilt.                                                                                   |
| Windows                   | Docker-Ausgaben verfälschten Rückgabewerte, `-d` kollidierte mit PowerShell-Parametern, das Setup war unter Windows PowerShell 5.1 ohne BOM nicht korrekt parsebar und ein fehlgeschlagener Docker-Reset löschte trotzdem `.env`. Argumente, Exitcodes, Kodierung und Erhalt der Konfiguration sind korrigiert und isoliert getestet.                                                                                              |

Die Fehler wurden vor der Korrektur mit gezielten roten Tests beziehungsweise
echten SQL-/CLI-Gegenläufen reproduziert. Verbesserte Tests prüfen das
beobachtbare Verhalten; bestehende Strukturprüfungen wurden an die neuen
Komponentengrenzen angepasst. Die neuen Browserdateien 20 und 21 sind in der
expliziten CI-Ausführung enthalten.

## Abnahme

| Prüfung                          | Ergebnis                                                                                                                                                                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vollständige Unit-Suiten         | 4.040 bestanden in 13 Testpaketen; alle 21 Turbo-Aufgaben erfolgreich und ohne Cache. Die neun dort separat aktivierbaren Fälle wurden zusätzlich mit den benötigten Testdiensten ausgeführt: sieben Mandatservice- und zwei Redis-Fälle.                                    |
| Gesamte Datenbank-Suite          | 396/396 Fälle in 55 Dateien auf einer frischen PostgreSQL-18-Datenbank; dieselben 396 Fälle jeweils nach Upgrade von v0.2.1 und nach Reparatur der historischen Legacy-Fixture bestanden.                                                                                    |
| Migration, Schema und Altbestand | 226 Migrationen und Ledger, RLS-Inventur, separate Shadow-Datenbank ohne Drift sowie ursprüngliche GwG-034-/Onboarding-041-Fixtures bestanden.                                                                                                                               |
| Backup und Restore               | Tatsächlicher PG18-Dump/Restore über den Produkt-CLI-Pfad; 141 öffentliche Tabellen mit identischen Zeilenzahlen. Zwei echte Audit-Ereignisse einschließlich `__proto__` erhalten und verifiziert. Unsichere Ziele mit/ohne Datensmoke abgewiesen, sichere Ziele akzeptiert. |
| Vollmachtsablauf                 | Vier zusätzliche echte PostgreSQL-Fälle: vollständiger Rollback nach SQL-Fehler, sichere Wiederholung, Verarbeitung ohne Empfänger und konkurrierender Widerruf unter nachgewiesenem Row-Lock.                                                                               |
| Browser                          | 184/184 eindeutige Fälle aller 21 Specdateien bestanden: 154 im Erstlauf, 30 gezielte Nachläufe, keine automatischen Retries.                                                                                                                                                |
| Finale Anmeldung                 | Vier echte TOTP-/Recovery-Browserfälle auf dem finalen Produktionsimage mit beiden TOTP-Bypassflags deaktiviert; eigenes Testkonto anschließend deaktiviert, Secrets und Recovery-Hashes entfernt.                                                                           |
| Storage und Redis                | 10 Deploy-Readiness-Fälle einschließlich Object Lock, Lesen/Schreiben/Löschen, EICAR und 25-MiB-Scan sowie zwei echte Redis-Widerrufsfälle bestanden.                                                                                                                        |
| Finaler Worker                   | 26 Worker bereit, drei echte Queue→Worker→DB-Fälle einschließlich Wiederholung und kontrolliertem Neustart. UID 1000, geschützte Migrationsdateien, PostgreSQL-Client 18.6, frischer Heartbeat und Healthcheck bestätigt.                                                    |
| Betrieb und Release              | 182 Repository-/Betriebsfälle, 37 Releasefälle und drei Python-Provisionierungsfälle bestanden. Beide Windows-Skripttests unter Windows PowerShell 5.1 und PowerShell 7 grün. Alle Repository-Sicherheitsguards bestanden.                                                   |
| Statische Qualität               | Typecheck über 22 Aufgaben, ESLint ohne Fehler, React-Compiler-Baseline ohne Treffer, Komplexitätsbaseline, Format, Dokumentationslinks und Migrationszeilenenden bestanden.                                                                                                 |
| Fachkatalog                      | `pnpm fachkatalog:check` und `pnpm fachkatalog:diff` bestanden; 80 Regeln aktuell und alle professionellen Freigabefelder unverändert.                                                                                                                                       |
| Abhängigkeiten und Images        | Produktions- und vollständiger pnpm-Audit ohne Befund. Beide finalen Images im vollständigen Trivy-Scan ohne bekannte Schwachstellen aller Schweregrade und ohne Secrets; kritische Gates bestanden, SBOMs erstellt.                                                         |

Die 182 Repository-/Betriebsfälle enthalten die Dokumentations- und
Fachkatalogtests bereits. Gezielte Nachläufe werden nicht nochmals zu denselben
Fällen in einer Gesamtsuite addiert.

Der erste Browserlauf endete mit sechs Fehlern und 24 durch Setupfehler
ausgelassenen Fällen: nativer Windows-Testprozessabbruch, temporärer
CJS-/ESM-Konfigurationsfehler beim Worker-Neustart und eine zu weit gefasste
Workflow-Assertion. Der Zielworkflow war korrekt blockiert; die Assertion
zählte den Status eines anderen synthetischen Vorgangs mit. Nach enger
Fixture-Rücksetzung, korrektem Locator-Scope und Reparatur der temporären
Testkonfiguration bestanden alle 30 betroffenen Fälle. Testschlüssel wurden
nach Datei, Titelhierarchie und Browserprojekt abgeglichen. Erstreport und
Nachläufe bleiben getrennt erhalten.

Auch gemeinsame DB-Testläufe brachen unter Windows/Node 24.15 nativ mit
`0xC0000409` beziehungsweise „Worker exited unexpectedly“ ab. Die vollständige
Abdeckung wurde mit unveränderten Assertions in getrennten Node-/Vitest-
Prozessen je Datei hergestellt. Die Abschlussnachweise enthalten für alle
drei Datenbankstände jeweils alle 55 Dateien und 396 bestandene Fälle.
Ein Prozessabbruch wird nicht als bestandener Lauf gezählt.

## Geprüfte Artefakte

Die 184 Browserfälle liefen gegen das erste Produktionsimage
`sha256:c72d929b93dfdc115cda41af0bad3adc53d388896190b0645ad8dc9558b021c9`.
Nach der sauberen Verlagerung des Restore-Prüfers ins Datenbankpaket wurden
beide Images erneut gebaut. Der übrige produktive Anwendungscode blieb
eingefroren; der Restore-CLI-Pfad wurde am Host tatsächlich erneut geprüft.
Das finale Webimage wurde zusätzlich mit den vier echten TOTP-/Recovery-
Fällen und Readiness geprüft. Der Worker erhielt erneut seine vollständige
Runtime-Abnahme.

| Finales Image                              | Image-ID                                                                  | SBOM-Komponenten |
| ------------------------------------------ | ------------------------------------------------------------------------- | ---------------: |
| `taxtronik/web:local-quality3-20260907`    | `sha256:d4da8e8562f4dd58955bd149a6e420f8f86a68ddd787bc6f821dc8decbc6b248` |              145 |
| `taxtronik/worker:local-quality3-20260907` | `sha256:412dd96d54fb9e7231707f12c43697e327eb5140aae1826d7b187ef89cd1ef17` |              978 |

Build, Scan und finale Runtime wurden auf dieselben Image-IDs abgeglichen.
Die Builds waren auf je 6 GiB ohne zusätzlichen Swap begrenzt; der Runner-
Layer wurde neu gebaut. Trivy lief mit dem CI-gepinnten Scannerimage und
vollständigem Schweregradumfang einschließlich nicht behobener CVEs; beide
Ergebnisse sind leer. Datenbankstand des Scanners: 6. September 2026,
13:03 UTC, nächster Updatezeitpunkt 7. September, 13:03 UTC. Die Paketgraphen
des pnpm-Audits umfassten 674 Produktions-/optionale beziehungsweise insgesamt
1.021 Einträge. Das sind zeitpunktbezogene Scannerbefunde, kein Nachweis
vollständiger Fehlerfreiheit.

## Breite und Grenzen

Die parallelen Reviews umfassten Web-Oberflächen und gemeinsame Komponenten,
Staff-/Portal-Actions und APIs, Auth-/Tenant-/Objektgates, privilegierte
Datenbankpfade, Workflow-Statusübergänge, Rechnungen und Dokumente, BWA,
Vollmachten, Worker und Shared-Pakete sowie lokale Betriebs- und Releasehilfen.
Die vollständigen vorhandenen Testsuiten ergänzen die gezielten Stichproben.
Das ist keine Behauptung, jede Codezeile, jeden Fachjob und jede denkbare
Kombination dynamisch ausgeführt zu haben.

Die neuen Editor- und BWA-Browserfälle rendern echte Komponenten und Engines
mit synthetischen Action-Grenzen. Sie prüfen die Übergabe an Speicheraktionen,
beweisen für sich allein keine Datenbankpersistenz. Der Worker-Smoke prüft
tatsächliche Queue-/DB-Verarbeitung und Wiederanlauf, führt aber nicht sämtliche
registrierten Fachjobs vollständig aus. Externe Fachsysteme, echte Hardware-
Authentikatoren, externe TSA, Produktions-VPS und ein vollständiger Windows-
Installationslauf sind nicht Teil dieses lokalen Nachweises.

Es verbleiben 69 vorhandene Komplexitätswarnungen bei einem Grenzwert von 20.
Die Baseline wurde ausschließlich für belegte Verbesserungen angepasst:
Subsumtionsworkspace 58 → 19 und BWA-Dashboard 45 → 25. Der höchste verbleibende
Wert beträgt 53. Es wurde keine neue Komplexitätsschuld freigegeben.

## Hinweise für bestehende Daten

**Audit:** Historische Ereignisse mit einem gespeicherten eigenen `__proto__`-
Schlüssel waren bislang nicht vollständig an den Hash gebunden. Die korrigierte
Prüfung kann erstmals eine Abweichung melden. Es gibt weder eine unsichere
Legacy-Verifikation noch eine automatische Änderung historischer Hashes,
Anker oder Freigaben. Hat ein früherer Archivexport das Feld bereits verloren,
lässt sich dessen ursprünglicher Inhalt aus diesem Archiv allein nicht
rekonstruieren. Gewöhnliche Ereignisse behalten ihre bisherigen Hashbytes.

**BWA:** Rohpositionen und gespeicherte oder manuell bearbeitete Pläne werden
nicht migriert. Beim erneuten Lesen können berechnete Kennzahlen korrigiert
erscheinen oder wegen fehlender Positionen leer bleiben. Frühere automatische
Planvorbelegungen müssen gegen die Original-BWA geprüft werden. Die
Steuerengine bleibt ein begrenztes, fachlich ungeprüftes Modell. Quellen und
Zuordnungsgrenzen stehen in den drei BWA-Regeln und in der
[Anwenderdokumentation](../anwenderdoku/bwa-planung.md).

**Restore:** Ein Fehler der nachgelagerten Sicherheitsabnahme rollt den bereits
angewendeten Restore nicht zurück. Dienste bleiben gestoppt, bis sichere
Zielrechte, RLS, Auditkette, Migrationsstand und der passende Release-Vertrag
nachgewiesen sind. Das Gate prüft Rechte und RLS-/Policy-Präsenz, keine
vollständige semantische Gleichheit jeder Policy oder eine komplette
Zielserverabsicherung. Details stehen in der
[Backup-/Restore-Modulbeschreibung](../development/module/backup-restore.md).

## Nachweisablage

Rohprotokolle, Repros, JSON-Ergebnisse, Browserberichte und SBOMs liegen lokal
unter `%TEMP%\kanzleikonsole-quality3-20260907`. Temporäre Konfigurationen und
Zugangsdaten gehören nicht zum Repository. Git-Commit und dokumentierte
Source-Hashes binden die Änderungen an den geprüften Stand.

Alle eigens gestarteten Testdienste sind beendet: die sieben E2E-Container
und die neue DB-Instanz gestoppt, die Worker-Testcontainer und deren internes
Netz entfernt sowie die lokale Identitätsfixture beendet. Testberichte,
synthetische Testdaten und Images bleiben zur Nachprüfung verfügbar.

Regelbindung: `AUDIT-HASH-CHAIN-001`, `AUDIT-ARCHIVE-001`,
`ACCESS-TENANT-RLS-001`, `ACCESS-NOTIFICATION-RECIPIENT-001`,
`ACCESS-CLIENT-MODE-001`, `DOC-UPLOAD-JOURNAL-001`,
`DOC-VERSION-IMMUTABILITY-001`, `DOC-PORTAL-SHARING-001`,
`POA-LIFECYCLE-001`, `BWA-IMPORT-MAPPING-001`, `BWA-PROJECTION-001`,
`BWA-TAX-ESTIMATE-001` und technische Ausnahme `FK-EXC-20260907-004`.
Alle 80 `professional_review`-Datensätze wurden gegen den Ausgangsstand
verglichen und bleiben unverändert.
