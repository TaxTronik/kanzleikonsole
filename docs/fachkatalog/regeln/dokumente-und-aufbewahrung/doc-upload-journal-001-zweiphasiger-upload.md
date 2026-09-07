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
  - apps/web/src/server/documents/delivery-readiness.ts
  - apps/web/src/server/documents/delivery.ts
  - apps/web/src/app/api/staff/documents/download/route.ts
  - apps/web/src/app/api/staff/clients/[id]/datev-belege-export/route.ts
  - apps/worker/src/jobs/storage-orphan-cleanup.ts
  - apps/web/src/server/documents/resumable-upload.ts
  - apps/web/src/server/documents/upload-helpers.ts
  - apps/web/src/server/documents/storage-compensation.ts
  - apps/web/src/app/gwg-onboarding/actions.ts
  - apps/web/src/server/inbox/staging-upload.ts
  - apps/web/src/server/inbox/accept-attachment.ts
  - apps/worker/src/jobs/portal-inbox-cleanup.ts
  - packages/db/prisma/migrations/20260901001000_portal_inbox/migration.sql
  - packages/db/prisma/migrations/20260901006000_portal_inbox_resume_and_routing/migration.sql
  - packages/db/prisma/migrations/20260901008000_portal_inbox_reject_pending_acceptance/migration.sql
test_refs:
  - apps/web/src/server/documents/__tests__/delivery-lifecycle.test.ts
  - apps/web/src/app/api/staff/documents/__tests__/delivery-access.test.ts
  - apps/web/src/app/api/staff/documents/__tests__/bulk-download-readiness.test.ts
  - apps/web/src/app/api/staff/clients/[id]/datev-belege-export/__tests__/route.test.ts
  - apps/web/src/app/api/portal/documents/__tests__/read-rate-limit.test.ts
  - apps/web/src/server/invoicing/__tests__/archive.test.ts
  - apps/web/src/server/documents/__tests__/resumable-upload.test.ts
  - apps/web/src/server/documents/__tests__/upload-helpers.test.ts
  - apps/web/src/server/documents/__tests__/storage-compensation.test.ts
  - packages/db/src/__tests__/portal-inbox-rls.test.ts
  - apps/web/src/server/inbox/__tests__/staging-upload.test.ts
  - apps/web/src/server/inbox/__tests__/accept-attachment.test.ts
  - apps/web/src/server/inbox/__tests__/rejection.test.ts
  - apps/worker/src/jobs/__tests__/portal-inbox-cleanup.test.ts
  - apps/worker/src/jobs/__tests__/storage-orphan-cleanup.test.ts
feature_refs:
  - docs/development/module/dokumentenarchiv.md
related_rules:
  - DOC-OBJECT-LOCK-001
  - DOC-VERSION-IMMUTABILITY-001
  - PORTAL-INBOX-SUBMISSION-001
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

Allgemeiner Download und Vorschau für Staff und Portal sowie Sammeldownload
und DATEV-Belegexport verlangen an der neuesten Dokumentversion `CLEAN` und
einen vorhandenen `scanCompletedAt`. Die Prüfung liegt vor Abrufnachweis und
Object-Store-Zugriff. Ein älterer sauberer Stand ersetzt eine nicht
finalisierte oder gesperrte neueste Version nicht. Einzelabrufe liefern 404;
Sammelausgaben enthalten und zählen nur auslieferbare Dokumente. Ein reiner
Sammeldownload ohne auslieferbare Auswahl liefert 404.

Diese Kontrolle schließt insbesondere die Lücke zwischen erfolgreichem
Object-Write und noch fehlender Finalisierung. Sie ersetzt keinen Virenscan:
Der Upload prüft fremde Bytes weiterhin vor dem Store-Write. Intern erzeugte,
bereits finalisierte Ausgaben erfüllen dieselben Statusfelder. Ein unbekannter
Altbestand ohne Abschlusszeitpunkt bleibt gesperrt; es erfolgt weder ein
pauschaler Backfill noch ein fingierter Scan-Nachweis.

Der gemeinsame Orphan-Worker priorisiert die geringste Zahl bisheriger
Bereinigungsversuche, danach Alter und ID. So blockiert ein voller Batch
dauerhaft fehlender oder mehrdeutiger Speicheridentitäten keine späteren
bereinigungsfähigen Objekte. Die Schutz-, Referenz- und Versionsprüfungen
bleiben Voraussetzung jeder physischen Löschung. Ab dem fünften gescheiterten
Versuch erscheint zusätzlich ein Betriebswarnhinweis zur manuellen Klärung.
Der Regressionstest führt mehrere Läufe mit 100 dauerhaft fehlerhaften
Objekten und einem jüngeren löschbaren Objekt aus.

`upload-helpers.ts` erzeugt und finalisiert die unveränderliche PENDING-Zeile.
`resumable-upload.ts` orchestriert Prepare, Journal, Commit, Recovery und CAS-
Finalize unter Tenant- und Fachguards. Der GwG-Onboarding-Pfad nutzt denselben
PENDING-Grundmechanismus. `storage-compensation.ts` führt für direkte
Store-first-Pfade eine nachgelagerte, ownerseitige Orphan-Reconciliation.

Der Mandantenposteingang persistiert für jede Anlage zuerst eine PENDING-
Staging-Identität mit unveränderlichem Bucket, Key, Hash, Größe, MIME-Typ,
Originalname und Position. Erst nach Object-Write und sauberem Scan wird sie
finalisiert; Submit bindet das kanonische Mehrdatei-Manifest atomar an die
Nachricht. Dieser Pfad erzeugt vor einer Staff-Annahme bewusst noch kein
`Document`.

Beginnt Staff die ausdrückliche Annahme, wird das neu erzeugte PENDING-
Dokument als Resume-Reservierung an die Anlage gebunden. Der letzte
Attachment-Guard und Object-Commit laufen für diesen widerrufbaren Fachzustand
unter demselben Row-Lock wie die CLEAN-/ACCEPTED-Finalisierung. Eine danach
gewählte Ablehnung darf nur die nachweislich unvollständige Ein-Version-
Reservierung desselben Tenant-/Mandanten-/Hash-Scope lösen. Die feste finale
Storage-Identität wird vor dem Entfernen von Version und leerem Dokument
atomar als `StorageOrphan` journalisiert.

## Bekannte Abweichungen und Grenzen

Die Umsetzung ist teilweise: Die im Scope zunächst allgemein formulierte
Vorab-Journalisierung gilt nicht für alle geschützten Uploadpfade. Insbesondere
direkte Staff-Uploads, neue Versionen und mehrere intern erzeugte Archive
committen vor ihrer Fachtransaktion in den Store. Deren nachgelagertes
Orphan-Journal reduziert, schließt aber das Crash-Fenster nicht vollständig.

Abgelaufene oder verworfene Inbox-Drafts werden durch einen eigenen Worker
erfasst. Er löscht Bytes nicht unjournalisiert, sondern übergibt die feste
Storage-Identität idempotent an den gemeinsamen Orphan-Kompensationspfad.
Das gilt auch für bereits `CLEAN` finalisierte, aber nie abgesendete
`PENDING_REVIEW`-Anlagen eines mindestens 24 Stunden alten `EXPIRED`- oder
`DISCARDED`-Batches. `message_id IS NULL` und der terminale Batchstatus bilden
dabei gemeinsam die Abgrenzung zu abgesendeten Eingängen.
Ein dauerhafter Orphan-Eintrag schließt dieselbe Identität unabhängig von
seinem späteren Bereinigungsstatus aus weiteren Cleanup-Batches aus. Findet die
eindeutige Storage-Recovery bei einem mindestens 24 Stunden alten, terminalen
PENDING-Draft keine Bytes, entfernt der Worker ausschließlich den nie
abgesendeten Intent und koppelt dies atomar an einen inhaltsfreien Auditnachweis.
Offene, bereits abgesendete `PENDING_REVIEW`-Eingänge werden davon bewusst
nicht erfasst.

Fehlt einem Orphan-Journal aus einem unterbrochenen Commit noch die konkrete
Storage-Version, löscht der gemeinsame Worker nicht über einen bloßen
Delete-Marker. Er recoveriert zuerst genau eine Hash-/Größen-identische
Objektversion, bindet deren ID dauerhaft am Journal und löscht anschließend
versionsgenau. Abwesenheit, Mehrdeutigkeit oder ein Bindungskonflikt bleiben als
wiederholbarer Fehler offen.

## Fachliche Prüffragen

- Müssen sämtliche geschützten Uploadwege zwingend auf den Vorab-Intent migriert werden?
- Wie lange dürfen PENDING-Intents bestehen und wer bearbeitet Konflikte?
- Welche Betriebsnachweise sind bei `LOG_ONLY` erforderlich?
- Wie werden nicht dokumentgebundene geschützte Blobs inventarisiert?

## Technische Nachweise

Die Auslieferungsregressionen prüfen echte HTTP-Handler und entpackte
ZIP-Inhalte mit `PENDING`, `INFECTED`, `ERROR` und fehlendem Abschlusszeitpunkt
einschließlich einer älteren sauberen Version. Sie belegen, dass gesperrte
Versionen weder gelesen noch als Abruf auditiert werden. Der Lifecycle-Test
verbindet die echten Upload-/Finalize-Helper mit dem allgemeinen Ladepfad;
Archivtests prüfen die Abschlussfelder erzeugter PDF-/XML-Ausgaben. Abgeschlossene
historische Ausgaben benötigen für dieses Gate keine nachträglich ergänzte
Storage-Version-ID. Diese Tests ersetzen keine Bestandsinventur der Kanzlei.

Die resumierbaren Tests belegen Reihenfolge, Tenantgrenze, Recovery,
Idempotenz und CAS-Finalisierung. Helper-Tests prüfen die persistierte
Speicheridentität. Kompensationstests belegen Orphan-Upsert und den sichtbaren
`LOG_ONLY`-Fall. Inbox-DB- und Worker-Tests belegen den atomaren Abbruch der
PENDING-Reservierung, Scope-/Hash-/Mehrversions-Rollback und die
versionsgenaue Recovery vor physischer Löschung. Die Tests zeigen zugleich
nicht, dass jeder Aufrufer den
zweiphasigen Helper verwendet.

### Ergänzung: Mandanten-Assistenten

Die revisionsgebundenen Ausgaben nach `CLIENT-ASSISTANCE-001` nutzen denselben
zweiphasigen Helper. Die Ausgabe reserviert eine feste Revision/Format/Generator-
Identität und bindet ihre PENDING-Dokumentversion in der Journaltransaktion.
Feste PDF-/DOCX-Zeitstempel erlauben identische Wiederaufnahmebytes. Die übrigen
oben beschriebenen Grenzen anderer Uploadwege bleiben unverändert. Nachweise:
`apps/web/src/server/client-assistance/__tests__/outputs.test.ts` und
`apps/web/src/server/client-assistance/__tests__/snapshot.test.ts`.
