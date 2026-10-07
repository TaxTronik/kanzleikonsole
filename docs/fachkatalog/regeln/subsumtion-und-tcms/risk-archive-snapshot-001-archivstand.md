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
    gzip-JSON-Snapshot einschließlich Rich-Doc in den geschützten Bucket
    geschrieben. Gemeinsame Parent-Locks, Inhaltsvergleich nach Storage-I/O
    und DB-Trigger schützen den archivierten Kernstand. Das Rohresultat bleibt
    referenziert. Snapshot und Rohresultat stehen vor dem Schreiben als
    Speicherabsicht im Journal (DOC-UPLOAD-JOURNAL-001); ein nach Storage-/DB-Fehlern
    unverknüpfter Blob bleibt bis zum Retention-Ende bestehen und wird danach bereinigt.
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
  - packages/db/src/risk-analysis.ts
  - packages/db/prisma/migrations/20261001000000_risk_archive_consistency/migration.sql
  - apps/web/src/server/risk/reanalyze.ts
  - apps/web/src/server/risk/catalog-feedback.ts
  - apps/web/src/server/risk/delegate.ts
  - apps/web/src/server/risk/markings.ts
  - apps/web/src/server/risk/norms.ts
  - apps/web/src/server/risk/reformat.ts
  - apps/worker/src/jobs/risk-analyse-llm.ts
  - apps/web/src/server/dsgvo/anonymize-client-data.ts
  - apps/web/src/app/staff/(protected)/admin/dsgvo-retention/actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/_guards.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/actions.ts
test_refs:
  - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/__tests__/guards-tx.test.ts
  - apps/web/src/server/risk/__tests__/archive.test.ts
  - apps/web/src/server/risk/__tests__/reanalyze.test.ts
  - apps/web/src/server/risk/__tests__/delegate.test.ts
  - apps/web/src/app/staff/(protected)/admin/dsgvo-retention/__tests__/tax-data-actions.test.ts
  - apps/web/src/server/dsgvo/__tests__/client-retention.test.ts
  - apps/worker/src/jobs/__tests__/risk-analyse-llm.test.ts
  - packages/db/src/__tests__/risk-archive-consistency.test.ts
feature_refs:
  - docs/anwenderdoku/subsumtion-tcms-quantenlos.md
  - docs/assurance/known-limits.md
related_rules:
  - RISK-AI-SUGGESTION-001
  - RISK-EXTERNAL-ANONYMIZATION-001
  - TCMS-SAMPLE-PROOF-001
  - DSGVO-MANDATE-ANONYMIZATION-001
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
Arbeitsstand. Analyse und Markierungen werden gemeinsam gesperrt und nach dem
Storage-Schreiben nochmals inhaltlich verglichen. Er ist wegen referenzierter
Rohresultate und weiterer Folgeobjekte nicht vollständig selbsttragend.

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

| Wenn                                                                             | Dann                                                                                                                       | Begründung                                                |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Analyse fehlt oder ist bereits archiviert                                        | Archivierung abbrechen                                                                                                     | kein stilles Überschreiben eines Archivstands             |
| aktueller Stand wurde geladen                                                    | Snapshot mit Analysemetadaten, Text und sortierten Markierungen bilden                                                     | reproduzierbare Momentaufnahme                            |
| JSON ist erstellt                                                                | SHA-256 über die unkomprimierten Bytes bilden und anschließend gzip komprimieren                                           | Hash bindet den serialisierten Inhalt                     |
| Store verfügbar ist                                                              | Objekt im GOBD-Tier mit COMPLIANCE-Retention schreiben                                                                     | produktseitiger Speicherschutz                            |
| Store-Schreiben gelingt und gesperrter Kernstand unverändert ist                 | `archivedAt`, Bucket und eindeutigen Versuchsschlüssel in einer Tenant-Transaktion speichern und Hash/Metadaten auditieren | Livezustand und Nachweis referenzieren denselben Snapshot |
| Kernstand während Storage-I/O geändert oder bereits archiviert wurde             | Archivbindung abbrechen; bereits geschriebenen Blob nicht überschreiben                                                    | veralteten Inhalt nicht als aktuellen Stand ausgeben      |
| zentrale Analyse-, Markierungs- oder Recherchemutation nach Archivierung erfolgt | Guard lehnt die Änderung ab                                                                                                | archivierter Kernstand soll schreibgeschützt bleiben      |
| fachliche Änderung nötig wird                                                    | neuen Arbeitsstand beziehungsweise neue Version anlegen                                                                    | keine stille Änderung des archivierten Snapshots          |

## Ausnahmen und Grenzfälle

Der Snapshot bettet das rohe Engine-Ergebnis nicht ein, sondern speichert nur
dessen Bucket-/Key-Referenz. Seit Payload-Version 2 ist auch das formatierte
`sourceDoc` eingebettet; vorhandene Version-1-Archive bleiben unverändert. „Selbsttragend“
gilt deshalb nur für die unmittelbar eingebetteten Analyse- und
Markierungsdaten, nicht für sämtliche Ursprungsobjekte.

Object-Store-Write und nachfolgende Datenbanktransaktion sind keine gemeinsame
Transaktion. Gelingt der Store-Write und scheitert danach DB-Update oder Audit,
kann ein geschütztes Objekt ohne passenden Live-Verweis verbleiben. Jeder
Versuch nutzt einen eigenen UUID-Key, sodass ein unterlegener Parallelversuch
die referenzierten Bytes des Gewinners nicht ersetzt. Die Speicherabsicht
steht vor dem Write im Storage-Orphan-Journal und wird mit dem Archivverweis
abgeschlossen; einen unverknüpften Blob löscht der Cleanup-Worker nach dem
Retention-Ende versionsgenau. Vor dieser Umstellung ohne Journal geschriebene
Blobs bleiben unerfasst.

Die zentralen Guards und die transaktionale DB-Grenze sperren den Kernstand.
`guardAnalysisVertraulich` lässt eine spätere Vertraulichkeitsänderung bewusst
zu, weil sie als Zugriffsentscheidung gilt. Die bestehende manuelle
NATPERS-Anonymisierung darf nach ihrem Produktstichtag und gesetztem
Anonymisierungsmarker ausschließlich `sourceText`/`sourceDoc` sowie
`matchedText`/`notiz` leeren. Sie ändert weder Archivpointer noch Archivblob;
der DB-Backstop verlangt die bestehende aktive Admin-/Partner-Rolle. Eine
neue Löschfreigabe oder abweichende Retentionregel wird dadurch nicht eingeführt.
Weitere Recherche-/Folgeobjekte sind nicht Bestandteil des archivierten
Kernstands; „alle verbundenen Live-Daten vollständig schreibgeschützt“ wäre zu weit.

## Beispiele

### Normalfall

Nach fachlicher Prüfung wird der aktuelle Subsumtionsstand archiviert. Das
gzip-Objekt wird geschützt gespeichert, sein Snapshot-Hash auditiert und
spätere Änderungen an Analyse oder Markierungen werden über die zentralen
Guards abgelehnt.

### Grenzfall

Der Object Store bestätigt den Write, danach fällt die Datenbanktransaktion
aus. Der geschützte Blob kann nicht einfach überschrieben oder gelöscht
werden; die offene Speicherabsicht hält ihn auffindbar, und der Archivvorgang
gilt erst mit gebundenem Archivverweis als abgeschlossen.

## Umsetzung in TaxTronik

`archive.ts` lädt Analyse, Mandantenname und nach Start/Ende/ID sortierte
Markierungen unter dem gemeinsamen Analyse-Row-Lock. Es baut den JSON-Payload,
hasht und komprimiert ihn, journalisiert die Speicherabsicht und schreibt ihn
außerhalb der DB-Transaktion mit Retention. Danach liest `commitRiskArchiveTx`
den Stand erneut unter demselben Lock. Nur bei identischem Inhalts-Hash werden
Archivstatus, Abschluss der Speicherabsicht und `risk.analysis.archived` in
derselben Transaktion gespeichert. Payload und
DB verwenden denselben Archivzeitpunkt. Eine fehlgeschlagene Audittransaktion
rollt auch den Archivpointer zurück.

Titel, Formatierung, Markierungen, Normkuratierung, Delegation, Katalogbindung,
Reanalyse und LLM-Worker sperren den Parent vor Read/Write. Reanalyse und Worker
prüfen nach externer I/O zusätzlich den unveränderten Sachverhalt; verspätete
Ergebnisse dürfen einen archivierten oder redigierten Stand nicht ergänzen.
Der Worker prüft dies zusätzlich nach einem eventuell langen Modellwarmlauf,
bevor er den Queue-Sachverhalt zur Analyse sendet. Die Sperrfolge ist
Mandant (`FOR KEY SHARE`) vor Analyse (`FOR UPDATE`) vor tenantweitem
Audit-Lock. Der manuelle DSGVO-Pfad besitzt den Mandanten-`FOR UPDATE`-Lock
und sperrt seine Analysen vor dem ersten Kontakt-Audit. Dadurch entstehen
zwischen den geprüften Archiv-/Delegations-/DSGVO-Pfaden keine umgekehrten
Mandanten-, Analyse- und Audit-Lockfolgen. Ein zwischenzeitlich geänderter
Mandantenbezug wird nach dem Analyse-Lock abgelehnt.
DB-Trigger serialisieren auch rohe SQL- und verschachtelte Prisma-Schreibwege
an Markierungen und verhindern spätere Kernänderungen einschließlich
Archivpointer-Austausch und Umhängen einer Markierung. Administrative
Tenant-Kaskaden bleiben möglich; ein einzelnes archiviertes Objekt darf nicht
gelöscht werden. Das historische, wegen entfernter `rawResult`-Spalte nicht
mehr lauffähige Backfill-Skript erhält ebenfalls einen Archivguard und wird
hierdurch nicht reaktiviert.
`_guards.ts` prüft `archivedAt` bei den zentralen Analyse-, Markierungs- und
Recherche-Schreibpfaden und weist dort Mutationen zurück.

## Bekannte Abweichungen und Grenzen

Die Umsetzung ist teilweise. Snapshot, Hash, Speicherschutz, Audit und
wesentliche Schreibguards sind vorhanden. Es fehlen ein vollständig
eingebettetes Rohresultat, Archivguards für sämtliche weiteren Folgeobjekte und
End-to-End-Abruf aus dem tatsächlichen Object Store; unverknüpfte Blobs werden
erst nach dem Retention-Ende bereinigt. Die DB kann die Wahrheit eines vom berechtigten
Anwendungspfad gelieferten S3-Pointers nicht unabhängig prüfen. Der Bucketname oder die Bezeichnung
„GoBD“ ist kein fachlicher Konformitätsnachweis.

Die Lockfolge ist keine allgemeine Deadlock-Freiheitsgarantie für beliebige
rohe Multiobjekt-Transaktionen. Solche Konflikte müssen abbrechen, statt einen
abweichenden Kernstand zu binden. Ein externer Katalog-Definitionsaufruf kann
bereits erfolgreich sein, wenn die anschließende lokale Markierungsbindung
wegen paralleler Archivierung abgelehnt wird; beide Dienste teilen keine
Transaktion. Die DB-Sperre kann auch einen bereits gestarteten externen
Engine-Aufruf nicht nachträglich zurücknehmen.

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
`archive.test.ts` prüft gzip-Inhalt einschließlich Rich-Doc, Hash, eindeutige
Versuchsschlüssel, geänderten Stand während des Uploads und Storagefehler
sowie die Journal-Reihenfolge, Journal- und PUT-Fehler und einen Abbruch
zwischen PUT und Commit.
Die PostgreSQL-Tests verwenden echte konkurrierende App-Verbindungen und
beobachten `pg_blocking_pids`: normale, rohe und verschachtelte Writer warten
auf die Archivtransaktion und scheitern danach; umgekehrt erkennt die finale
Inhaltsprüfung einen zuerst abgeschlossenen Writer. Zwei Archivversuche können
nur einen Pointer binden. Weitere Fälle prüfen Auditrollback, Owner-Writer,
Metadaten-/Formatänderungen und die eng begrenzte vorhandene DSGVO-Redaktion.
Worker-/Reanalyse-Tests prüfen die spätere Zurückweisung externer Ergebnisse.
Weitere echte PostgreSQL-Proben verwenden die produktive `EvidenceService.record`-
Implementierung und den Delegations-Client-Fremdschlüssel zusammen mit
konkurrierender Retention, einschließlich beider Startreihenfolgen. Diese
Audit-Lockproben rollen ihre vollständigen Testtransaktionen zurück; sie
deaktivieren keine Append-only-Guards zur Bereinigung.
Echte Object-Lock-Durchsetzung und Ende-zu-Ende-Wiederherstellung werden durch
diese Tests nicht bewiesen.
