---
id: RISK-ARCHIVE-SNAPSHOT-001
title: Subsumtionsstand als geschützten Snapshot archivieren und Änderungen begrenzen
domain: subsumtion-und-tcms
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Subsumtionsnachweise und Archiv
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    Analyse, Sachverhalt, Markierungen und Metadaten werden als gehashter
    gzip-JSON-Snapshot in den geschützten Bucket geschrieben; zentrale
    Inhaltsguards sperren danach Änderungen. Rohresultat und Rich-Doc sind
    nicht vollständig eingebettet, einige nachgelagerte Mutationen sowie
    Storage-/DB-Fehlerfenster bleiben offen.
sources:
  - kind: product_documentation
    citation: Anwenderdokumentation Subsumtion, TCMS und Quantenlos, Export und Archivierung
    path: docs/anwenderdoku/subsumtion-tcms-quantenlos.md
    checked_at: '2026-08-24'
    primary: true
  - kind: internal_policy
    citation: Dokumentierte Produktgrenzen zu Audit- und Wiederherstellungsnachweisen
    path: docs/assurance/known-limits.md
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/server/risk/archive.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/_guards.ts
test_refs:
  - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/__tests__/guards-tx.test.ts
feature_refs:
  - docs/anwenderdoku/subsumtion-tcms-quantenlos.md
  - docs/assurance/known-limits.md
related_rules:
  - RISK-AI-SUGGESTION-001
  - RISK-EXTERNAL-ANONYMIZATION-001
  - TCMS-SAMPLE-PROOF-001
tags:
  - subsumtion
  - archiv
  - snapshot
  - object-lock
  - nachweis
---

# RISK-ARCHIVE-SNAPSHOT-001 — Subsumtionsstand als geschützten Snapshot archivieren und Änderungen begrenzen

## Kurzfassung

TaxTronik serialisiert den aktuellen Sachverhalt, die Analysemetadaten und
alle Markierungen als JSON, bildet darüber einen SHA-256-Wert und speichert
eine gzip-Fassung im geschützten Speicher. Anschließend werden Archivverweis
und Audit-Ereignis gesetzt. Der Snapshot konserviert einen wichtigen
Arbeitsstand, ist aber nicht vollständig selbsttragend und die Sperre erfasst
noch nicht jede mögliche Folgemutation.

## Wann gilt die Regel?

Die Regel gilt, wenn eine vorhandene tenantgebundene Subsumtion bewusst über
`archiveAnalysis` archiviert wird. Sie beschreibt den technischen
Archivierungsstand des Risk-Moduls. Sie beweist weder eine vollständige
steuerliche Aufbewahrungspflicht noch GoBD-Konformität, richtige
Aufbewahrungsdauer, Vollständigkeit aller Vorsystemdaten oder eine fachlich
abgeschlossene Subsumtion.

## Benötigte Angaben

- bestehende, noch nicht als archiviert markierte Analyse
- vollständiger aktueller Klartext-Sachverhalt
- alle zum Zeitpunkt vorhandenen Markierungen und Metadaten
- Tenant- und Actor-Kontext
- verfügbarer geschützter Object Store mit Retention-Unterstützung
- fachliche Entscheidung, dass genau dieser Stand archiviert werden soll

## Entscheidungslogik

| Wenn                                                                             | Dann                                                                                             | Begründung                                           |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Analyse fehlt oder ist bereits archiviert                                        | Archivierung abbrechen                                                                           | kein stilles Überschreiben eines Archivstands        |
| aktueller Stand wurde geladen                                                    | Snapshot mit Analysemetadaten, Text und sortierten Markierungen bilden                           | reproduzierbare Momentaufnahme                       |
| JSON ist erstellt                                                                | SHA-256 über die unkomprimierten Bytes bilden und anschließend gzip komprimieren                 | Hash bindet den serialisierten Inhalt                |
| Store verfügbar ist                                                              | Objekt im GOBD-Tier mit COMPLIANCE-Retention schreiben                                           | produktseitiger Speicherschutz                       |
| Store-Schreiben gelingt                                                          | `archivedAt`, Bucket und Key in einer Tenant-Transaktion speichern und Hash/Metadaten auditieren | Livezustand und Nachweis referenzieren den Snapshot  |
| zentrale Analyse-, Markierungs- oder Recherchemutation nach Archivierung erfolgt | Guard lehnt die Änderung ab                                                                      | archivierter Kernstand soll schreibgeschützt bleiben |
| fachliche Änderung nötig wird                                                    | neuen Arbeitsstand beziehungsweise neue Version anlegen                                          | keine stille Änderung des archivierten Snapshots     |

## Ausnahmen und Grenzfälle

Der Snapshot bettet das rohe Engine-Ergebnis nicht ein, sondern speichert nur
dessen Bucket-/Key-Referenz. Das formatierte `sourceDoc` ist ebenfalls nicht
Teil des Payloads; enthalten ist der serialisierte Klartext. „Selbsttragend“
gilt deshalb nur für die unmittelbar eingebetteten Analyse- und
Markierungsdaten, nicht für sämtliche Ursprungsobjekte.

Object-Store-Write und nachfolgende Datenbanktransaktion sind keine gemeinsame
Transaktion. Gelingt der Store-Write und scheitert danach DB-Update oder Audit,
kann ein geschütztes Objekt ohne passenden Live-Verweis verbleiben. Direkte
Tests für Wiederholung, Parallelaufrufe, diesen Kompensationsfall und das
Abrufen/Verifizieren des gzip-Snapshots fehlen.

Die zentralen Guards sperren viele Inhaltsänderungen über `archivedAt`.
`guardAnalysisVertraulich` lässt eine spätere Vertraulichkeitsänderung bewusst
zu, weil sie als Zugriffsentscheidung gilt. Ergebnisbezogene Guards prüfen
`archivedAt` nicht durchgängig; die Aussage „Live-Analyse vollständig
schreibgeschützt“ wäre daher zu weit.

## Beispiele

### Normalfall

Nach fachlicher Prüfung wird der aktuelle Subsumtionsstand archiviert. Das
gzip-Objekt wird geschützt gespeichert, sein Snapshot-Hash auditiert und
spätere Änderungen an Analyse oder Markierungen werden über die zentralen
Guards abgelehnt.

### Grenzfall

Der Object Store bestätigt den Write, danach fällt die Datenbanktransaktion
aus. Der geschützte Blob kann nicht einfach überschrieben oder gelöscht
werden; ohne einen getesteten Abgleichs- und Kompensationspfad ist der
Archivvorgang nicht als vollständig abgeschlossen zu behandeln.

## Umsetzung in TaxTronik

`archive.ts` lädt Analyse, Mandantenname und sortierte Markierungen, baut den
JSON-Payload, hasht ihn, komprimiert ihn und schreibt ihn mit Retention. Erst
danach werden Archivstatus und `risk.analysis.archived` gespeichert.
`_guards.ts` prüft `archivedAt` bei den zentralen Analyse-, Markierungs- und
Recherche-Schreibpfaden und weist dort Mutationen zurück.

## Bekannte Abweichungen und Grenzen

Die Umsetzung ist teilweise. Snapshot, Hash, Speicherschutz, Audit und
wesentliche Schreibguards sind vorhanden. Es fehlen ein vollständig
eingebettetes Rohresultat und Rich-Doc, umfassende Archivguards für alle
Folgeobjekte, End-to-End-Abruf und Hashprüfung, Parallelitätskontrolle sowie
eine getestete Storage-/DB-Kompensation. Der Bucketname oder die Bezeichnung
„GoBD“ ist kein fachlicher Konformitätsnachweis.

## Fachliche Prüffragen

- Welche Ursprungsobjekte und formatierten Inhalte müssen zwingend im Snapshot
  selbst enthalten sein?
- Welche Mutationen sind nach Archivierung als reine Zugriffspflege zulässig?
- Wie werden Store-Orphans und unklare Parallelarchivierungen abgeglichen?
- Welche Aufbewahrungsdauer gilt für welche Subsumtion und wer gibt sie frei?
- Wie wird die spätere Lesbarkeit und Hashprüfung regelmäßig nachgewiesen?

## Technische Nachweise

Der referenzierte Guard-Test belegt einzelne Autorisierungsentscheidungen und
zeigt, dass die Vertraulichkeit archivierter Analysen bewusst änderbar bleibt.
Er testet `archiveAnalysis`, Object Lock, Snapshotinhalt, Hash, Parallelität,
Kompensation und Ende-zu-Ende-Wiederherstellung nicht.
