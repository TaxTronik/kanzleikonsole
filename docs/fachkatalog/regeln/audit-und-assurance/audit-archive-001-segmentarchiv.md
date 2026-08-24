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
  summary: Der Rotationsjob erzeugt prüfbare NDJSON-Segmente, legt sie im COMPLIANCE-Object-Lock ab und kann Upload- oder Datenbankunterbrechungen vorwärts auflösen.
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
  - apps/worker/src/jobs/audit-rotate.ts
test_refs:
  - packages/evidence/src/__tests__/archive.test.ts
  - apps/worker/src/jobs/__tests__/audit-rotate.test.ts
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

| Ausgangslage                               | Ergebnis                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| kein neuer zusammenhängender Bereich       | keinen leeren Archivdatensatz erzeugen                                    |
| Segment lässt sich vollständig nachrechnen | deterministische Bytes und SHA-256-Dateihash bilden                       |
| Segmentprüfung schlägt fehl                | Upload und Registrierung abbrechen                                        |
| identisches Objekt ist bereits gespeichert | Metadaten per Head-Abfrage prüfen und fehlende DB-Registrierung nachholen |
| Upload gelingt, DB-Registrierung scheitert | Objekt erhalten; späteren Lauf vorwärts recovern lassen                   |
| externe TSA fehlt oder schlägt fehl        | Segment ohne behaupteten externen Zeitnachweis archivieren                |
| HARD-Modus ist angefordert                 | als SOFT behandeln; keine Audit-Quelldaten löschen                        |

## Ausnahmen und Grenzfälle

Die Rotationsgrenze wird als Audit-ID zu einem Zeitstichtag bestimmt, damit
später eintreffende Datensätze mit älterem Ereigniszeitpunkt die bereits
gewählte Folge nicht rückwirkend verschieben. Ein gespeicherter TSA-Token gilt
nur nach Prüfung gegen den tatsächlichen Datei-Hash und die konfigurierte
Vertrauenskette als gültig.

## Beispiele

### Normalfall

Der Wochenlauf exportiert die nächste lückenlose Folge, verifiziert jede Zeile
und ihre Vorgängerbindung, schreibt die NDJSON-Datei in den geschützten Bucket
und registriert ID-Bereich, Datei-Hash und Storage-Key.

### Grenzfall

Der Prozess stürzt nach erfolgreichem Upload, aber vor dem DB-Insert ab. Beim
nächsten Lauf stimmt das vorhandene Objekt in Größe und Hash überein; die
fehlende Segmentregistrierung wird nachgeholt, ohne ein zweites Objekt zu
erzeugen.

## Umsetzung in TaxTronik

`archive.ts` definiert das stabile Segmentformat, berechnet den Datei-Hash und
prüft jede enthaltene Kettenzeile. `audit-rotate.ts` wählt den nächsten Bereich,
setzt die COMPLIANCE-Retention, behandelt Wiederholungen über Storage-Metadaten
und registriert das Segment in einer Tenant-Transaktion.

## Bekannte Abweichungen und Grenzen

Der dokumentierte HARD-Modus ist nicht implementiert: Eine HARD-Anforderung
wird auf SOFT normalisiert und `audit_log` bleibt vollständig in der
Datenbank. Ein TSA-Ausfall blockiert die Archivierung bewusst nicht; das
Segment kann daher ohne externen Zeitstempel vorliegen. Die konfigurierte
zehnjährige Storage-Retention ist eine Produkteinstellung, keine fachliche
Feststellung der im Einzelfall richtigen Frist.

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
TSA-Fehler und die SOFT-Behandlung einer HARD-Anforderung ab.
