# Projektprüfung vom 6. September 2026

Geprüft wurde der aktuelle Arbeitsstand einschließlich vorhandener Änderungen
und neuer, noch nicht versionierter Dateien. Ausgangscommit:
`599c969caba125c945dd54052ebb703f1f8855b4`. Der Bericht beschreibt eine
risikoorientierte Codeprüfung; er ist keine vollständige fachliche Freigabe
oder Aussage über sämtliche möglichen Fehler. Die ursprüngliche Prüfung war
lesend; die anschließenden Korrekturen sind im Abschnitt „Umsetzung nach dem
Prüfauftrag“ dokumentiert. Fachliche Freigaben wurden nicht erteilt.

Die Prüfung umfasste parallel Authentifizierung und Zugriffe, Steuer- und
Rechnungslogik, neue Kanzleiworkflows sowie Dokumentenverarbeitung und Worker.
Zu den fachlichen Befunden wurden die vollständigen zugehörigen Fachregeln
gelesen. P1 bedeutet vorrangige Behebung, P2 regulär einzuplanende Fehlerbehebung.

## Bestätigte Befunde

### 1. [P1] Widerrufene Sitzungen lassen sich durch Cookie-Erneuerung reaktivieren

Fundstellen: [Portal-JWT-Callback](../../apps/web/src/server/auth/portal.ts),
Zeilen 259–268, und [Staff-JWT-Callback](../../apps/web/src/server/auth/staff.ts),
Zeilen 609–620; der Widerruf wird erst in den jeweiligen Session-Callbacks geprüft.

Die JWT-Callbacks geben vorhandene Tokens unverändert zurück. Erkennt der
Session-Callback den Redis-Widerruf, gibt er lediglich eine Session ohne
Anwendungsidentität zurück. Die installierte Auth.js-Implementierung erneuert
trotzdem das Cookie und setzt dessen `iat` auf die aktuelle Zeit. Beim nächsten
Zugriff liegt dieser Wert nach dem Widerrufszeitpunkt; das Token wird akzeptiert.

Reproduktion mit der tatsächlich installierten Auth.js-Sessionverarbeitung,
JWT-Verschlüsselung/-Entschlüsselung und den produktiven Portal-Callbacks;
Datenbank und Redis waren simuliert: altes, nicht abgelaufenes Token zunächst
abgewiesen; Abruf des Session-Endpunkts liefert erneuertes Cookie; anschließendes
`portalAuth` erkennt wieder den Kontakt. Ein abgelaufenes Token wurde als
Negativkontrolle korrekt verworfen.

Betroffen sind Widerrufe, die nur den Redis-Zeitstempel setzen, etwa eine
entsprechende Abmeldung aller Sitzungen. Zusätzliche Prüfungen auf inaktive
Konten oder geänderte Staff-`authRevision` bleiben wirksam. Ein Angreifer müsste
ein zuvor gültiges Cookie behalten haben. Das Verhalten unterläuft den
dokumentierten S11-Widerruf.

Behebung: Widerruf vor der JWT-Erneuerung prüfen und ungültige Tokens dort
verwerfen. Alternativ muss die Widerrufsprüfung an einen unveränderlichen
Anmeldezeitpunkt oder eine Sitzungsrevision gebunden werden. Ein Regressionstest
muss die tatsächliche Auth.js-Cookie-Erneuerung und den Folgezugriff abdecken.

### 2. [P1] Storno-XML kombiniert eine unpassende Belegart mit negativen Beträgen

Fundstelle: [XRechnungsmapper](../../apps/web/src/server/invoicing/xrechnung.ts),
Zeilen 124–132. Regel: `INV-STORNO-REFERENCE-001`.

Das Storno invertiert Originalmengen und Beträge; der XML-Mapper setzt zusätzlich
Typcode `381` für eine Credit Note. Mit produktiven Funktionen reproduziert:
Originalbetrag +119 Euro ergibt Typ 381, Menge −1 und
`GrandTotalAmount=-119.00`. Dokumenttyp und Vorzeichen transportieren damit eine
widersprüchliche Korrekturwirkung; automatisierte Empfänger können eine erneute
Belastung statt des beabsichtigten Ausgleichs erkennen.

Die [offizielle Bundesverwaltungs-FAQ](https://e-rechnung-bund.de/faq/wie-sind-gutschriften-und-rechnungskorrekturen-anzugeben/)
nennt 384 für Rechnungskorrektur/Storno und empfiehlt bei 381 kein zusätzlich
negatives Betragsvorzeichen. Die
[OpenPeppol-Spezifikation, Abschnitt 5.6](https://docs.peppol.eu/poacc/billing/3.0/bis/#_negative_invoices_and_credit_notes)
unterscheidet entsprechend zwischen negativer Rechnung und Credit Note. Dies ist
ein Befund zur fachlichen Semantik; daraus folgt nicht, dass jeder XML-Validator
den vorhandenen Beleg ablehnen muss.

**Ausdrücklicher Katalogkonflikt:** Fachregel und bestehende Tests verlangen
derzeit ebenfalls 381 mit invertierten Beträgen. Bei einer Behebung müssen
Belegart, Vorzeichen, Regel, Umsetzungshinweise und Nachweise gemeinsam
korrigiert werden. Die vorgesehene Empfängerkonvention ist fachlich zu prüfen;
eine KI darf dafür keine Freigabe eintragen.

### 3. [P2] Kalenderabonnements liefern nach Mandatsende weiter Daten

Fundstelle: [Portal-iCal-Route](../../apps/web/src/app/api/portal/ical/[token]/route.ts),
Zeilen 25–39. Regeln: `CLIENT-MANDATE-LIFECYCLE-001`, `CLIENT-OFFBOARDING-001`.

Die Route prüft Kontaktaktivität, Tokenversion, `allowActive` und Anonymisierung,
aber kein `mandateEndedAt`. Das Beenden des Mandats widerruft die vorhandene
Kalender-Tokenversion nicht. Ein zuvor eingerichtetes Kalenderabo erhält daher
weiter aktuelle Termine und Fristen, obwohl die Portal-Session gesperrt ist.
Mit der tatsächlichen Route und simulierten Datensätzen reproduziert: beendetes
Mandat, bestehendes Token, HTTP 200 mit Terminen und Fristen.

Behebung: Den aktuellen Mandatszustand auch in diesem unabhängigen Zugriffspfad
prüfen; gegebenenfalls Feed-Tokens beim Offboarding zusätzlich widerrufen.

### 4. [P2] StBVV-Übernahme erzeugt einen unversendbaren Rechnungsentwurf

Fundstelle: [StBVV-Service](../../apps/web/src/server/stbvv/service.ts), Zeile 141.
Regeln: `STBVV-CALCULATION-001`, `INV-ARCHIVE-EINVOICE-001`.

Die nur im IN_APP-Modus erlaubte Übernahme erzeugt `format: 'PDF'`, aber kein
Belegdokument. Die Rechnungsdetailseite bietet dafür keine Generierung an;
[Archivierung](../../apps/web/src/server/invoicing/archive.ts), Zeile 847,
liefert `not_applicable`. Die
[Versandaktion](<../../apps/web/src/app/staff/(protected)/invoices/actions.ts>),
Zeilen 515–525, lehnt diesen PDF-Entwurf ohne Beleg anschließend ausdrücklich ab.
Ein erneuter Export liefert wegen der Idempotenz denselben Entwurf.

Der Befund wurde durch Abgleich der vollständigen Aufrufkette bestätigt.
Behebung: Bei der Übernahme ein unterstütztes In-App-Rechnungsformat verwenden.
Den Test von der Kalkulation bis zur Archivierungs-/Versandfähigkeit erweitern;
die bisherigen Prüfungen auf Summen, DRAFT-Status und Idempotenz erfassen die
Inkompatibilität nicht.

### 5. [P2] Nachtarbeit erhält in der Stundenrechnung den falschen Leistungstag

Fundstelle: [Stundenabrechnung](<../../apps/web/src/app/staff/(protected)/clients/[id]/billing/actions.ts>),
Zeilen 118–123. Regel: `INV-TIME-ENTRY-CLAIM-001`.

Die Aktion übernimmt UTC-Zeitpunkte aus Zeiteinträgen unverändert in die
kalenderbasierten Felder `servicePeriodStart` und `servicePeriodEnd` (`@db.Date`).
Der XML-Generator liest daraus UTC-Kalendertage. Beispiel: Arbeit am 06.09.2026
von 00:30 bis 01:30 Uhr in Berlin wird als Leistungszeitraum 05.09.2026
ausgegeben. Mit dem produktiven XML-Generator reproduziert: beide
`DateTimeString`-Werte lauten `20260905`.

Behebung: Die Zeitpunkte zuerst in Berliner Kalenderdaten umwandeln und erst
diese als Leistungszeitraum speichern. Insbesondere Monats-/Jahreswechsel und
die Sommerzeitgrenze sind geeignete Testfälle.

### 6. [P2] Eine E-Mail mit 51 Anhängen blockiert alle späteren Postfacheingänge

Fundstelle: [IMAP-Verarbeitung](../../packages/mail/src/imap.ts), Zeile 360.
Regel: `MAIL-INBOX-001`.

Bei mehr als 50 Anhängen wirft der Parserpfad einen Fehler. Der Empfangsnachweis
wird nicht terminal blockiert und der UID-Cursor nicht weitergesetzt. Jeder
weitere Poll verarbeitet dieselbe Nachricht erneut; spätere Nachrichten werden
nicht erreicht. Die Oberfläche zeigt nur einen allgemeinen Abruffehler.

Isolierte Ausführung des produktiven Moduls mit simuliertem IMAP und
Datenzugriff: UID 1 besitzt 51 Anhänge, UID 2 wäre der nächste Eingang. Nach zwei
Polls wurden die UIDs `[1, 1]` geladen; `lastUid` blieb 0 und das Postfach aktiv.

Behebung: Dauerhafte inhaltliche Limitverletzungen terminal sperren und den
Cursor kontrolliert weiterführen, wie bereits beim Größenlimit. Vorübergehende
Scanner-/Transportausfälle müssen dagegen wiederholbar bleiben.

### 7. [P2] Alte Fehlerfälle können die gesamte Orphan-Bereinigung blockieren

Fundstelle: [Storage-Orphan-Worker](../../apps/worker/src/jobs/storage-orphan-cleanup.ts),
Zeilen 131–132 und 265–273. Regeln: `DOC-UPLOAD-JOURNAL-001`,
`DSGVO-OPERATIONAL-RETENTION-001`.

Jeder Lauf selektiert die ältesten 100 Kandidaten. Bei einem Fehler wird der
Claim freigegeben, aber weder Auswahlreihenfolge noch nächster Versuch
verändert. Sind diese 100 Fälle dauerhaft nicht auflösbar, gelangen spätere
bereinigungsfähige Objekte nie in einen Lauf. Die Auswahl erfolgt tenantübergreifend.

Das kann auch aus normalen Abbrüchen entstehen: Die
[Inbox-Ablehnungsmigration](../../packages/db/prisma/migrations/20260901008000_portal_inbox_reject_pending_acceptance/migration.sql),
Zeilen 150–173, journalisiert eine abgebrochene PENDING-Reservierung auch dann,
wenn der Prozess bereits vor dem PUT ausfiel und nie Bytes vorhanden waren.
Die spätere Recovery findet dann dauerhaft keine Version.

Mit dem tatsächlichen Worker und simulierten Daten reproduziert: 100 alte
Fehlerfälle plus ein neuer, löschbarer Kandidat; drei Läufe mit jeweils 100
Fehlern, der löschbare Kandidat erhielt keinen einzigen Versuch.

Behebung: Wiederholungen zeitlich staffeln und die Auswahl fair fortschreiben,
beispielsweise mit `nextAttemptAt` und Pagination. Unauflösbare Fälle sichtbar
eskalieren, ohne den Rest der Bereinigung zu blockieren.

### 8. [P2] Ein alter Browserstand überschreibt einen Workflow-Abbruch

Fundstelle: [Workflow-Aktionen](<../../apps/web/src/app/staff/(protected)/clients/[id]/workflows/actions.ts>),
Zeilen 250–270. Fachbezug: `CLIENT-FEEDBACK-001`, `WORKFLOW-DEPENDENCY-001`.

`toggleItemDoneAction` prüft den Mandantenzugriff, aber keinen zulässigen
Ausgangsstatus der Instanz. Beim letzten Haken schreibt es nur nach Instanz-ID
`COMPLETED`. Bleibt die Workflowseite offen und wird der Vorgang zwischenzeitlich
anderweitig abgebrochen, kann ein letzter Haken im alten Fenster den Abbruch
überschreiben. Mit produktiver Action und simulierter Persistenz reproduziert:
`CANCELLED → {ok:true} → COMPLETED`.

Behebung: Die Instanz sperren, den erlaubten Ausgangsstatus prüfen und den
Abschluss atomar durchführen. Auch zwei parallele letzte Schritterledigungen
müssen dabei konsistent zusammengeführt werden. Eine vollständige eigene
Workflow-Lifecycle-Regel fehlt im gelesenen Katalog; bei entsprechender
Verhaltenskorrektur wäre ihr Scope als ungeprüfter Entwurf zu ergänzen.

### 9. [P2] Automatisch erledigte letzte Schritte schließen den Workflow nicht ab

Fundstelle: [Schrittausführung](../../apps/web/src/server/workflows/execute-step.ts),
Zeilen 831–834; Aufrufer in den
[Workflow-Aktionen](<../../apps/web/src/app/staff/(protected)/clients/[id]/workflows/actions.ts>),
Zeilen 878–885. Fachbezug: `CLIENT-FEEDBACK-001`.

Ein erfolgreicher `N8N_TRIGGER` setzt das Item auf erledigt, aktualisiert aber
keinen Elternstatus. Der Aufrufer invalidiert anschließend nur die Anzeige.
Ein Workflow mit diesem einzigen Schritt bleibt deshalb bei 100 Prozent
erledigten Items `ACTIVE`; vorgemerkte Feedbackeinladungen werden nicht ausgelöst.
Das widerspricht dem in [FEATURES.md](../../FEATURES.md) beschriebenen
automatischen Instanzabschluss.

Produktives Modul mit simuliertem Handoff und Datenzugriff ausgeführt:
`itemMarkedDone=true`, Item erledigt, Instanz weiterhin `ACTIVE`, keine
Schreiboperation auf der Instanz. Es wurde keine externe n8n-Aktion ausgelöst.

Behebung: Die Instanzabschlusslogik zentralisieren und von manueller sowie
automatischer Schritterledigung aufrufen. Request-/Formular-Abschlusstrigger
und Worker gehören in dieselbe Prüfung.

## Codequalität und Nachweise

| Prüfung                        | Ergebnis                                                                    |
| ------------------------------ | --------------------------------------------------------------------------- |
| Unit-Tests ohne DB-/E2E-Pakete | 3.669 bestanden, 15 übersprungen; 457 Testdateien bestanden                 |
| `pnpm typecheck`               | Erfolgreich; 22 Turbo-Tasks, davon 21 aus Cache                             |
| `pnpm lint`                    | Keine Fehler; 154 Warnungen, davon 94 zur Komplexität und 60 zu React Hooks |
| `pnpm format:check`            | Fehlgeschlagen: neun Dateien nicht entsprechend Prettier formatiert         |
| `pnpm docs:check`              | Erfolgreich, einschließlich vier Tests des Linkprüfers                      |
| `pnpm fachkatalog:check`       | Erfolgreich; 32 Tests, 79 gültige und aktuelle Regeln                       |
| `pnpm fachkatalog:diff`        | Erfolgreich; 169 Fachpfadänderungen konkret zugeordnet                      |

Unit-Testbefehl:
`pnpm --workspace-concurrency=2 --filter '!@taxtronik/db' --filter '!@taxtronik/e2e' -r test`.
Die zusätzlichen Reproduktionen verwendeten den tatsächlichen Anwendungscode
mit simulierten Daten-/Dienstgrenzen. Sie ersetzen keine Integrationsprüfung.
DB-/RLS-Integrationstests, Browser-E2E, Produktionsbuild, Live-Microsoft-365-Test
und vollständige externe E-Rechnungsvalidierung wurden nicht ausgeführt.

Die größten gemeldeten Komplexitäten liegen in der GwG-Seite (75), der
Auditübersicht (67) und dem Subsumtionsarbeitsbereich (61), bei einer konfigurierten
Grenze von 20. Eine schrittweise Trennung von Datenzugriff, Fachentscheidung und
Darstellung würde die Prüfung dieser Bereiche erleichtern. Die konkret
gefundenen Fehler zeigen außerdem Lücken an Modulübergängen: Cookie-Erneuerung
nach Widerruf, Gebührenexport bis Rechnungsversand und Schritterledigung bis
Instanzabschluss. Diese Ablaufprüfungen sind vorrangiger als zusätzliche Tests,
die lediglich einzelne aktuelle Rückgabewerte festschreiben.

Alle 79 aktiven Fachregeln stehen derzeit auf `unreviewed`. Das ist eine bereits
dokumentierte Prüfgrenze, kein neu entdeckter Programmfehler. Ein grünes
Fachkatalog-Gate belegt Struktur und Zuordnung; es belegt keine materielle
Richtigkeit oder Freigabe durch einen Berufsträger.

## Umsetzung nach dem Prüfauftrag

Auf den Folgeauftrag zur vollständigen Behebung wurden die neun bestätigten
Befunde korrigiert und die jeweiligen Regressionen ergänzt:

| Befund | Umsetzung und Nachweis                                                                                                                                                                                                                                          |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | JWT-Erneuerung prüft Widerruf und Kontozustand vor dem Ersatzcookie. Der ursprüngliche Anmeldezeitpunkt bleibt erhalten; alte Cookies ohne diesen Wert verlangen eine neue Anmeldung. 22 echte Auth.js-HTTP-Regressionsfälle mit simulierten DB-/Redis-Grenzen. |
| 2      | Neue Stornos verwenden Typ 384 und Originalreferenz; bereits ausgestellte Archivfassungen bleiben unverändert. CII- und Archivtests prüfen Typ, Vorzeichen und Referenz.                                                                                        |
| 3      | Der Kalenderfeed verweigert Zugriff nach Mandatsende; Route-Regression prüft die Sperre vor Datenabruf.                                                                                                                                                         |
| 4      | StBVV-Übernahmen erzeugen XRechnungsentwürfe. Der erneute Export repariert ausschließlich zugeordnete, dokumentlose PDF-Entwürfe unter Sperre. Echte Export-/Archiv-/PDF-Tests prüfen auch Zeitgebührentexte und mehrseitige Positionen.                        |
| 5      | Leistungsdaten verwenden den Kalendertag in Europe/Berlin; die Dauer bleibt tatsächlich verstrichene Zeit. Grenzfälle um Mitternacht und Zeitumstellungen sind geprüft.                                                                                         |
| 6      | Mehr als 50 Anhänge führen zu einem dokumentierten BLOCKED-Eingang mit Cursorfortschritt; die nächste Nachricht wird verarbeitet.                                                                                                                               |
| 7      | Löschaufträge werden nach bisherigen Versuchen und Alter ausgewählt. Eine Regression mit 100 fehlschlagenden Objekten und einem späteren löschbaren Objekt prüft den Fortschritt.                                                                               |
| 8      | Zeilenlocks und Datenbanktrigger serialisieren Schritterledigung und Instanzabschluss; PAUSED/CANCELLED bleiben erhalten.                                                                                                                                       |
| 9      | Alle Abschlussquellen nutzen denselben Datenbankzustand. Feedback wird dauerhaft vorgemerkt und transaktional einmalig verarbeitet. Beide Reihenfolgen einer parallelen Kontaktauswahl und Schritterledigung sind gegen PostgreSQL geprüft.                     |

Die unabhängige Gegenprüfung hat zusätzlich den Übergang alter Sitzungscookies
und den Feedback-Auswahlwettlauf aufgedeckt; beide sind in der Umsetzung erfasst.
Neue StBVV-Tests decken außerdem zuvor nicht darstellbare generierte Pfeiltexte
und abgeschnittene lange PDF-Positionen ab.

React-Compiler-Warnungen wurden von 60 auf null reduziert. Die
Komplexitätswarnungen sanken von 94 auf 75; keine neue oder höhere
Funktionskomplexität wurde in die Baseline aufgenommen. Die verbleibenden
Warnungen sind dokumentierte Wartungsschulden und keine bestätigten
Funktionsfehler. Grenzwerte wurden nicht angehoben. Fachlich unveränderte
UI-/Strukturänderungen sind konkret in
[AENDERUNGEN.md](../fachkatalog/AENDERUNGEN.md) begründet.

Die neue Regel `WORKFLOW-LIFECYCLE-001` erweitert den Katalog auf 80 Regeln.
Alle fachlichen Freigabefelder bleiben ungeprüft beziehungsweise leer. Die
amtliche Herausgeberschaft der neuen E-Rechnungsquelle wurde anhand des
[BeschA-Impressums](https://e-rechnung-bund.de/impressum/) verifiziert; das ist
keine Freigabe der steuerlichen Umsetzung.

### Abschließende technische Nachweise

- 3.736 Unit-Tests in 466 Testdateien bestanden; 15 vorhandene bedingte Tests
  übersprungen.
- 379 Datenbanktests in 54 Dateien bestanden. Ein vorheriger Gesamtlauf brach
  durch einen unerwartet beendeten Vitest-Unterprozess ab; der vollständige
  Wiederholungslauf mit detaillierter Ausgabe war fehlerfrei.
- Produktionsbuild erfolgreich, einschließlich Standalone-Trace-Prüfung
  (673 Dateien, keine Backup-/Quellbaum-Leaks).
- Vollständige Typprüfung und beide unverändert strengen Lint-Gates bestanden.
- Format- und Dokumentationsprüfung bestanden; Fachkatalog-Check mit 33 Tests
  und Diff-Zuordnung für 207 Fachpfadänderungen erfolgreich.
- 226 Migrationen auf einer isolierten PostgreSQL-18-Instanz angewendet;
  Migrationsledger konsistent, 138 RLS-Tabellen geprüft. Ein frischer Aufbau
  einer zusätzlichen Shadow-Datenbank zeigt keine Schemaabweichung.
- `pnpm audit --audit-level=high`: keine bekannten Schwachstellen gemeldet.
- Browser-Smoke-Tests konnten nicht gestartet werden: Die automatische
  Freigabeprüfung blockierte den lokalen Testserver auch bei ausschließlicher
  Bindung an 127.0.0.1 mit „blocked by policy“ ohne weitere Begründung.

Der vorhandene Drift-Wrapper versucht zunächst einen Datenbankreset, den Prisma
für KI-Aufrufe sperrt. Der gleichwertige Vergleich erfolgte ohne Reset: alle
Migrationen wurden in eine eigens angelegte leere Shadow-Datenbank deployt,
anschließend wurde deren Live-Schema mit `schema.prisma` verglichen. Es wurden
keine produktiven Datenbanken migriert oder zurückgesetzt. Live-Microsoft-365,
vollständiges Browser-E2E und externe KoSIT-Validierung sind weiterhin offen.
