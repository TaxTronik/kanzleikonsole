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
    Die direkten Upload-Pfade sowie Risiko-Archiv und Engine-Rohergebnisse der
    Risikoanalyse journalisieren vor dem PUT eine Speicherabsicht, die ihre
    Commit-Transaktion abschließt; eine offen gebliebene Absicht löst der
    Cleanup-Worker auf, statt sie wiederaufzunehmen.
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
  - apps/worker/src/run-budget.ts
  - apps/web/src/server/documents/resumable-upload.ts
  - apps/web/src/server/documents/upload-helpers.ts
  - apps/web/src/server/documents/storage-compensation.ts
  - apps/web/src/server/documents/journaled-upload.ts
  - apps/web/src/server/documents/storage-intent.ts
  - packages/db/prisma/migrations/20261006130000_storage_orphan_absent_resolution/migration.sql
  - packages/db/prisma/migrations/20261006130100_storage_upload_intent/migration.sql
  - apps/web/src/app/gwg-onboarding/actions.ts
  - apps/web/src/server/inbox/staging-upload.ts
  - apps/web/src/server/inbox/accept-attachment.ts
  - apps/worker/src/jobs/portal-inbox-cleanup.ts
  - packages/db/prisma/migrations/20260901001000_portal_inbox/migration.sql
  - packages/db/prisma/migrations/20260901006000_portal_inbox_resume_and_routing/migration.sql
  - packages/db/prisma/migrations/20260901008000_portal_inbox_reject_pending_acceptance/migration.sql
  - apps/web/src/server/risk/archive.ts
  - apps/web/src/server/risk/raw-store.ts
  - apps/web/src/server/risk/persistence.ts
  - packages/db/prisma/migrations/20261007150000_storage_intent_risk_references/migration.sql
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
  - apps/worker/src/jobs/__tests__/storage-orphan-cleanup-db.test.ts
  - apps/worker/src/__tests__/run-budget.test.ts
  - apps/web/src/server/documents/__tests__/journaled-upload.test.ts
  - apps/web/src/server/documents/__tests__/storage-intent.test.ts
  - packages/db/src/__tests__/storage-upload-intent.test.ts
  - apps/web/src/server/risk/__tests__/archive.test.ts
  - apps/web/src/server/risk/__tests__/persistence.test.ts
feature_refs:
  - docs/development/module/dokumentenarchiv.md
related_rules:
  - DOC-OBJECT-LOCK-001
  - DOC-VERSION-IMMUTABILITY-001
  - PORTAL-INBOX-SUBMISSION-001
  - RISK-ARCHIVE-SNAPSHOT-001
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
auf `CLEAN` finalisiert werden. Diese wiederaufnehmbare Vorab-Journalisierung
ist nicht auf allen geschützten Uploadwegen eingesetzt; die direkten
Upload-Pfade sowie Risiko-Archiv und Engine-Rohergebnisse journalisieren vor
dem Write eine Speicherabsicht, die erst ihre Commit-Transaktion abschließt.

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
fertiges Dokument. Bei direktem Commit steht die Speicherabsicht bereits vor
dem Write im Journal; ein Prozessabbruch oder gescheiterter Commit hinterlässt
eine offene Absicht, die der Cleanup-Worker nach der Sicherheitsfrist auflöst.
Nur wenn eine Absicht beim Freigeben nicht mehr offen ist, greift die
nachgelagerte Orphan-Kompensation; schlägt auch sie fehl, verbleibt nur ein
strukturiertes Betriebslog. Nicht jeder intern erzeugte geschützte Blob
verwendet das Dokumentjournal.

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
Sammeldownload ohne auslieferbare Auswahl liefert 404. Sammeldownload
(`document.download.bulk`) und DATEV-Belegexport (`client.belege.export`)
schreiben je Auslieferung genau einen Abrufnachweis mit Anzahl und
vollständiger Liste der ausgelieferten Dokument-IDs in Archivreihenfolge, erst
nach Größen-, Eintrags- und Slot-Prüfung; fehlt beim DATEV-Export ein Objekt
erst während der Übertragung, bleibt seine ID im Nachweis und `index.csv`
kennzeichnet es als FEHLT.

Diese Kontrolle schließt insbesondere die Lücke zwischen erfolgreichem
Object-Write und noch fehlender Finalisierung. Sie ersetzt keinen Virenscan:
Der Upload prüft fremde Bytes weiterhin vor dem Store-Write. Intern erzeugte,
bereits finalisierte Ausgaben erfüllen dieselben Statusfelder. Ein unbekannter
Altbestand ohne Abschlusszeitpunkt bleibt gesperrt; es erfolgt weder ein
pauschaler Backfill noch ein fingierter Scan-Nachweis.

Der gemeinsame Orphan-Worker zieht je Lauf Batch um Batch zu je 100
Kandidaten, bis kein fälliger Kandidat mehr übrig ist oder das Zeitbudget von
zehn Minuten verbraucht ist; fährt der Worker herunter, endet der Lauf vor dem
nächsten Schritt. Die Auswahl priorisiert die geringste Zahl bisheriger
Bereinigungsversuche, danach Alter und ID. Ein in diesem Lauf gescheiterter
Kandidat kommt erst im nächsten Lauf erneut an die Reihe. So blockiert ein
voller Batch dauerhaft fehlender oder mehrdeutiger Speicheridentitäten keine
späteren bereinigungsfähigen Objekte. Die Schutz-, Referenz- und
Versionsprüfungen bleiben Voraussetzung jeder physischen Löschung. Ab dem
fünften gescheiterten Versuch erscheint zusätzlich ein Betriebswarnhinweis zur
manuellen Klärung. Den danach weiterhin fälligen, unaufgelösten Rückstand
meldet der Lauf im Job-Ergebnis; die Jobübersicht der Administration zeigt ihn
als „Rückstand“. Der Regressionstest belegt in einem Lauf mit 100 dauerhaft
fehlerhaften Objekten und einem jüngeren löschbaren Objekt, dass das löschbare
Objekt im zweiten Batch gelöscht wird und jeder gescheiterte Kandidat höchstens
einen Versuch je Lauf erhält. Weitere Tests belegen den Nachlauf über mehrere
Batches und das Ende am Zeitbudget mit gemeldetem Rückstand.

`upload-helpers.ts` erzeugt und finalisiert die unveränderliche PENDING-Zeile.
`resumable-upload.ts` orchestriert Prepare, Journal, Commit, Recovery und CAS-
Finalize unter Tenant- und Fachguards. Der GwG-Onboarding-Pfad nutzt denselben
PENDING-Grundmechanismus.

Die direkten Upload-Pfade (Staff- und Portal-Upload, neue Version,
Wissensanhang, Umklassifizierung mit erneuter Ablage, Fremdrechnung,
Steuererklärungs-PDF, Formular-Upload, Rechercheablage) laufen über
`journaled-upload.ts`. Eine gemeinsame Vorprüfung je Upload-Art läuft vor Scan,
Journal und Write; vorhersehbare Ablehnungen erzeugen so weder Journal noch
Objekt. Nach Größenprüfung, Virenscan hochgeladener Bytes und Hashbildung
journalisiert `storage-intent.ts` die Speicherabsicht mit festem Bucket,
Schlüssel, SHA-256, Größe, Schutz und Retention über die Owner-Verbindung im
Storage-Orphan-Journal (`intent`); erst danach folgt der bedingte PUT. Die
Commit-Transaktion wiederholt die
Vorprüfung und schließt die Absicht über `app.settle_storage_intent` atomar
ab. Die Funktion verlangt eine Dokumentversion desselben Tenants mit genau
dieser Speicheridentität oder einen Rohergebnis- bzw. Archivverweis einer
Risikoanalyse desselben Tenants auf Bucket und Schlüssel sowie eine offene,
unbeanspruchte Absicht; ihre
Zeilensperre hält einen parallelen Worker-Claim bis zum Commit auf, und eine
bereits vom Worker beanspruchte Absicht lässt den Fachcommit scheitern. Das
E-Rechnungsarchiv journalisiert PDF und XML gemeinsam vor dem ersten PUT.
Scheitert der Commit, bleibt die Absicht mit gebundener Objektversion offen;
`storage-compensation.ts` journalisiert nur noch nachgelagert, wenn die
Absicht nicht mehr offen ist. Der Cleanup-Worker löst offene Absichten nach
der Sicherheitsfrist von 30 Minuten, unter Object Lock erst nach dem
Retention-Ende, auf: referenziert (`REFERENCED`), unreferenziert
versionsgenau gelöscht oder nie geschrieben (`ABSENT`, nur für Absichten ohne
gebundene Objektversion).

Risiko-Archiv (Subsumtions-Snapshot, `risk/archive.ts`) und Engine-Rohergebnis
der Risikoanalyse (`risk/raw-store.ts`) folgen demselben Ablauf im GoBD-Bucket:
Die gzip-Bytes werden als App-eigene Ausgabe ohne Virenscan mit Schutzstufe
GoBD vorbereitet, die Speicherabsicht wird journalisiert und erst danach unter
einem je Versuch neuen, tenantgebundenen Schlüssel (`tenants/<Tenant>/gobd/…`)
bedingt geschrieben. Die Archivtransaktion setzt Archivzeitpunkt und
Archivverweis und schließt die Absicht ab; das Rohergebnis schließt die
Transaktion ab, die die Analyse mit ihrem Verweis anlegt (`risk/persistence.ts`).
Diese Verweise tragen keine Objektversion; als Bezug gelten Bucket und
Schlüssel. Der Cleanup-Worker wertet sie bei der Referenzprüfung wie
Dokumentversionen aus: ein Verweis desselben Tenants schließt die Absicht als
`REFERENCED`, ein tenantfremder Verweis ist ein Integritätsvorfall ohne
Löschung. Scheitert die Fachtransaktion, etwa weil sich der Subsumtionsstand
während des Schreibens geändert hat, bleibt die Absicht mit gebundener
Objektversion offen und wird nach dem Retention-Ende versionsgenau gelöscht.

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
Vorab-Journalisierung als wiederaufnehmbare PENDING-Dokumentversion gilt nicht
für alle geschützten Uploadpfade. Die direkten Upload-Pfade journalisieren
stattdessen eine Speicherabsicht vor dem Write; ein abgebrochener Upload wird
dort nicht wiederaufgenommen, sondern vom Cleanup-Worker aufgelöst. Ein
unverknüpftes Objekt aus Risiko-Archiv oder Engine-Rohergebnis bleibt unter
Object Lock bis zum Retention-Ende bestehen und wird erst danach gelöscht.
Risiko-Objekte, die vor der Journalisierung dieser Pfade ohne Speicherabsicht
geschrieben wurden, erfasst der Worker nicht; eine Bestandsinventur dieser
Altobjekte erfolgt nicht. Bestehende Analysen behalten ihre bisherigen
Schlüssel.

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
wiederholbarer Fehler offen. Eine vor dem Write journalisierte Absicht, unter
deren Schlüssel nach der Sicherheitsfrist weder eine Version noch ein
Delete-Marker existiert, wurde dagegen nie geschrieben und wird als `ABSENT`
abgeschlossen.

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

Die Journal-Tests der direkten Upload-Pfade belegen die Reihenfolge
Vorprüfung, Journal, PUT und Abschluss in der Commit-Transaktion, eine
auflösbare offene Absicht nach einem Abbruch zwischen PUT und Commit, das
Ausbleiben jedes Writes bei gescheiterter Vorprüfung, infizierten Bytes oder
gescheitertem Journal und die Kompensation nur als Rückfallebene.
PostgreSQL-Tests belegen den Abschluss ausschließlich über die eng gebundene
Definer-Funktion, die offene Absicht nach zurückgerollter Fachtransaktion,
`ABSENT` nur ohne gebundene Objektversion und einen bis zum Fachcommit
wartenden Worker-Claim. Der Worker-Datenbanktest belegt versionsgenaue
Löschung, `ABSENT`, `REFERENCED` und das Warten auf das Retention-Ende.

Die Risiko-Tests (`archive.test.ts`, `persistence.test.ts`) belegen für
Archiv-Snapshot und Rohergebnis die Reihenfolge Journal, PUT, Verweis und
Abschluss, das Ausbleiben jedes Writes bei gescheitertem Journal, die offen
bleibende Absicht bei gescheiterter Fachtransaktion und eine auflösbare Absicht
nach einem Abbruch zwischen PUT und Commit. PostgreSQL-Tests belegen den
Abschluss über Rohergebnis- und Archivverweis desselben Tenants und die
Ablehnung eines tenantfremden Verweises; Worker-Tests belegen `REFERENCED`
statt Löschung für beide Verweisarten, auch nach verlorener Commit-Antwort.

### Ergänzung: Mandanten-Assistenten

Die revisionsgebundenen Ausgaben nach `CLIENT-ASSISTANCE-001` nutzen denselben
zweiphasigen Helper. Die Ausgabe reserviert eine feste Revision/Format/Generator-
Identität und bindet ihre PENDING-Dokumentversion in der Journaltransaktion.
Feste PDF-/DOCX-Zeitstempel erlauben identische Wiederaufnahmebytes. Die übrigen
oben beschriebenen Grenzen anderer Uploadwege bleiben unverändert. Nachweise:
`apps/web/src/server/client-assistance/__tests__/outputs.test.ts` und
`apps/web/src/server/client-assistance/__tests__/snapshot.test.ts`.
