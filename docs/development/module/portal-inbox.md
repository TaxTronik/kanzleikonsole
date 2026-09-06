# Sicherer Mandantenposteingang

Stand: 2026-09-01\
Fachkatalog: `PORTAL-INBOX-SUBMISSION-001`, `ACCESS-SEARCH-SCOPE-001`\
Status: technischer Entwurf ohne fachliche oder rechtliche Freigabe

## Zweck und Produktgrenze

Das opt-in Modul stellt einen mandantenseitig initiierten Nachrichtenkanal mit
mehreren Dateien bereit. Eine abgesendete Nachricht ist ausschließlich ein
technisch protokollierter Eingang. Sie bestätigt weder Bearbeitung,
Vollständigkeit, Fristwahrung, Erledigung einer Anforderung noch die fachliche
Einordnung einer Anlage.

Staging-Anlagen sind bis zu einer ausdrücklichen Kanzleientscheidung keine
`Document`-Datensätze. Bei Annahme entsteht genau ein mandantengleiches,
klassifiziertes Dokument. Erst nach vollständiger, hash-erhaltender
Persistierung wird es als Bestandteil derselben ausdrücklichen Staff-
Entscheidung mandantenweit freigegeben; zusätzliche Schutzregeln des gewählten
Dokumenttyps bleiben wirksam.

Während der zweiphasigen Persistierung darf bereits ein ungeteiltes PENDING-
Dokument als Resume-Reservierung existieren. Das ist noch keine Annahme. Wird
dieser Lauf unterbrochen und Staff entscheidet sich stattdessen zur Ablehnung,
darf nur diese exakt hash- und scopegebundene Ein-Version-Reservierung über den
engen atomaren Abbruchpfad gelöst werden.

## Feature- und Autorisierungsgates

`portal.features.clientInbox` fehlt bei Bestands-Tenants und normalisiert dann
auf `false`. Jeder lesende und schreibende Portal-Inbox-Pfad muss das Flag in
seiner Tenant-Transaktion erneut prüfen. Dateiaktionen prüfen zusätzlich
`documentUpload`.

Portal:

- Der Kontakt muss aktiv sein und exakt zu Tenant und Mandant passen.
- Der Mandant muss aktiv, nicht anonymisiert und nicht beendet sein.
- `OPEN`-Uploadbatches sind nur für ihren Ersteller sichtbar.
- `CONSUMED`-Batches, Threads und Nachrichten sind für alle aktiven Kontakte
  desselben Mandanten sichtbar.
- Kontakte sehen niemals Daten eines anderen Mandanten oder Tenants.

Kanzlei:

- Jeder Zugriff verlangt `PORTAL_INBOX_MANAGE` oder den bestehenden
  ADMIN-/PARTNER-Override.
- Zusätzlich gilt der aktuelle OPEN-/RESTRICTED-/Vertraulich-Mandantenzugriff.
- Ein Grant, eine Zuweisung oder eine Notification erweitert diesen
  Mandantenzugriff nicht.
- Rechteentzug muss bestehende Inbox-Notifications und Datenzugriffe sofort
  ausblenden.

Alle fünf Inbox-Tabellen verwenden `ENABLE ROW LEVEL SECURITY` und `FORCE ROW
LEVEL SECURITY`. Clientgebundene Tabellen tragen zusätzlich den zentralen
Tenant-/Client-Paartrigger. SECURITY-DEFINER-Funktionen binden übergebene IDs an
den aktuellen Tenant und Akteur; sie sind kein frei abfragbares
Existenzorakel.

## Datenklassen

| Datenklasse              | Beispiele                                                       | Sichtbarkeit                                                  | Schutz-/Retention-Hinweis                                         |
| ------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| Thread-Metadaten         | Betreff, Topic, Status, Attention, Zuständigkeit                | Mandant und berechtigter Staff                                | Betreff kann personenbezogen oder vertraulich sein                |
| Nachrichtentext          | freier Mandanten-/Kanzleitext                                   | Mandant und berechtigter Staff                                | kein globaler Inhaltsindex, keine Übernahme in Notification/Audit |
| privater Uploadentwurf   | Batch, Zweck, Ablauf, Manifest                                  | nur erstellender Kontakt und berechtigter Staff               | 24-Stunden-Produktdefault nur für `OPEN`                          |
| Staging-Anlagenidentität | Originalname, MIME, Größe, Hash, Bucket/Key/Version             | vollständig nur Kanzlei/System; Portal nur sichere Projektion | vor Annahme kein Archivdokument                                   |
| Scan-/Entscheidungsdaten | PENDING/CLEAN/BLOCKED, PENDING_REVIEW/ACCEPTED/REJECTED/BLOCKED | Kanzlei/System; Portal nur neutraler REJECTED-Code            | keine Scannerdiagnosen im Portal                                  |
| Lesestand                | Thread, Kontakt, Zeitpunkt                                      | kontaktbezogen                                                | vermittelt keinen Threadzugriff                                   |
| interne Notification     | Empfänger, feste Aktivitätsmeldung, Thread-ID                   | berechtigter Staff                                            | kein Betreff, Dateiname, Nachrichtentext oder Reason-Code         |
| Auditnachweis            | Aktion, pseudonyme Ressourcen-IDs, Zustandsmerkmale             | bestehender Audit-Scope                                       | keine Datei-/Mandanten-/Nachrichten-/Suchfreitexte                |

Vor dem Produktivpilot müssen diese Klassen im Verzeichnis der
Verarbeitungstätigkeiten, im Löschkonzept, in Berechtigungsrezertifizierung und
in der Vorfallorganisation der Kanzlei aufgenommen werden. Diese Dokumentation
setzt keine Rechtsgrundlage und keine gesetzliche Frist fest.

## Datenmodell und Lebenszyklus

### Thread und Nachrichten

`PortalInboxThread` trägt Tenant, Mandant, Betreff, `PortalInboxTopic`, Status,
Attention und Zuständigkeit. Topics sind `GENERAL`, `DOCUMENTS`, `BILLING`,
`APPOINTMENT` und `OTHER`; der Default ist `GENERAL`.

`PortalInboxMessage` ist nach dem Insert unveränderlich. Zwei
Eindeutigkeitsgrenzen schützen Retries:

- `(threadId, clientMutationId)`
- `(tenantId, clientId, authorType, authorId, clientMutationId)`

Die zweite Grenze verhindert insbesondere, dass ein wiederholtes
`createInboxThread` mit derselben autorbezogenen Mutation-ID einen zweiten
Thread erzeugt.

### Uploadbatch und Staging-Anlage

`PortalInboxUploadBatch` beginnt als `OPEN` und wird atomar `CONSUMED`,
`DISCARDED` oder `EXPIRED`. Ein Batch enthält höchstens zehn Anlagen, höchstens
25 MiB pro Anlage und höchstens 100 MiB insgesamt. Der Default-Ablauf liegt 24
Stunden nach Erstellung.

`PortalInboxAttachment` speichert vor der Kanzleientscheidung eine eigene
Staging-Identität:

- Tenant, Mandant, Batch und optional gebundene Nachricht
- Originalname und MIME-Typ
- Bucket, Storage-Key und optionale Storage-Version
- SHA-256 als 32 Bytes und Größe als `BigInt`
- 0-basierte Position
- Scannerstatus und getrennte Entscheidung
- während einer resumierbaren Annahme optional das noch ungeteilte
  PENDING-`acceptedDocumentId`; Entscheider und Zeitpunkt erst bei terminaler
  Annahme oder Ablehnung
- bei Ablehnung ausschließlich einen neutralen, kanonischen Reason-Code

Storage-Key, Hash, Größe, MIME-Typ, Originalname und Position dürfen nach
Finalisierung nicht umgebunden werden. Scanner- und Entscheidungsübergänge sind
getrennt. Eine Staff-Annahme verlangt eine saubere Anlage, Titel und aktiven
Dokumenttyp. Schutzstufe, Bucket und Retention werden serverseitig daraus
abgeleitet. Das mandantengleiche Dokument muss die Hash-/Versionsidentität
wahren und wird erst nach erfolgreicher Finalisierung mandantenweit freigegeben.
Der letzte Attachment-Row-Lock umfasst Object-Recovery beziehungsweise PUT und
die CLEAN-/ACCEPTED-Finalisierung. Damit kann eine parallele Ablehnung nur
vollständig vor dem Object-Write gewinnen oder nachher den bereits terminalen
Annahmestatus sehen. Beim sicheren Abbruch werden finale Storage-Identität,
Entfernung der PENDING-Version und des leeren Dokuments sowie `REJECTED` in
einer Transaktion gebunden; Scope-, Hash-, CLEAN- oder Mehrversionsabweichungen
rollen vollständig zurück.

### Kanonisches Manifest

Die Manifestbindung verhindert ein Vertauschen oder Austauschen von Dateien
zwischen Scan und Submit. Anlagen werden nach ihrer 0-basierten `position`
sortiert. Pro Anlage wird folgende UTF-8-Zeile gebildet:

```text
position:sha256Hex:sizeBytes:base64Utf8(mimeType):base64Utf8(originalName)
```

Die Zeilen werden ohne abschließenden Zusatz mit `\n` verbunden. SHA-256 über
diese kanonische UTF-8-Darstellung ergibt die 32 Bytes in `manifestSha256`.
Der Originalname bleibt im DB-Manifest, wird aber nicht in Logs, Audit oder
Notifications wiederholt.

## Portalsicht auf Anlagen

Die Basistabelle ist kein Portal-Downloadverzeichnis. Download ist nur für eine
zum eigenen abgesendeten Thread gehörende, `CLEAN` gescannte Anlage erlaubt,
deren Entscheidung weder `REJECTED` noch `BLOCKED` ist.

`app.portal_inbox_attachment_receipts(tenant, thread)` stellt eine engere
Projektion bereit:

- Attachment- und Message-ID
- Originalname, MIME-Typ und Größe
- Entscheidung
- neutraler `rejection_reason`
- Entscheidungszeitpunkt
- abgeleitetes `download_allowed`

Die Projektion gibt keine Bucket-, Key-, Versions-, Hash- oder Scannerfelder
zurück. Sie enthält `REJECTED` mit `download_allowed = false`, blendet
`BLOCKED` vollständig aus und bindet Tenant, Thread und aktiven Kontakt erneut.
Das Portal-DTO übernimmt abgelehnte Quittungen aus dieser Projektion und
verwirft alle anderen zusätzlichen Werte fail-closed; eine Relation auf der
Basistabelle allein liefert `REJECTED` absichtlich nicht.

## Suche

Version 0.3 sucht in der Inbox ausschließlich Metadaten. Im Portal sind dies
Betreff und der bereits sichtbare Mandantenname; interne DATEV-/Addison-
Kennungen sind ausdrücklich ausgeschlossen. Die Staff-Suche darf diese
Kanzleikennungen innerhalb ihres unveränderten Mandantenzugriffs zusätzlich
verwenden. Topic, Status, Attention und Zuständigkeit dienen als Filter. Der
einzige Inbox-Trigramindex liegt auf dem Thread-Betreff.
Es gibt keinen Trigram-/GIN- oder sonstigen globalen Inhaltsindex auf
`PortalInboxMessage.body`, Anlagenbytes, OCR-Ausgaben oder Scannerdiagnosen.

Treffer-, Zähler- und Detailabfragen müssen dieselben RLS-, Feature-, Kontakt-,
Permission- und Mandantenzugriffsgates verwenden. Ein Deep-Link prüft die
Autorisierung erneut. Suchbegriffe gehören nicht in Audit, Notification oder
gewöhnliche Applikationslogs.

## Benachrichtigungen

Portalakteure dürfen keine generische Notification mit frei gesetztem Titel,
Body oder Link schreiben. Der write-only DB-Pfad
`app.notify_portal_inbox_activity(tenant, thread, staff)` leitet Scope und
Inhalt serverseitig ab:

- Kind `PORTAL_INBOX_ACTIVITY`
- Titel `Neue Mandantenpost`
- kein Body
- Link `/staff/inbox/{threadId}`
- Ressource `portal_inbox_thread`

Empfänger benötigen zum Erstell- und Lesezeitpunkt das Inbox-Recht sowie den
aktuellen Mandantenzugriff. Diese interne Notification ist keine
Eingangsbestätigung an den Mandanten.

Eine Kanzleiantwort erzeugt nach dem Nachrichten-Commit einen neutralen
E-Mail-Hinweis an alle aktiven, bestätigten und benachrichtigungsbereiten
Kontakte des Mandanten. Vor dem externen Versand wird unter einem
nachrichtenbezogenen Advisory-Lock ein dauerhafter Audit-Claim geschrieben.
Parallele Replays versenden dadurch nicht doppelt. Totalfehler ohne möglichen
Provider-Side-Effect sind sichtbar wiederholbar; Claim, Teilzustellung oder ein
unklarer Provider-Throw bleiben konservativ manuell zu klären.

## Audit-Gates

Fachliche Schreibpfade sollen Ereignisse für mindestens Batch-Erstellung und
-Verwerfen, Thread-/Nachrichtenerstellung, Annahme, Ablehnung,
Status-/Zuständigkeitsänderungen und erfolgreich geöffnete Downloadstreams
erzeugen. Das Downloadereignis heißt deshalb
`portal_inbox.attachment_download_stream_opened` und behauptet nicht, dass ein
Client den gesamten Response-Body empfangen hat. Die
Auditdaten dürfen nur pseudonyme IDs, kanonische Statusmerkmale und technische
Zähler enthalten. Ungeeignet sind insbesondere Nachrichtentext, Betreff,
Originaldateiname, Mandantenname, Suchbegriff, Scannerdiagnose oder ein freier
Ablehnungstext.

DB-Trigger schützen Invarianten, beweisen aber nicht, dass jeder fachliche
Call-Site sein Auditereignis geschrieben hat. Action-/Service-Tests müssen
deshalb Write und Audit gemeinsam prüfen; ein Auditfehler darf nicht als
erfolgreiche Fachaktion ausgegeben werden.

## Retention und Bereinigung

Der 24-Stunden-Ablauf ist ein Produktdefault für offene, noch nicht abgesendete
Uploadentwürfe. Er ist keine gesetzliche Aufbewahrungsfrist. Der Inbox-Worker
behandelt abgelaufene Draft-Zeilen und nicht mehr referenzierte Bytes
fehlertolerant und ohne Cross-Tenant-Wirkung. Sämtliche tenantgebundenen Reads
und Writes laufen dabei in einem `SYSTEM`-Tenant-Kontext. Er setzt den Status
und übergibt Object-Store-Bereinigungen idempotent an das gemeinsame Orphan-
Journal. Bereits journalisierte Identitäten werden unabhängig vom späteren
Orphan-Bereinigungsstatus vor dem Cleanup-Limit ausgeschlossen und können den
Arbeitsbatch nicht aushungern. Der Draft-Pfad journalisiert nach 24 Stunden auch
bereits `CLEAN` finalisierte `PENDING_REVIEW`-Anlagen, jedoch nur bei
`message_id IS NULL` und einem `EXPIRED`- oder `DISCARDED`-Batch. Damit bleiben
`CONSUMED`-Batches und abgesendete, ungeprüfte Eingänge vollständig außerhalb
der automatischen Bereinigung. Findet die eindeutige Storage-Recovery bei einem
mindestens 24 Stunden alten, terminalen PENDING-Draft keine Bytes, entfernt
dieselbe Tenant-Transaktion ausschließlich die nie abgesendete Intent-Zeile und
schreibt einen inhaltsfreien Auditnachweis. DB- und Object-Store-Ergebnis
behalten damit einen nachprüfbaren Kompensationspfad.

Abgelehnte oder blockierte Staging-Bytes verbleiben als technischer Default
sieben Tage in Quarantäne und werden danach idempotent über das Storage-Orphan-
Journal zur Löschung vorgemerkt. Dieser Wert ist keine gesetzliche Frist.
Fehlt einem Journal aus einem unterbrochenen Commit noch die konkrete
Objektversion, muss der gemeinsame Orphan-Worker zuerst genau eine Hash- und
Größen-identische Version recovern und deren ID am Journal binden. Erst danach
darf er versionsgenau löschen und `DELETED` protokollieren; fehlende oder
mehrdeutige Nachweise bleiben als Fehler offen.
Für abgesendete Nachrichten ist ein Kanzleiwert konfigurierbar; seine
organisatorische Dokumentation ist Aktivierungsvoraussetzung, eine automatische
Nachrichtenlöschung ist in 0.3.0 aber bewusst nicht aktiv. Eine angenommene
Anlage folgt nach ihrer Klassifikation ausschließlich den bestehenden
Dokument- und Object-Lock-Regeln.

Mandatsende oder Anonymisierung sperren neue Inbox-Nutzung sofort. Die
anschließende Behandlung bereits abgesendeter Inhalte darf nicht pauschal aus
dem Portalzugriffsgate abgeleitet werden; sie gehört in das geprüfte
Lösch-/Übergabeverfahren.

## Technische Nachweise und offene Gates

Nachgewiesen:

- Prisma-Validierung und Client-Generierung
- Migrationen mit getrennten Enum- und Nutzungsschritten
- ENABLE/FORCE RLS, Policies und Tenant-/Client-Paartrigger
- private Drafts, mandantenweite abgesendete Threads und aktiver Kontakt
- Staff-Permission plus Mandantenzugriff und sofortiger Rechteentzug
- Hash-/Manifest-/Idempotenz-/Status-/Dokumentannahme-Gates
- Safe-Projection für `REJECTED`, fail-closed Download und verborgenes `BLOCKED`
- write-only interne Notification ohne Portal-Freitexte
- HTTP-/Action-/DTO-Verträge für Portal und Staff
- Scanner-/Commit-Wiederaufnahme und Orphan-Kompensation
- atomarer Abbruch einer unvollständigen Annahmereservierung einschließlich
  Scope-/Hash-/Mehrversions- und Commit-vs-Reject-Nachweis
- tenantgebundener Ablaufworker für Drafts und Staging-Quarantäne ohne
  Orphan-Starvation sowie mit atomarem Nachweis fehlender PENDING-Intents
- neutrale E-Mail-Zustellung mit sichtbarem, kontrolliertem Retry
- Parallelitäts- und Retry-Fälle über Datenbank- und Servicegrenze
- skip-freier Portal-/Staff-Inbox-E2E mit 320-Pixel- und Axe-Prüfung

Vor Produktivfreigabe offen oder separat nachzuweisen:

- reale ClamAV-, SMTP- und Object-Store-Abnahme in der Zielumgebung
- reale Upload-/Scanner-E2E- und manuelle Accessibility-Abnahme
- fachlich beschlossene Retention, Reason-Code-Liste und Betriebsorganisation

`pnpm fachkatalog:check` und `pnpm fachkatalog:diff` validieren ausschließlich
Katalogstruktur und Nachweisdrift. Sie sind keine professionelle Freigabe.
