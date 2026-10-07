---
id: AUDIT-ARCHIVE-001
title: Audit-Ketten in deterministischen Segmenten archivieren
domain: audit-und-assurance
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Compliance und Verfahrensdokumentation
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: Der Rotationsjob erzeugt prüfbare NDJSON-Segmente, legt sie im COMPLIANCE-Object-Lock ab und kann Upload- oder Datenbankunterbrechungen vorwärts auflösen. Je Lauf archiviert er Segment um Segment bis zu einem Zeitbudget; ohne verifizierten externen Stempel archivierte Segmente bleiben PENDING und werden von späteren Läufen nachgestempelt. Einen anhaltenden Archivierungsrückstand meldet er als Health-Kennzahl und ab einer festen Schwelle als Alarm.
sources:
  - kind: product_documentation
    citation: Technische Modulbeschreibung Audit-Protokollierung, unveränderliche Langzeitarchivierung
    path: docs/development/module/audit-protokollierung.md
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: ADR 0004, Vier-Schicht-Modell der Manipulationsevidenz
    path: docs/adr/0004-evidence-chain-mit-rfc3161.md
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - packages/evidence/src/archive.ts
  - packages/evidence/src/canonical-json.ts
  - apps/worker/src/jobs/audit-rotate.ts
  - apps/worker/src/tsa-port.ts
  - apps/worker/src/run-budget.ts
  - apps/worker/src/maintenance-backlog.ts
  - apps/web/src/server/jobs/maintenance-backlog.ts
  - packages/db/prisma/migrations/20261005110100_audit_archive_tsa_status/migration.sql
  - packages/db/prisma/migrations/20261007141000_notification_kind_maintenance_backlog/migration.sql
  - packages/db/prisma/migrations/20261007141100_notification_daily_dedupe_maintenance_backlog/migration.sql
  - packages/db/prisma/schema.prisma
test_refs:
  - packages/evidence/src/__tests__/archive.test.ts
  - packages/evidence/src/__tests__/canonical-json-keys.test.ts
  - apps/worker/src/jobs/__tests__/audit-rotate.test.ts
  - apps/worker/src/__tests__/tsa-port.test.ts
  - apps/worker/src/__tests__/run-budget.test.ts
  - apps/worker/src/__tests__/maintenance-backlog.test.ts
  - apps/web/src/server/jobs/__tests__/maintenance-backlog.test.ts
  - apps/web/src/app/api/health/detail/__tests__/route.test.ts
  - packages/db/src/__tests__/audit-archive-tsa-status.test.ts
  - packages/db/src/__tests__/notification-batch.test.ts
feature_refs:
  - docs/development/module/audit-protokollierung.md
  - docs/adr/0004-evidence-chain-mit-rfc3161.md
related_rules:
  - AUDIT-HASH-CHAIN-001
  - AUDIT-RFC3161-ANCHOR-001
  - AUDIT-VERIFY-ALERT-001
tags:
  - audit
  - archiv
  - object-lock
  - ndjson
---

# AUDIT-ARCHIVE-001 — Audit-Ketten in deterministischen Segmenten archivieren

## Kurzfassung

Der Audit-Rotationsjob exportiert einen zusammenhängenden ID-Bereich eines
Kanzlei-Tenants als deterministisches NDJSON-Segment. Das Segment enthält
Kettenanker und einen Datei-Hash, wird vor der Ablage vollständig nachgerechnet
und im Storage mit COMPLIANCE Object Lock gespeichert. Wiederholungen können
bereits hochgeladene, aber noch nicht in der Datenbank registrierte Segmente
erkennen und übernehmen.

## Wann gilt die Regel?

Die Regel gilt für den geplanten oder gezielt ausgeführten Audit-Rotationsjob.
Sie beschreibt Export, technische Segmentprüfung, unveränderliche Ablage und
Recovery. Sie bestimmt weder eine rechtlich richtige Aufbewahrungsfrist noch
eine zulässige Löschung der Quelldatenbank.

## Benötigte Angaben

- Kanzlei-Tenant und noch nicht archivierter zusammenhängender Audit-ID-Bereich
- zeitbezogene obere ID-Grenze der Rotation
- erste Vorgängerbindung und letzter Kettenwert des Segments
- kanonische Audit-Datensätze in stabiler Reihenfolge
- Storage-Ziel mit COMPLIANCE Object Lock
- optionaler RFC-3161-Token und die dazugehörige Trust-Policy

## Entscheidungslogik

| Ausgangslage                               | Ergebnis                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| kein neuer zusammenhängender Bereich       | keinen leeren Archivdatensatz erzeugen                                               |
| Segment lässt sich vollständig nachrechnen | deterministische Bytes und SHA-256-Dateihash bilden                                  |
| Segmentprüfung schlägt fehl                | Upload und Registrierung abbrechen                                                   |
| identisches Objekt ist bereits gespeichert | Größe und SHA-256 der gelesenen Bytes prüfen und fehlende DB-Registrierung nachholen |
| Upload gelingt, DB-Registrierung scheitert | Objekt erhalten; späteren Lauf vorwärts recovern lassen                              |
| externe TSA fehlt oder schlägt fehl        | Segment ohne behaupteten externen Zeitnachweis archivieren                           |
| HARD-Modus ist angefordert                 | als SOFT behandeln; keine Audit-Quelldaten löschen                                   |

## Ausnahmen und Grenzfälle

Die Rotationsgrenze wird als Audit-ID zu einem Zeitstichtag bestimmt, damit
später eintreffende Datensätze mit älterem Ereigniszeitpunkt die bereits
gewählte Folge nicht rückwirkend verschieben. Ein gespeicherter TSA-Token gilt
nur nach Prüfung gegen den tatsächlichen Datei-Hash und die konfigurierte
Vertrauenskette als gültig.

## Beispiele

### Normalfall

Der Wochenlauf exportiert die fälligen lückenlosen Folgen Segment für Segment,
bis nichts mehr fällig ist oder sein Zeitbudget erreicht ist. Für jedes
Segment verifiziert er jede Zeile und ihre Vorgängerbindung, schreibt die
NDJSON-Datei in den geschützten Bucket und registriert ID-Bereich, Datei-Hash,
Storage-Key und Stempelstatus.

### Grenzfall

Der Prozess stürzt nach erfolgreichem Upload, aber vor dem DB-Insert ab. Beim
nächsten Lauf stimmt das vorhandene Objekt in Größe und Hash überein; die
fehlende Segmentregistrierung wird nachgeholt, ohne ein zweites Objekt zu
erzeugen.

## Umsetzung in TaxTronik

`archive.ts` definiert das stabile Segmentformat, berechnet den Datei-Hash und
prüft jede enthaltene Kettenzeile. `audit-rotate.ts` wählt den nächsten Bereich,
rechnet vor jedem Upload die serialisierten Zeilen und ihre Vorgängerbindung
nach und setzt die COMPLIANCE-Retention. Ein bedingter PUT verhindert das
Überschreiben eines bereits vorhandenen Schlüssels. Bei Wiederholungen wird
das bestehende Objekt größenbegrenzt gestreamt und sein SHA-256 gegen das
deterministische Segment geprüft; eine reine Head-Erfolgsantwort genügt nicht.
Erst danach registriert der Job das Segment tenantgebunden.

Die Zeitstempelstelle wählt `tsa-port.ts` wie für Tagessiegel und Rolling
Anchors: Kanzlei-Einstellung, sonst `TIMESTAMP_AUTHORITY_URL`, sonst die
verifizierte Standard-TSA; vor dem Stempeln muss sie öffentlich auflösbar sein.
Gespeichert wird nur ein externer RFC-3161-Token, der gegen den Datei-Hash und
die konfigurierten Trust-Roots verifiziert ist; ein lokaler
Entwicklungs-Zeitstempel zählt nicht. Ohne solchen Token, etwa bei TSA-Fehler
oder nicht auflösbarer TSA, wird das Segment mit `tsa_status = PENDING`
archiviert. Jeder Lauf stempelt zuerst die
PENDING-Segmente des Tenants seitenweise nach, nachdem er Größe, SHA-256 und
Kettenanker des gesperrten Objekts gegen die Archivzeile geprüft hat; ein
abweichendes Objekt wird protokolliert und nie gestempelt, ein TSA-Fehler
beendet das Nachstempeln für diesen Tenant. Der Update-Trigger der sonst
insert-only geführten Archivzeile erlaubt ausschließlich den einmaligen
Übergang `PENDING` → `STAMPED_LATE`, der nur Token, Seriennummer, Status und
Stempelzeitpunkt setzt. ID-Bereich, Kettenanker, Datei-Hash, Speicherort,
Modus und Archivierungszeitpunkt bleiben unveränderlich; DELETE und TRUNCATE
bleiben gesperrt.

Ein Lauf archiviert je Tenant Segment um Segment, bis nichts mehr fällig ist
oder das Zeitbudget von zehn Minuten verbraucht ist; fährt der Worker herunter,
endet der Lauf vor dem nächsten Schritt. Nach dem ersten gescheiterten Stempel
entstehen die weiteren Segmente dieses Tenants im selben Lauf ohne neuen
TSA-Versuch als PENDING. Das Job-Ergebnis meldet den Rückstand fälliger, noch
nicht archivierter Einträge und die Zahl noch ungestempelter Segmente; die
Jobübersicht der Administration zeigt den Rückstand an.

Ein vollständiger Lauf meldet den Rückstand zusätzlich als Health-Kennzahl:
Anzahl, Fälligkeit des ältesten offenen Eintrags (Ereigniszeitpunkt plus
Mindestalter) und die Zahl der Läufe in Folge mit Rückstand, sichtbar in der
Jobübersicht und für ADMIN/PARTNER in `/api/health/detail`, ohne
Kanzleibezug. Besteht der Rückstand nach drei Läufen in Folge noch oder ist
der älteste offene Eintrag seit mehr als sieben Tagen fällig, erhalten die
aktiven ADMIN/PARTNER jeder betroffenen Kanzlei einen Hinweis mit deren
eigenen Zahlen (höchstens eine Neuanlage je Empfänger und Tag) und die
Betriebsadresse `OPS_ALERT_EMAIL` höchstens eine Mail je Tag. Die Schwelle ist
eine Betriebsvorgabe, keine fachliche Frist; der Alarm ändert weder Auswahl
noch Inhalt oder Ablage der Segmente.

Eigene JSON-Schlüssel einschließlich `__proto__` werden beim NDJSON-Export
vollständig erhalten. Die gemeinsame Kanonisierung verwendet dafür ein
Objekt ohne geerbte Setter. Eine Änderung allein in einem solchen Feld führt
bei der erneuten Zeilenprüfung zum Hashfehler (`AUDIT-HASH-CHAIN-001`).

## Bekannte Abweichungen und Grenzen

Der Quellcode-Abgleich vom 1. Oktober 2026 stellte eine frühere Abweichung zu
dieser Regel fest: Der Worker serialisierte ohne eigene Kettennachrechnung
und übernahm ein vorhandenes Objekt allein anhand einer erfolgreichen
Head-Abfrage. Die Korrektur schließt diese beiden Prüfungen vor Upload bzw.
Registrierung. Bereits registrierte Altsegmente werden dadurch nicht
rückwirkend validiert und bleiben Gegenstand der separaten Archivprüfung.

Der dokumentierte HARD-Modus ist nicht implementiert: Eine HARD-Anforderung
wird auf SOFT normalisiert und `audit_log` bleibt vollständig in der
Datenbank. Ein TSA-Ausfall blockiert die Archivierung bewusst nicht; das
Segment wird dann ohne externen Zeitstempel mit dem Status `PENDING` archiviert
und erst von einem späteren Lauf nachgestempelt (`STAMPED_LATE`). Bis dahin
fehlt für dieses Segment der externe Zeitnachweis; der nachträgliche Token
belegt nur den späteren Stempelzeitpunkt. Die konfigurierte
zehnjährige Storage-Retention ist eine Produkteinstellung, keine fachliche
Feststellung der im Einzelfall richtigen Frist.

Die frühere Kanonisierung konnte `__proto__` bereits beim Archivexport
auslassen. Ein späterer Prüfer kann einen in der Archivdatei gar nicht mehr
enthaltenen Wert nicht rekonstruieren. Altbestände sind deshalb gegebenenfalls
mit den erhaltenen Quelldaten abzugleichen. Die Korrektur überschreibt weder
Archivobjekte noch historische Hashes und führt keinen Legacy-Fallback ein,
der die fehlende ursprüngliche Feldbindung verdecken würde.

## Fachliche Prüffragen

- Welche Aufbewahrungsfrist gilt für Audit-Segmente im konkreten Verfahren?
- Ist Archivierung ohne externen TSA-Token zulässig, und welche Nachholung ist
  dann erforderlich?
- Soll ein HARD-Modus jemals Quelldaten löschen dürfen und unter welchen
  Freigabe- und Prüfvoraussetzungen?
- Wie werden Lesbarkeit, Restore und Vollständigkeit der archivierten Segmente
  regelmäßig nachgewiesen?

## Technische Nachweise

Die Pakettests prüfen deterministische Serialisierung, Datei- und Zeilenhashes,
Ankergrenzen und fehlerhafte Segmente. Worker-Tests decken Segmentauswahl,
Object-Lock-Parameter, idempotente Registrierung, Unterbrechungs-Recovery,
TSA-Fehler und die SOFT-Behandlung einer HARD-Anforderung ab. Sie belegen
außerdem die Archivierung als PENDING bei TSA-Fehler, nicht auflösbarer TSA
oder lokalem Zeitstempel, das Verwerfen nicht verifizierter Antworten, das
Nachstempeln nach Objekt- und Kettenprüfung, das Ausbleiben eines Stempels für
abweichende Objekte, den Abbruch beim ersten TSA-Fehler sowie den Nachlauf bis
zum Zeitbudget mit gemeldetem Rückstand. Die Tests zum Rückstandsalarm belegen
die Messung je Tenant samt Fälligkeit des ältesten Eintrags, die Schwelle
(Läufe in Folge oder Alter seit Fälligkeit), Empfänger und Tagesdedupe von
Hinweis und Mail sowie die Health-Ausgabe ohne Kanzleibezug, der
Notification-Datenbanktest die Tagesgrenze der Hinweise. Der Datenbanktest
belegt, dass der
Update-Trigger nur den einmaligen Nachstempel eines PENDING-Segments zulässt,
und die Einordnung von Bestandssegmenten nach vorhandenem Token. Der
TSA-Port-Test belegt die Auswahlreihenfolge und die Auflösbarkeitsprüfung vor
dem Stempeln.
Die Worker-Regressionen zu `AUDIT-ARCHIVE-001` rechnen echte gültige und
manipulierte Quellzeilen nach. Sie verweigern Recovery bei verändertem Inhalt,
abweichender Header-Größe oder einem überlangen Stream, ohne einen
Archivdatensatz oder ein Ersatzobjekt zu erzeugen.
Die Schlüsselregressionen prüfen zusätzlich den verlustfreien Export, die
Nachrechnung, eine ausschließlich im Sonderfeld veränderte Archivzeile und
die Ablehnung eines historischen Hashes mit ausgelassenem Feld.
