---
id: PORTAL-INBOX-SUBMISSION-001
title: Mandantenpost technisch entgegennehmen und erst nach Kanzleientscheidung ablegen
domain: dokumente-und-aufbewahrung
rule_type: product_rule
jurisdiction: EU/DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Kanzleiorganisation und Datenschutz
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    Der opt-in Mandantenposteingang trennt private Uploadentwürfe, technisch
    abgesendete Nachrichten, gescannte Staging-Anlagen und eine spätere
    Kanzleientscheidung. Vor ausdrücklicher Annahme entsteht kein Document;
    die Annahme klassifiziert und teilt das fertige Dokument mandantenweit.
    Die Nachrichtenretention ist organisatorisch zu dokumentieren; eine
    fachliche oder rechtliche Freigabe steht weiterhin aus.
sources:
  - kind: product_documentation
    citation: Sicherer Mandantenposteingang, Technik und offene Betriebsentscheidungen
    path: docs/development/module/portal-inbox.md
    checked_at: '2026-09-01'
    primary: true
code_refs:
  - packages/db/prisma/schema.prisma
  - packages/db/prisma/migrations/20260901000000_portal_inbox_enums/migration.sql
  - packages/db/prisma/migrations/20260901001000_portal_inbox/migration.sql
  - packages/db/prisma/migrations/20260901002000_portal_inbox_notifications/migration.sql
  - packages/db/prisma/migrations/20260901003000_portal_inbox_receipts/migration.sql
  - packages/db/prisma/migrations/20260901004000_portal_inbox_scope_forward/migration.sql
  - packages/db/prisma/migrations/20260901006000_portal_inbox_resume_and_routing/migration.sql
  - packages/db/prisma/migrations/20260901007000_portal_inbox_assignee_refresh/migration.sql
  - packages/db/prisma/migrations/20260901008000_portal_inbox_reject_pending_acceptance/migration.sql
  - apps/web/src/server/settings/portal-features.ts
  - apps/web/src/server/inbox/access.ts
  - apps/web/src/server/inbox/portal-mutations.ts
  - apps/web/src/server/inbox/queries.ts
  - apps/web/src/server/inbox/search.ts
  - apps/web/src/server/inbox/staging-upload.ts
  - apps/web/src/server/inbox/accept-attachment.ts
  - apps/web/src/server/inbox/attachment-delivery.ts
  - apps/web/src/server/inbox/client-notification.ts
  - apps/web/src/app/portal/(protected)/inbox/actions.ts
  - apps/web/src/app/staff/(protected)/inbox/actions.ts
  - apps/worker/src/jobs/portal-inbox-cleanup.ts
test_refs:
  - packages/db/src/__tests__/portal-inbox-rls.test.ts
  - packages/db/src/__tests__/rls-cross-tenant.test.ts
  - apps/web/src/server/settings/__tests__/portal-features.test.ts
  - apps/web/src/app/__tests__/prisma-client-guard.test.ts
  - apps/web/src/server/inbox/__tests__/idempotency.test.ts
  - apps/web/src/server/inbox/__tests__/constants.test.ts
  - apps/web/src/server/inbox/__tests__/staging-upload.test.ts
  - apps/web/src/server/inbox/__tests__/accept-attachment.test.ts
  - apps/web/src/server/inbox/__tests__/rejection.test.ts
  - apps/web/src/server/inbox/__tests__/attachment-delivery.test.ts
  - apps/web/src/server/inbox/__tests__/client-notification.test.ts
  - apps/web/src/server/inbox/__tests__/queries.test.ts
  - apps/web/src/app/portal/(protected)/inbox/__tests__/actions.test.ts
  - apps/worker/src/jobs/__tests__/portal-inbox-cleanup.test.ts
  - apps/worker/src/jobs/__tests__/storage-orphan-cleanup.test.ts
  - apps/e2e/tests/18-portal-inbox.spec.ts
feature_refs:
  - docs/development/module/portal-inbox.md
related_rules:
  - ACCESS-TENANT-RLS-001
  - ACCESS-STAFF-PERMISSION-001
  - ACCESS-NOTIFICATION-RECIPIENT-001
  - ACCESS-SEARCH-SCOPE-001
  - CLIENT-MANDATE-LIFECYCLE-001
  - DOC-PORTAL-SHARING-001
  - DOC-UPLOAD-JOURNAL-001
  - DSGVO-OPERATIONAL-RETENTION-001
  - AUDIT-HASH-CHAIN-001
tags:
  - portal
  - posteingang
  - staging
  - virenpruefung
  - mandantenkommunikation
---

# PORTAL-INBOX-SUBMISSION-001 — Mandantenpost technisch entgegennehmen und erst nach Kanzleientscheidung ablegen

## Kurzfassung

Eine abgesendete Portalnachricht ist ein technischer Eingang, keine fachliche
Annahme, Fristbestätigung, Vollständigkeitsbestätigung oder Erledigung einer
Anforderung. Anlagen bleiben bis zur ausdrücklichen Entscheidung einer
berechtigten Kanzleiperson in einem getrennten Staging-Bestand. Erst eine
Annahme darf ein zugeordnetes `Document` erzeugen. Diese ausdrückliche
Staff-Entscheidung klassifiziert das Dokument und gibt es nach vollständig
erfolgreicher Persistierung auf Mandantenebene frei; bis dahin bleibt es privat.

## Wann gilt die Regel?

Die Regel gilt nur, wenn `portal.features.clientInbox` ausdrücklich `true` ist.
Datei-Uploads verlangen zusätzlich, dass der allgemeine Portal-Dateiupload nicht
deaktiviert ist. Sie gilt für neue Threads, Antworten, Uploadentwürfe,
Staging-Anlagen, Kanzleientscheidungen, Lesestände und zugehörige interne
Benachrichtigungen.

## Benötigte Angaben

- aktueller Tenant, Mandant und aktiver Portal-Kontakt
- aktives, nicht anonymisiertes und nicht beendetes Mandat
- Betreff, Themenkategorie und unveränderlicher Nachrichtentext
- je Mutation eine UUID zur autor- und mandantengebundenen Idempotenz
- je Uploadbatch Zweck, Ersteller, Ablaufzeit und kanonischer Manifest-Hash
- je Anlage Originalname, MIME-Typ, Größe, SHA-256, Storage-Identität und Position
- Scannerstatus sowie getrennte Kanzleientscheidung
- bei Annahme das tatsächlich erzeugte, mandantengleiche Dokument

## Entscheidungslogik

| Wenn                                                      | Dann                                                                                                                                   | Produktgrenze                                                    |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Feature nicht ausdrücklich aktiv                          | Zugriff und Mutation verweigern                                                                                                        | opt-in und fail-closed                                           |
| Uploadbatch ist `OPEN`                                    | nur der Ersteller darf ihn sehen oder verändern                                                                                        | Entwurf ist kontaktprivat                                        |
| Anlage ist noch `PENDING` oder nicht vollständig gebunden | Nachricht nicht damit absenden                                                                                                         | ungeprüfte Bytes werden nicht eingereicht                        |
| alle Anlagen sind `CLEAN` und Manifest stimmt             | Batch atomar an genau eine Nachricht binden und `CONSUMED` setzen                                                                      | technische Integrität, keine fachliche Annahme                   |
| Thread ist abgesendet                                     | alle aktiven Kontakte desselben Mandanten dürfen ihn sehen                                                                             | mandantenweite Kommunikation                                     |
| Kanzleimitarbeiter greift zu                              | `PORTAL_INBOX_MANAGE` und aktueller Mandantenzugriff kumulativ verlangen                                                               | Einzelrecht erweitert keinen Mandantenzugriff                    |
| Anlage wird mit Titel und aktivem Dokumenttyp angenommen  | Schutzstufe, Storage und Retention serverseitig ableiten, `acceptedDocumentId` binden und das fertige Dokument mandantenweit freigeben | Staging und Archiv bleiben getrennt; keine Client-Klassifikation |
| Anlage wird abgelehnt                                     | nur neutralen Reason-Code und ungefährliche Metadaten im Portal zeigen; Download sperren                                               | keine Storage-/Scannerinterna offenlegen                         |
| Anlage ist blockiert                                      | Portal-Bytezugriff immer verweigern; Eintrag aus der sicheren Projektion ausblenden                                                    | Malware-/Prüfdetails bleiben intern                              |
| Thread oder Nachricht wird wiederholt angelegt            | Mutation-ID, Nutzdaten und pseudonyme Batchbindung müssen exakt dem ersten Submit entsprechen; sonst verweigern                        | Retry erzeugt weder zweiten Thread noch still verlorene Anlagen  |

## Ausnahmen und Grenzfälle

Die Annahme einer Anlage klassifiziert sie nicht automatisch nach
Aufbewahrungs-, Steuer-, GwG- oder GoBD-Regeln. Absenderangaben und Dateinamen
sind keine verifizierte Sachverhalts- oder Dokumenttypbestimmung. Das Produkt
verspricht keine synchrone Bearbeitung und leitet aus dem Eingang keine Frist ab.

Ein abgelehnter Eintrag darf über die sichere Quittungsprojektion einen
kanonischen, neutralen Reason-Code zeigen. Freitextbegründungen, Hashes,
Storage-Keys, Bucketnamen, Scannerdiagnosen und blockierte Objekte gehören nicht
in diese Portalprojektion. `REJECTED` und `BLOCKED` sind niemals downloadbar.

## Beispiele

### Normalfall

Ein aktiver Kontakt lädt zwei Dateien hoch. Beide werden sauber gescannt, das
kanonische Manifest stimmt und die Nachricht wird einmalig abgesendet. Ein
zweiter aktiver Kontakt desselben Mandanten sieht den Thread. Eine
Kanzleiperson nimmt eine Anlage an und lehnt die andere mit einem neutralen Code
ab; nur die angenommene Anlage wird mit einem neu erzeugten Dokument verbunden.

### Grenzfall

Der Client wiederholt die Thread-Mutation nach einem Timeout mit derselben
Mutation-ID. Die autor-, tenant- und mandantengebundene Eindeutigkeit liefert
den bestehenden Vorgang statt einen zweiten Thread anzulegen. Eine Anlage mit
abweichendem Manifest oder offenem Scannerstatus kann nicht konsumiert werden.

## Umsetzung in TaxTronik

`PortalInboxUploadBatch` und `PortalInboxAttachment` bilden den Staging-Bestand.
Die Attachment-Zeile besitzt vor Beginn einer Annahme kein Dokument. Der
zweiphasige Übernahmepfad darf das erzeugte, noch ungeteilte PENDING-Dokument
als Resume-Reservierung binden; `decision` bleibt dabei `PENDING_REVIEW` und
wechselt erst nach sauberem Object-Commit und Version-Finalisierung auf
`ACCEPTED`. Trigger schützen Scope, Autoridentität, Statusübergänge, Limits,
Hash-/Storageidentität, Manifestbindung und Dokumentannahme auch gegenüber
privilegierten Anwendungspfaden. Fünf Inbox-Tabellen nutzen `ENABLE` und
`FORCE ROW LEVEL SECURITY` mit actor- und mandantengebundenen Policies.

Der Attachment-Lock bleibt beim Annahmepfad von der letzten Fachprüfung über
Object-Recovery beziehungsweise PUT bis zur CLEAN-/ACCEPTED-Finalisierung
bestehen. Eine parallele Ablehnung gewinnt dadurch vollständig vor dem
Object-Write oder sieht danach den terminalen Annahmestatus. Ist eine frühere
Annahme nach der PENDING-Reservierung unterbrochen, darf der enge DB-Abbruch nur
ein ungeteiltes Dokument desselben Tenant-/Mandanten-/Hash-Scope mit exakt einer
PENDING-Version ohne Storage-Version lösen. Er journalisiert die feste
Storage-Identität, entfernt Version und leeres Dokument und setzt die Anlage in
derselben Transaktion auf `REJECTED`. CLEAN-, Mehrversions-, Hash- oder
Scope-Abweichungen bleiben unverändert und führen zum vollständigen Rollback.

Portal-Thread-Inserts bestimmen den Assignee ausschließlich im DB-Guard: genau
ein aktuell berechtigter Hauptbearbeiter wird gesetzt, andernfalls `NULL` für
den Teamkorb. Verliert ein bestehender Assignee vor einer späteren
Mandantennachricht seinen Zugriff, wird nur dieser stale Wert auf den nun
eindeutigen Hauptbearbeiter oder den Teamkorb neu geroutet; die Zuweisung
vermittelt selbst keinen Zugriff.

Ein Batch läuft als Produktdefault nach 24 Stunden ab, enthält höchstens zehn
Dateien, höchstens 25 MiB je Datei und höchstens 100 MiB insgesamt. Dieser
Draft-Ablauf ist keine Aufbewahrungsfrist für abgesendete Kommunikation.

Die DB-Funktion `app.notify_portal_inbox_activity` ist ein enger, write-only
Pfad für interne Benachrichtigungen. Titel, Link und Ressourcenart werden in der
Datenbank abgeleitet; ein Portalakteur kann keine freien Notification-Inhalte
einschleusen. Die sichere Funktion
`app.portal_inbox_attachment_receipts` liefert für Portalquittungen nur
ungefährliche Metadaten und abgelehnte Reason-Codes. `getPortalInboxThreadTx`
übernimmt ausschließlich `REJECTED` mit gesperrtem Download in das Portal-DTO;
die Basistabelle bleibt für abgelehnte und blockierte Downloads geschlossen.

## Bekannte Abweichungen und Grenzen

Die Datenbankgrenzen und RLS-Fälle sind implementiert und getestet. Der
Anwendungspfad ergänzt serverseitige Actions, resumierbare Storage-Kompensation,
neutrale E-Mail-Hinweise, einen vor dem Provideraufruf dauerhaft committeden
Mail-Claim und transaktionale Idempotenz-Locks. Die pseudonyme Batchbindung wird
zusammen mit dem erfolgreichen Submit in der Auditkette festgehalten, sodass
eine wiederverwendete Mutation-ID mit abweichenden Anlagen fail-closed
scheitert. Offene Entwürfe werden nach 24 Stunden bereinigt: Ein nie
abgesendeter `CLEAN`/`PENDING_REVIEW`-Anhang eines `EXPIRED`- oder
`DISCARDED`-Batches wird über das Orphan-Journal vorgemerkt; ein `CONSUMED`-
Batch oder eine gesetzte Nachrichtenbindung ist vom Draft-Pfad ausgeschlossen.
Abgelehnte oder blockierte Bytes werden nach sieben Tagen über das
Orphan-Journal nachweisbar gelöscht. Der Cleanup arbeitet
je Tenant unter `SYSTEM`-Kontext und schließt jede bereits journalisierte
Storage-Identität vor der Batchbegrenzung aus. Bei einem mindestens 24 Stunden
alten, terminalen Draft-Intent bestätigt der Recovery-Pfad zunächst das Fehlen
der Bytes; erst dann entfernt dieselbe Tenant-Transaktion den kontaktprivaten,
nie abgesendeten Intent und schreibt einen inhaltsfreien Auditnachweis. Beide
Werte sind technische Defaults und keine gesetzlichen Fristen. Für abgesendete
Nachrichten ist ein Kanzleiwert konfigurierbar und vor Aktivierung
organisatorisch zu dokumentieren; eine automatische Nachrichtenlöschung oder
ein allgemeines Legal-Hold-Modell ist bewusst noch nicht implementiert.

Ein Orphan-Journal ohne bekannte Storage-Version wird nicht mit einem bloßen
Delete-Marker als physisch gelöscht quittiert. Der gemeinsame Cleanup muss
zuerst genau eine Hash-/Größen-identische Objektversion recovern und deren ID
dauerhaft am Journal binden. Fehlende oder mehrdeutige Versionsnachweise bleiben
als wiederholbarer Fehler offen und erzeugen keinen Löschabschluss.

## Fachliche Prüffragen

- Wann gilt ein technischer Eingang organisatorisch als gesichtet und wie wird das überwacht?
- Welche neutralen Ablehnungs-Codes sind verständlich und ohne Sicherheitsleck zulässig?
- Wie lange bleiben abgesendete Nachrichten, Quittungen und abgelehnte Anlagen erforderlich?
- Welche Dokumentart, Schutzstufe und Portalfreigabe darf bei Annahme gewählt werden?
- Welche Ersatzkommunikation gilt bei gesperrter, zu großer oder nicht prüfbarer Datei?
- Welche Audit-Ereignisse sind für Einreichung, Annahme, Ablehnung und Download erforderlich?

## Technische Nachweise

Der Datenbanktest belegt kontaktprivate Entwürfe, mandantenweite abgesendete
Threads, kumulativen Staff-Zugriff, sofortigen Rechteentzug, Cross-Tenant- und
Cross-Client-Sperren, unveränderliche Uploadidentität, Manifest- und
Idempotenz-Gates, abgelehnte Safe-Projection, blockierte Downloads sowie die
write-only Benachrichtigung. Zusätzlich prüfen sie den atomaren Abbruch einer
PENDING-Annahmereservierung, fail-closed Scope-/Hash-/Mehrversionsabweichungen
und die Serialisierung einer parallelen Annahme gegen Ablehnung. Diese
Nachweise bestätigen keine fachliche
Bearbeitung, gesetzliche Aufbewahrung oder Kanzleifreigabe.
