---
id: DOC-VERSION-IMMUTABILITY-001
title: Geschützte Dokumentversionen nur anfügen und Schutz nicht herabsetzen
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
  status: implemented
  summary: >-
    Neue Inhalte werden als neue Version gespeichert; bei einer Höherstufung
    bleibt eine bereits geschützte Version bestehen und erhält eine neue
    geschützte Nachfolgeversion. Herabstufung, GwG-Tierwechsel und Verkürzung
    einer gesetzten GoBD-Frist werden blockiert.
sources:
  - kind: product_documentation
    citation: Benutzerhandbuch Dokumente, Versionen und Schutzstufen
    path: docs/anwenderdoku/dokumente.md
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: § 146 Abs. 4 AO
    url: https://www.gesetze-im-internet.de/ao_1977/__146.html
    checked_at: '2026-08-24'
    primary: false
  - kind: official_guidance
    citation: GoBD in amtlicher AO-Handbuchfassung 2025, Unveränderbarkeit und Protokollierung
    url: https://stberh.bundesfinanzministerium.de/ao/2025/Anhaenge/BMF-Schreiben-und-gleichlautende-Laendererlasse/Anhang-33/inhalt.html
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - packages/storage/src/service.ts
  - apps/web/src/server/storage/document-preview.ts
  - apps/web/src/server/documents/delivery-readiness.ts
  - apps/web/src/server/documents/delivery.ts
  - apps/web/src/app/api/staff/documents/download/route.ts
  - apps/web/src/app/api/staff/clients/[id]/datev-belege-export/route.ts
  - apps/web/src/app/api/staff/documents/[id]/new-version/commit/route.ts
  - apps/web/src/server/storage/retag-policy.ts
  - apps/web/src/app/staff/(protected)/documents/actions.ts
  - apps/web/src/server/forms/revision-download.ts
  - packages/db/prisma/migrations/20260831280000_form_submission_revisions/migration.sql
  - packages/db/prisma/migrations/20260831300000_form_revision_source_guard/migration.sql
  - packages/db/prisma/migrations/20260901008000_portal_inbox_reject_pending_acceptance/migration.sql
  - apps/web/src/server/inbox/accept-attachment.ts
  - apps/web/src/server/inbox/staff-mutations.ts
  - apps/worker/src/jobs/storage-orphan-cleanup.ts
  - apps/web/src/server/documents/retag.ts
  - apps/web/src/app/api/staff/admin/audit/export/route.ts
  - packages/storage/src/index.ts
  - apps/web/src/app/api/staff/invoices/[id]/zugferd/route.ts
  - apps/web/src/app/api/staff/invoices/[id]/xrechnung/route.ts
  - apps/web/src/server/invoicing/archive.ts
  - apps/web/src/server/inbox/attachment-delivery.ts
  - apps/web/src/app/api/staff/knowledge/attachments/[id]/route.ts
  - apps/web/src/app/poa/sign/document/route.ts
  - apps/web/src/app/staff/(protected)/mailbox/actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/actions.ts
test_refs:
  - packages/storage/src/__tests__/object-version.test.ts
  - apps/web/src/server/documents/__tests__/delivery.test.ts
  - apps/web/src/server/inbox/__tests__/attachment-delivery.test.ts
  - apps/web/src/app/api/staff/documents/__tests__/bulk-download-filenames.test.ts
  - apps/web/src/server/documents/__tests__/delivery-lifecycle.test.ts
  - apps/web/src/app/api/staff/documents/__tests__/delivery-access.test.ts
  - apps/web/src/app/api/staff/documents/__tests__/bulk-download-readiness.test.ts
  - apps/web/src/app/api/staff/clients/[id]/datev-belege-export/__tests__/route.test.ts
  - apps/web/src/app/api/portal/documents/__tests__/read-rate-limit.test.ts
  - apps/web/src/app/staff/(protected)/documents/__tests__/retag-race.test.ts
  - apps/web/src/server/storage/__tests__/retag-policy.test.ts
  - apps/web/src/app/api/staff/documents/[id]/new-version/commit/__tests__/route-poa-lock.test.ts
  - packages/db/src/__tests__/workflow-expansion.test.ts
  - apps/web/src/server/forms/__tests__/revision-download.test.ts
  - packages/db/src/__tests__/portal-inbox-rls.test.ts
  - apps/web/src/server/inbox/__tests__/rejection.test.ts
  - apps/worker/src/jobs/__tests__/storage-orphan-cleanup.test.ts
  - apps/web/src/server/documents/__tests__/retag-db.test.ts
  - apps/web/src/app/api/staff/documents/__tests__/bulk-download-audit.test.ts
  - apps/web/src/app/api/staff/admin/audit/export/__tests__/route.test.ts
  - packages/storage/src/__tests__/verified-read.test.ts
  - apps/web/src/app/api/staff/documents/__tests__/bulk-download-integrity.test.ts
  - apps/web/src/app/api/staff/documents/__tests__/bulk-download-stream.test.ts
  - apps/web/src/app/api/staff/clients/[id]/datev-belege-export/__tests__/integrity.test.ts
  - apps/web/src/app/api/staff/invoices/[id]/zugferd/__tests__/route.test.ts
  - apps/web/src/app/api/staff/invoices/[id]/xrechnung/__tests__/route.test.ts
  - apps/web/src/server/invoicing/__tests__/archive.test.ts
  - apps/web/src/server/invoicing/__tests__/archive-lock-call-sites.test.ts
  - apps/web/src/server/inbox/__tests__/attachment-delivery-integrity.test.ts
  - apps/web/src/server/inbox/__tests__/accept-attachment.test.ts
  - apps/web/src/app/api/staff/knowledge/attachments/[id]/__tests__/route.test.ts
  - apps/web/src/app/poa/sign/document/__tests__/route-snapshot.test.ts
  - apps/web/src/server/mailbox/__tests__/import.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/subsumtion/__tests__/import-client-doc.test.ts
  - apps/web/src/app/staff/(protected)/documents/__tests__/bulk-actions.test.ts
feature_refs:
  - docs/anwenderdoku/dokumente.md
  - docs/development/module/dokumentenarchiv.md
related_rules:
  - DOC-OBJECT-LOCK-001
  - DOC-RETENTION-CLASS-001
  - FORM-SCHEMA-SNAPSHOT-001
tags:
  - versionierung
  - unveraenderlichkeit
  - retagging
---

# DOC-VERSION-IMMUTABILITY-001 — Geschützte Dokumentversionen nur anfügen und Schutz nicht herabsetzen

## Kurzfassung

TaxTronik überschreibt bei einem normalen Versionsupload keine bestehenden
Bytes, sondern legt eine weitere nummerierte Dokumentversion an. Eine bereits
geschützte Version wird auch beim Retagging nicht auf eine neue Speicheridentität
umgebogen; die höher geschützte Kopie wird angefügt. Schutzstufen und gesetzte
Retention dürfen nicht nachträglich abgesenkt werden.

## Wann gilt die Regel?

Die Regel gilt für neue Versionen und für die Umklassifizierung bestehender
Dokumente. Der besondere Append-Schutz beim Retagging gilt, wenn die bisherige
Version bereits `immutable` ist. Eine ungeschützte Ausgangsversion kann bei
der Höherstufung auf die geschützte Kopie umgebogen und ihr altes Objekt danach
bestmöglich entfernt werden.

## Benötigte Angaben

- aktuelle Dokument- und neueste Versionsidentität
- alte und neue Schutzstufe
- alte und neue Aufbewahrungsdauer
- Byteinhalt, Hash und konkrete Storage-Version der neuen Fassung
- unveränderter Mandanten-, Typ- und Zugriffsstand beim Commit
- Bindung an Vollmacht oder GwG-Prüfsnapshot

## Entscheidungslogik

| Wenn                                                                 | Dann                                        | Begründung                                         |
| -------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------- |
| neue Fassung wird hochgeladen                                        | nächste Versionsnummer anfügen              | alte Fassung bleibt nachvollziehbar                |
| Zielstufe ist niedriger                                              | Umklassifizierung blockieren                | gesetzter Schutz darf nicht entfernt werden        |
| bestehender GwG-Nachweis soll Tier wechseln                          | blockieren und separates Dokument verlangen | eigener Vernichtungsworkflow muss erhalten bleiben |
| GoBD-Frist soll verkürzt werden                                      | blockieren                                  | bestehender COMPLIANCE-Lock ist nicht rücknehmbar  |
| GoBD-Frist wird verlängert oder Stufe erhöht                         | Bytes neu mit höherem Lock speichern        | neue Schutzentscheidung benötigt neues Objekt      |
| Ausgangsversion ist bereits geschützt                                | neue Dokumentversion anfügen                | geschützte Historie nicht umbiegen                 |
| Paralleländerung an Dokument, Typ oder neuester Version wird erkannt | Commit mit Konflikt abbrechen               | kein stale write                                   |
| Dokument ist an versendete Vollmacht oder GwG-Nachweis gebunden      | neue Version blockieren                     | gebundener Snapshot bleibt stabil                  |

## Ausnahmen und Grenzfälle

Metadatenänderungen innerhalb derselben Schutzstufe können ohne neue Bytes
erfolgen, soweit Frist und Tier gleich bleiben. Bei einer ungeschützten
Ausgangsversion bewahrt der Retag-Pfad die alte mutable Storage-Kopie nicht als
eigene historische Version. Ein fehlgeschlagener DB-Commit nach neuem
Store-Objekt führt zur Orphan-Kompensation, nicht zum stillen Erfolg.

## Beispiele

### Normalfall

Zu einem GoBD-Dokument wird eine korrigierte Datei hochgeladen. Version 1
bleibt unverändert; Version 2 erhält eigene Bytes, Hash, Storage-Version und
Audit-Eintrag.

### Grenzfall

Ein bereits geschützter GwG-Beleg soll in GoBD umklassifiziert werden. Das
Produkt blockiert den Tierwechsel. Benötigt die Kanzlei dieselben Bytes auch
für einen anderen Aufbewahrungszweck, muss sie ein separates Dokument mit
eigener Klassifikation anlegen.

## Umsetzung in TaxTronik

Allgemeine Downloads, Vorschauen und Sammel-/DATEV-Exporte wählen zuerst die
neueste Version ohne Scanfilter in der Versionsauswahl. Nur wenn diese `CLEAN`
und mit `scanCompletedAt` finalisiert ist, dürfen ihre Bytes ausgeliefert
werden. Andernfalls bleibt das Dokument für diesen Abruf gesperrt; eine
ältere saubere Version wird nicht als vermeintlich aktueller Beleg eingesetzt.
Die Prüfung verändert weder historische Bytes noch Hashes oder Schutzfelder.

Ist eine konkrete `storageVersionId` gespeichert, geben Byte- und Streamleser
sie an den S3-GET weiter. Das gilt auch für Vorschau, Retag-Quellbytes,
Rechnungsarchive, DATEV-/Sammel-Exporte, Wissensanlagen, Inbox-Übernahmen und
GwG-Originale. Ein Fehler beim Abruf dieser Version erlaubt keinen zweiten
Abruf des aktuellen Schlüssels. Historische bereits finalisierte Datensätze
ohne Storage-Version-ID bleiben beim bisherigen Key-Abruf; das ist keine
nachträglich erfundene Versionsbindung. Akzeptierte Inbox-Anlagen und
Wissensanlagen prüfen ebenfalls den Abschlussstatus der tatsächlich
ausgewählten Dokumentversion.

Jeder Leser einer Dokumentversion oder Anlage mit gespeicherter Fassung prüft
zusätzlich Größe und SHA-256 der gebundenen Version über den gemeinsamen
Leseweg von `@taxtronik/storage` (`fetchVerifiedObjectBytes`,
`streamVerifiedObject`); einen ungeprüften Stream-Leser gibt es nicht mehr. Das
umfasst Download und Vorschau, Sammel- und DATEV-Export, ZUGFeRD- und
XRechnung-Abruf, das Nachziehen der XRechnung aus der archivierten Hybrid-PDF,
Retag-Quellbytes, Abruf und Übernahme von Posteingangsanlagen, die Archivierung
von Smart-Postfach-Anhängen, Wissensanlagen, die Textübernahme der Subsumtion,
das Unterzeichnungsdokument einer Vollmacht sowie Lohn-, Formular-, GwG- und
Mandantenassistenz-Quellen. Abweichende Bytes werden weder ausgeliefert noch
weiterverarbeitet: Gestreamte Abrufe brechen die Antwort ab, bei abweichender
angekündigter Länge schon vor dem ersten Byte; gepufferte Pfade lehnen mit
ihrer bisherigen Meldung ab; der DATEV-Export führt einen solchen Beleg wie ein
fehlendes Objekt in `index.csv` als FEHLT ohne Hash. Ohne gespeicherte
Erwartung lesen nur die Bereitschaftsprobe des Speichers und die
Engine-Rohergebnisse der Risikoanalyse.

Welche Dokumente eine Sammelausgabe verlassen haben, belegt genau ein
Abrufnachweis je Auslieferung; diese Nachweisform hat der Product Owner am
2026-10-07 bestätigt. Der ZIP-Sammeldownload schreibt `document.download.bulk`
mit Anzahl, allen ausgelieferten Dokument-IDs in Archivreihenfolge (ein zugleich
einzeln und per Ordner gewähltes Dokument einmal) und den gewählten Ordnern. Der
DATEV-Belegexport schreibt `client.belege.export` mit dem Mandanten als
Ressource, Anzahl, allen exportierten Dokument-IDs in Archivreihenfolge und dem
Zeitraum. Beide Nachweise entstehen erst nach Größen-, Eintrags- und
Slot-Prüfung und vor dem ersten Objektabruf; abgelehnte Exporte (413/429)
erzeugen keinen. Die ID-Liste wird nicht gekürzt; die ZIP-Eintragsgrenze
begrenzt sie vorab. Ein DATEV-Beleg, dessen Objekt erst beim Streamen fehlt,
bleibt im Nachweis und erscheint in `index.csv` als FEHLT. Einzelabrufe
protokollieren `document.download` mit der Dokument-ID, Vorschauen
`document.preview` nur beim tatsächlichen Byteabruf. Der CSV-Export des
Prüfprotokolls weist Anzahl und IDs beider Sammelereignisse in der Spalte
„Details“ aus; DATEV-Exporte vor dieser Ergänzung tragen keine ID-Liste und
erscheinen dort nur mit ihrer Anzahl.

Die New-Version-Route sperrt Referenzen erneut, bestimmt die nächste Nummer in
der Commit-Transaktion und fügt die Version an. `retag-policy.ts` entscheidet
über Metadatenänderung, Re-Store oder Blockade. Die Retag-Action stabilisiert
Dokument und Zieltyp per Lock; bei einem bereits unveränderlichen Ausgang
erzeugt sie eine neue Version statt eines Updates.

Eine an FormSubmissionRevisionFile gebundene frühere Einreichung behält ihre
Versions- und Storage-Identität auch dann, wenn der allgemeine Beleg ursprünglich
mutable war. Ein enger Datenbanktrigger sperrt Updates von Identität, Inhaltshash,
Größe und ursprünglichen Erstellungsangaben; der Fremdschlüssel verhindert das
Löschen der gebundenen Version. Allgemeines Retagging, das diese Zeile auf neue
Bytes umbiegen würde, scheitert und kompensiert seinen neuen Storage-Commit.
Scanstatusänderungen bleiben möglich, damit eine spätere Quarantäne auch den
historischen Download sperrt. Neue Korrekturbytes können als weitere Version
hinzukommen. Daraus entsteht keine neue gesetzliche Aufbewahrungsfrist.

Eine besondere Löschfreigabe gilt ausschließlich für die noch nicht
finalisierte Resume-Reservierung einer Inbox-Annahme: genau eine Version,
`PENDING`, ohne Storage-Version, ungeteilt, mandantengleich und mit demselben
Hash wie die weiterhin `PENDING_REVIEW`-gebundene Anlage. Nur die enge
SECURITY-DEFINER-Funktion darf diese Version nach atomarem Orphan-Journal
entfernen und die Anlage ablehnen. CLEAN-, Mehrversions-, Scope- oder
Hashabweichungen öffnen diese Ausnahme nicht. Ein Journal ohne konkrete
Storage-Version muss sie vor physischer Löschung eindeutig recovern und binden.

## Bekannte Abweichungen und Grenzen

Beim Quellcode-Abgleich vom 1. Oktober 2026 wurde eine Abweichung festgestellt:
Die zentrale Auslieferung ignorierte vorhandene S3-Version-IDs und konnte
dadurch eine neuere Storage-Fassung unter demselben Key lesen. Der
versionsgebundene Abruf korrigiert diesen Pfad; Altbestände ohne Version-ID
erhalten dadurch keine zusätzliche Speicheridentität.

Keine bekannte technische Abweichung innerhalb des Scopes geschützter
Versionen und Schutz-Herabstufungen. Die Historie eines ungeschützten
Dokuments wird beim ersten Retagging nicht zwingend als eigene alte
Dokumentversion konserviert. Außerdem belegt Versionierung weder die richtige
fachliche Klassifikation noch die Ordnungsmäßigkeit sämtlicher vor- und
nachgelagerter Prozesse.

## Fachliche Prüffragen

- Muss auch die ungeschützte Ausgangskopie bei jeder Höherstufung historisch erhalten bleiben?
- Welche Metadatenänderungen sind ohne neue Version fachlich zulässig?
- Sind alle fachlichen Snapshot-Bindungen vollständig als Versionssperre erfasst?
- Wie werden Korrekturen nach Fehlklassifikation dokumentiert?

## Technische Nachweise

`object-version.test.ts` simuliert unterschiedliche Bytes für aktuellen Key
und gebundene Version und prüft beide realen Storage-Leser sowie Abbruch ohne
Fallback bei fehlender Version. Die Delivery-Regression weist die Weitergabe
aus dem DB-Ladepfad an Download und Preview nach. Inbox-Tests belegen
Versionsweitergabe und die Sperre eines später infizierten Archivdokuments.

Download- und Preview-Routentests prüfen Staff-/Portal-Abrufe einschließlich
des tatsächlichen Preview-Streams. Die Lesetests der übrigen Pfade lassen die
Größen- und SHA-256-Prüfung überwiegend echt laufen (S3 am Storage-Client
gemockt) und belegen identische Bytes bei passender Fassung sowie Abbruch oder
Ablehnung bei abweichenden Bytes gleicher Länge und abweichender angekündigter
Länge; Retag-, Rechnungsarchiv- und Postfachtests belegen die Bindung an Größe
und SHA-256 und die Ablehnung über die Fehlerklasse. Sammel-/DATEV-Tests entpacken echte ZIPs und
belegen, dass eine gesperrte neueste Version auch bei vorhandenem älterem
sauberem Stand weder im Archiv noch in Abrufnachweisen erscheint. Sie prüfen
außerdem genau ein Ereignis je Sammelausgabe mit allen Dokument-IDs in
Archivreihenfolge (2.000 Dokumente ohne Kürzung, DATEV einschließlich eines erst
beim Streamen fehlenden Belegs); der Audit-Exporttest prüft die Spalte
„Details“ für beide Ereignisse und für DATEV-Altereignisse ohne ID-Liste.

Retag-Race-Tests belegen den Abbruch bei Versionsdrift und das Anfügen statt
Update einer geschützten Version. Policy-Tests prüfen Höherstufung,
Herabstufung, GwG-Tierwechsel und Fristverkürzung. Der PoA-/GwG-Routentest
belegt ausgewählte Snapshot-Sperren; er ist kein Vollständigkeitsnachweis aller
fachlichen Bindungen. Der Inbox-Integrationstest belegt zusätzlich, dass nur
die unvollständige Resume-Reservierung atomar abgebrochen wird und parallele
Annahme, abweichender Hash, fremder Scope oder eine zweite Version fail-closed
bleiben.
