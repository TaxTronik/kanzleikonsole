---
id: DOC-UPLOAD-JOURNAL-001
title: Geschützte Uploads über eine auffindbare Speicherabsicht wiederaufnehmen
domain: dokumente-und-aufbewahrung
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Dokumentation und Archiv
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    Der zweiphasige Helper und der GwG-Onboarding-Pfad journalisieren einen
    festen PENDING-Intent vor dem Object-Write und können ihn wiederaufnehmen.
    Mehrere andere geschützte Commit-Pfade schreiben hingegen zuerst in den
    Store und besitzen nur eine nachgelagerte Orphan-Kompensation.
sources:
  - kind: product_documentation
    citation: Technische Modulbeschreibung Dokumentenarchiv, Upload- und Kompensationsgrenzen
    path: docs/development/module/dokumentenarchiv.md
    checked_at: '2026-08-24'
    primary: true
code_refs:
  - apps/web/src/server/documents/resumable-upload.ts
  - apps/web/src/server/documents/upload-helpers.ts
  - apps/web/src/server/documents/storage-compensation.ts
  - apps/web/src/app/gwg-onboarding/actions.ts
test_refs:
  - apps/web/src/server/documents/__tests__/resumable-upload.test.ts
  - apps/web/src/server/documents/__tests__/upload-helpers.test.ts
  - apps/web/src/server/documents/__tests__/storage-compensation.test.ts
feature_refs:
  - docs/development/module/dokumentenarchiv.md
related_rules:
  - DOC-OBJECT-LOCK-001
  - DOC-VERSION-IMMUTABILITY-001
tags:
  - upload
  - journal
  - recovery
---

# DOC-UPLOAD-JOURNAL-001 — Geschützte Uploads über eine auffindbare Speicherabsicht wiederaufnehmen

## Kurzfassung

Der zweiphasige Uploadpfad persistiert vor dem Object-Store-Write eine
`PENDING`-Dokumentversion mit festem Bucket, Schlüssel, Hash, Größe und
Retention. Nach einem mehrdeutigen Commit kann genau dieser Intent gesucht und
auf `CLEAN` finalisiert werden. Diese Vorab-Journalisierung ist derzeit nicht
einheitlich auf allen geschützten Uploadwegen eingesetzt.

## Wann gilt die Regel?

Die Regel gilt unmittelbar für Aufrufer von
`persistResumableDocumentUpload` und für den entsprechend aufgebauten
GwG-Onboarding-Upload. Direkte Staff-Dokumentuploads, neue Versionen,
Archivierungs- und weitere interne Commitpfade können andere
Kompensationsmechanismen verwenden und sind nicht vollständig von der
Vorab-Intent-Garantie erfasst.

## Benötigte Angaben

- tenantgebundener Mutationskontext
- bereits geprüfte Bytes und vorbereitete Speicherabsicht
- feste Dokument- und Versions-ID
- Bucket, Schlüssel, Hash, Größe, Schutz und Retention
- fachlicher Guard und optionaler Pending-/Complete-Audit
- bei Wiederaufnahme die stabile Dokument-ID

## Entscheidungslogik

| Wenn                                             | Dann                                                                   | Begründung                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------- |
| neuer zweiphasiger Upload beginnt                | Bytes prüfen und `PENDING`-Intent in einer Transaktion speichern       | Objekt ist vor dem Write auffindbar             |
| Journaltransaktion scheitert                     | kein Objekt schreiben                                                  | keine unsichtbaren geschützten Bytes erzeugen   |
| Store-Commit gelingt                             | genau die passende PENDING-Version per CAS auf `CLEAN` setzen          | Intent und Objektidentität bleiben gebunden     |
| Commit- oder Finalize-Antwort ist mehrdeutig     | PENDING-ID zurückgeben und später wiederaufnehmen                      | wiederholbarer Recovery-Pfad                    |
| genau eine identische Store-Version existiert    | diese Version übernehmen, keinen zweiten PUT senden                    | Idempotenz                                      |
| mehrere oder abweichende Versionen existieren    | fail-closed abbrechen                                                  | mehrdeutiger Beweisstand                        |
| direkter Commit scheitert erst nach Store-Erfolg | `StorageOrphan` nachgelagert journalisieren, sonst strukturiert loggen | begrenzte Kompensation außerhalb des Vorabpfads |

## Ausnahmen und Grenzfälle

Eine PENDING-Zeile kann absichtlich länger bestehen, wenn Store oder
Datenbank ausfallen; sie ist ein Untersuchungs- und Wiederaufnahmepunkt, kein
fertiges Dokument. Bei direktem Commit bleibt zwischen Store-Erfolg und
nachgelagertem DB-/Orphan-Journal ein Prozessabbruchfenster. Schlägt auch das
Orphan-Journal fehl, verbleibt nur ein strukturiertes Betriebslog. Nicht jeder
intern erzeugte geschützte Blob verwendet das Dokumentjournal.

## Beispiele

### Normalfall

Eine Vollmacht wird vorbereitet und als PENDING journalisiert. Danach wird
exakt der feste Key geschrieben und dieselbe Version auf CLEAN finalisiert;
Pending- und Complete-Nachweis liegen in getrennten Transaktionen.

### Grenzfall

Der Store hat geschrieben, aber die Antwort geht verloren. Beim nächsten
Versuch findet TaxTronik genau eine Version mit dem erwarteten Hash und
finalisiert sie. Existieren zwei Versionen, erfolgt kein automatischer
Gewinnerentscheid.

## Umsetzung in TaxTronik

`upload-helpers.ts` erzeugt und finalisiert die unveränderliche PENDING-Zeile.
`resumable-upload.ts` orchestriert Prepare, Journal, Commit, Recovery und CAS-
Finalize unter Tenant- und Fachguards. Der GwG-Onboarding-Pfad nutzt denselben
PENDING-Grundmechanismus. `storage-compensation.ts` führt für direkte
Store-first-Pfade eine nachgelagerte, ownerseitige Orphan-Reconciliation.

## Bekannte Abweichungen und Grenzen

Die Umsetzung ist teilweise: Die im Scope zunächst allgemein formulierte
Vorab-Journalisierung gilt nicht für alle geschützten Uploadpfade. Insbesondere
direkte Staff-Uploads, neue Versionen und mehrere intern erzeugte Archive
committen vor ihrer Fachtransaktion in den Store. Deren nachgelagertes
Orphan-Journal reduziert, schließt aber das Crash-Fenster nicht vollständig.

## Fachliche Prüffragen

- Müssen sämtliche geschützten Uploadwege zwingend auf den Vorab-Intent migriert werden?
- Wie lange dürfen PENDING-Intents bestehen und wer bearbeitet Konflikte?
- Welche Betriebsnachweise sind bei `LOG_ONLY` erforderlich?
- Wie werden nicht dokumentgebundene geschützte Blobs inventarisiert?

## Technische Nachweise

Die resumierbaren Tests belegen Reihenfolge, Tenantgrenze, Recovery,
Idempotenz und CAS-Finalisierung. Helper-Tests prüfen die persistierte
Speicheridentität. Kompensationstests belegen Orphan-Upsert und den sichtbaren
`LOG_ONLY`-Fall. Die Tests zeigen zugleich nicht, dass jeder Aufrufer den
zweiphasigen Helper verwendet.
