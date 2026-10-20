---
id: TCMS-NACHWEIS-001
title: Nachweise des Tax-CMS nur aus gespeicherten Dokumenten des Mandanten, referenzierte Dokumente nicht still löschen
domain: subsumtion-und-tcms
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger TCMS und Qualitätssicherung
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    Nachweise einer Kontrolldurchführung verweisen auf Dokumente der
    kanzleikonsole. Der Verweis an das Tax-CMS entsteht nur aus der
    gespeicherten, gescannten neuesten Version eines Dokuments genau dieses
    Mandanten; ausgeliefert wird nur über die Dokumentauslieferung der
    kanzleikonsole bei gleichem SHA-256 und gleicher Größe. Solange ein
    Nachweis verweist, sind Löschen und neue Versionen des Dokuments
    gesperrt; das gilt auch für Anlagen, die Kontakte im Mandantenportal zu
    einer Kontrollaufgabe hochladen, und für Anlagen einer Ereignismeldung
    im Portal (gebunden in der Transaktion der Ablage, frei erst nach
    eindeutiger Ablehnung der Meldung oder nach dem Verwerfen des
    Ereignisses). Ein gebundenes Dokument lässt sich nicht in eine GwG-,
    Personal- oder private Unterlage umklassifizieren und wird nicht von der
    GwG-Pflichtvernichtung erfasst (Ablage, Aktion und Datenbank für jede
    Rolle). Offen gebliebene Verknüpfungen nach
    unklarem Ausgang klärt die kanzleikonsole beim Öffnen der Durchführung
    über „Nachweise je Dokument“ des Tax-CMS: bestätigen, wenn der Dienst den
    Nachweis führt, freigeben, wenn nicht – nur nach eindeutiger Antwort.
sources:
  - kind: product_documentation
    citation: Leitfaden Tax-CMS-Oberflächen, Abschnitt 11 (Route Handler für Datei-Abrufe)
    path: docs/development/tcms-oberflaechen.md
    checked_at: '2026-10-19'
    primary: true
  - kind: product_documentation
    citation: Anwenderdokumentation Tax-CMS, Durchführungen und Nachweise
    path: docs/anwenderdoku/tax-cms.md
    checked_at: '2026-10-19'
    primary: false
  - kind: product_documentation
    citation: Technische Modulbeschreibung Dokumentenarchiv
    path: docs/development/module/dokumentenarchiv.md
    checked_at: '2026-10-19'
    primary: false
code_refs:
  - apps/web/src/server/tcms/durchfuehrung/verweis.ts
  - apps/web/src/server/tcms/durchfuehrung/sperre.ts
  - apps/web/src/server/tcms/durchfuehrung/nachweis-aktion.ts
  - apps/web/src/server/tcms/durchfuehrung/nachweis-download.ts
  - apps/web/src/server/tcms/durchfuehrung/abgleich.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/durchfuehrungen/[did]/page.tsx
  - apps/web/src/app/api/staff/clients/[id]/tcms/nachweise/[nachweisId]/route.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/durchfuehrungen/[did]/actions.ts
  - apps/web/src/app/staff/(protected)/documents/actions.ts
  - apps/web/src/app/api/staff/documents/[id]/new-version/commit/route.ts
  - apps/web/src/server/tcms/portal/anlagen.ts
  - apps/web/src/server/tcms/portal/meldung.ts
  - apps/web/src/app/portal/(protected)/tcms/aufgaben/[id]/actions.ts
  - apps/web/src/app/portal/(protected)/tcms/ereignis/actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/ereignisse/actions.ts
  - packages/db/prisma/schema.prisma
  - packages/db/prisma/migrations/20261019180000_tcms_document_reference/migration.sql
  - packages/db/prisma/migrations/20261019190000_tcms_document_reference_event/migration.sql
  - apps/web/src/server/documents/retag.ts
  - apps/web/src/app/staff/(protected)/admin/gwg-retention/actions.ts
  - packages/db/prisma/migrations/20261020100000_tcms_document_reference_gwg_destruction/migration.sql
  - packages/db/prisma/migrations/20261020100100_tcms_document_version_lock/migration.sql
  - packages/db/prisma/migrations/20261020200000_tcms_document_reference_release_reason/migration.sql
  - packages/db/src/database-error.ts
  - apps/web/src/components/tcms/durchfuehrung/nachweis-liste.tsx
  - apps/web/src/components/tcms/portal/anlagen.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/durchfuehrungen/[did]/ansicht.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/ereignisse/triage.tsx
  - apps/web/src/app/portal/(protected)/tcms/aufgaben/[id]/page.tsx
test_refs:
  - apps/web/src/server/tcms/__tests__/nachweis-verweis-db.test.ts
  - apps/web/src/server/tcms/__tests__/bereich-c-live.test.tsx
  - apps/web/src/server/tcms/durchfuehrung/__tests__/nachweis-aktion.test.ts
  - apps/web/src/server/tcms/durchfuehrung/__tests__/nachweis-download.test.ts
  - apps/web/src/server/tcms/durchfuehrung/__tests__/abgleich.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/durchfuehrungen/__tests__/seiten.test.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/durchfuehrungen/__tests__/actions.test.ts
  - apps/web/src/app/staff/(protected)/documents/__tests__/bulk-actions.test.ts
  - apps/web/src/app/api/staff/documents/[id]/new-version/commit/__tests__/route-poa-lock.test.ts
  - apps/web/src/server/tcms/__tests__/portal-anlagen.test.ts
  - apps/web/src/server/tcms/__tests__/portal-meldung.test.ts
  - apps/web/src/app/portal/(protected)/tcms/__tests__/portal-aktionen.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/__tests__/ereignisse-aktionen.test.ts
  - apps/web/src/server/tcms/__tests__/bereich-d-db.test.ts
  - apps/web/src/server/tcms/__tests__/nachweis-bindung-db.test.ts
  - apps/web/src/server/tcms/__tests__/redteam-dokumente-db.test.ts
  - apps/web/src/app/staff/(protected)/admin/gwg-retention/__tests__/actions-db.test.ts
  - apps/web/src/app/staff/(protected)/admin/gwg-retention/__tests__/actions.test.ts
  - packages/db/src/__tests__/tcms-document-reference-guards.test.ts
  - packages/db/src/__tests__/tcms-db-regeln.test.ts
  - apps/web/src/app/staff/(protected)/documents/__tests__/retag-race.test.ts
  - apps/web/src/components/tcms/durchfuehrung/__tests__/nachweis-liste.test.tsx
  - apps/web/src/app/portal/(protected)/tcms/__tests__/portal-seiten.test.tsx
  - apps/web/src/server/tcms/__tests__/redteam-boeser-dienst-db.test.tsx
feature_refs:
  - FEATURES.md
  - docs/anwenderdoku/tax-cms.md
related_rules:
  - TCMS-AKTEUR-001
  - TCMS-DIENST-001
  - DOC-UPLOAD-JOURNAL-001
  - DOC-VERSION-IMMUTABILITY-001
  - DOC-RETENTION-CLASS-001
  - ACCESS-CLIENT-MODE-001
  - GWG-RETENTION-DESTRUCTION-001
tags:
  - tcms
  - nachweis
  - dokumente
  - loeschsperre
---

# TCMS-NACHWEIS-001 — Nachweise des Tax-CMS nur aus gespeicherten Dokumenten des Mandanten, referenzierte Dokumente nicht still löschen

## Kurzfassung

Das Tax-CMS speichert zu einem Nachweis einer Kontrolldurchführung nur einen
Verweis (Dokument-ID, Dateiname, MIME-Typ, Größe, SHA-256); die Datei liegt
in der Dokumentablage der kanzleikonsole. Die kanzleikonsole bildet diesen
Verweis ausschließlich aus der gespeicherten, sauber gescannten neuesten
Version eines Dokuments genau dieses Mandanten, nie aus Formularangaben. Sie
liefert die Datei nur mit ihren eigenen Rechten aus und nur, wenn der SHA-256
der auszuliefernden Version dem Verweis entspricht. Solange ein Nachweis auf
ein Dokument verweist, lässt sich das Dokument nicht löschen und keine neue
Version hochladen. Dasselbe gilt seit TCMS s7 für Anlagen einer
Ereignismeldung aus dem Portal: Auch sie sind im Tax-CMS nur Verweise
(Dokument-ID, SHA-256) und binden das Dokument, bis die Meldung eindeutig
abgelehnt oder das Ereignis verworfen ist.

## Wann gilt die Regel?

Für das Hochladen, Auswählen, Entfernen und Herunterladen von Nachweisen
einer Kontrolldurchführung im Modul „Tax-CMS“ durch Kanzleipersonen, für
Anlagen, die Kontakte im Mandantenportal zu einer Kontrollaufgabe (Nachweise
derselben Durchführung) hochladen oder entfernen, für Anlagen, die Kontakte
im Mandantenportal einer Ereignismeldung beifügen, für das Verwerfen eines
gemeldeten Ereignisses sowie für das Löschen, Versionieren, Umklassifizieren
und die GwG-Pflichtvernichtung von Dokumenten, auf die ein solcher Nachweis
oder eine solche Anlage verweist.
Nicht erfasst ist die fachliche Frage, welche Unterlagen eine Kontrolle
oder ein Ereignis belegen.

## Benötigte Angaben

- Mandant der Durchführung (geprüft über den Akteur, TCMS-AKTEUR-001)
- Dokument dieses Mandanten mit neuester Version im Status `CLEAN` und
  Abschluss des Scans
- SHA-256, Größe und MIME-Typ der gespeicherten Version
- Verweis des Tax-CMS (Dokument-ID, SHA-256) beim Herunterladen
- offene Verknüpfungen (Tabelle `tcms_document_reference`, Bezug
  Durchführung oder Ereignis)
- Antwort des Tax-CMS auf die Meldung (Ereignis-ID) bzw. auf das Bestätigen
  des Verwerfens (Ereignis-ID, Status)

## Entscheidungslogik

| Wenn                                                                                                                      | Dann                                                                                                                                                                                                                                                | Begründung                                                                               |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| eine Datei als Nachweis hochgeladen wird                                                                                  | Ablage über die Dokumentenpipeline (Journal, Virenscan, SHA-256) am Mandanten, Verweis aus der Version                                                                                                                                              | Datei und Prüfsumme gehören der kanzleikonsole                                           |
| ein Kontakt im Portal eine Anlage zu einer Kontrollaufgabe hochlädt                                                       | Ablage über die Portal-Dokumentenpipeline am Sitzungsmandanten, Verknüpfung in derselben Commit-Transaktion (Urheber: Kontakt), Verweis aus der Version                                                                                             | dieselbe Bindung wie bei Nachweisen der Kanzlei                                          |
| ein vorhandenes Dokument ausgewählt wird                                                                                  | nur nicht gelöschte Dokumente dieses Mandanten mit sauberer neuester Version; keine GwG-, Personal-, Lohnunterlagen                                                                                                                                 | keine fremden, ungeprüften oder besonders geschützten Unterlagen                         |
| das Tax-CMS den Nachweis annimmt                                                                                          | offene Verknüpfung mit Nachweis-ID                                                                                                                                                                                                                  | Grundlage der Lösch- und Versionssperre                                                  |
| das Tax-CMS den Nachweis eindeutig ablehnt                                                                                | Verknüpfung freigeben („nicht angehängt“)                                                                                                                                                                                                           | kein Verweis, keine Sperre                                                               |
| der Ausgang des Anhängens offen ist (Zeitlimit, Transport)                                                                | Verknüpfung bleibt offen                                                                                                                                                                                                                            | im Zweifel schützen statt still löschen lassen                                           |
| eine Kanzleiperson die Durchführung öffnet und eine Verknüpfung seit mindestens 5 Minuten offen ohne Nachweis-ID ist      | Abgleich über „Nachweise je Dokument“: aktiver, noch nicht gebundener Nachweis dieser Durchführung → bestätigen; nur entfernt → freigeben („entfernt“); keiner → freigeben („nicht angehängt“); Lesefehler → unverändert                            | der Dienst führt den Nachweis oder nicht; die Sperre folgt ihm, ohne Annahme             |
| ein Kontakt im Portal einer Ereignismeldung Anlagen beifügt                                                               | Ablage über die Portal-Dokumentenpipeline am Sitzungsmandanten, Verknüpfung mit Bezug „Ereignis“ in derselben Commit-Transaktion (Urheber: Kontakt); scheitert eine weitere Datei, Freigabe der schon gebundenen („nicht angehängt“), keine Meldung | die Meldung verweist nur auf Dokument-ID und SHA-256                                     |
| das Tax-CMS die Meldung annimmt                                                                                           | Ereignis-ID an allen Anlagen der Meldung (höchstens einmal)                                                                                                                                                                                         | Grundlage der Freigabe beim Verwerfen                                                    |
| das Tax-CMS die Meldung eindeutig ablehnt (4xx, offener Breaker)                                                          | Anlagen freigeben („nicht angehängt“); bei offenem Ausgang bleiben sie gebunden                                                                                                                                                                     | kein Verweis, keine Sperre; im Zweifel schützen                                          |
| das Verwerfen eines Ereignisses bestätigt wird und der Dienst dasselbe Ereignis als verworfen meldet                      | Anlagen dieses Ereignisses des gebundenen Mandanten freigeben („verworfen“); andere Antwort → Sperre bleibt                                                                                                                                         | die Meldung verweist nicht mehr auf die Dokumente                                        |
| jemand ein Dokument mit offener Verknüpfung löschen will                                                                  | Löschen abweisen mit Hinweis auf den Nachweis (Ablage) bzw. Datenbankfehler (jeder andere Pfad)                                                                                                                                                     | ein Nachweis darf nicht still verschwinden                                               |
| jemand eine neue Version eines solchen Dokuments hochladen will                                                           | abweisen (409); auf jedem anderen Pfad Datenbankfehler (Trigger, jede Rolle)                                                                                                                                                                        | der Verweis bindet genau diese Fassung                                                   |
| jemand ein solches Dokument in eine GwG-, Personal- oder private Unterlage umklassifizieren oder ihm Lohnbezug geben will | abweisen mit Hinweis (Ablage) bzw. Datenbankfehler (jeder andere Pfad); andere Umklassifizierung (z. B. Höherstufung nach GoBD) ohne neue Version zulässig                                                                                          | das Dokument bleibt im Rahmen, in dem es Nachweis sein darf                              |
| die GwG-Pflichtvernichtung ein solches Dokument erfasst (Altbestand vor RT3B-K-01)                                        | abweisen vor der Vormerkung, im DB-Claim und vor jedem Object-Store-Löschen; keine Bytes löschen                                                                                                                                                    | ein Nachweis darf nicht still verschwinden; Kollision mit § 8 Abs. 4 GwG fachlich klären |
| der Nachweis im Tax-CMS entfernt wird                                                                                     | Verknüpfung freigeben („entfernt“)                                                                                                                                                                                                                  | Sperre endet mit dem Verweis                                                             |
| der Nachweis heruntergeladen wird und SHA-256 oder Größe der Version weichen vom Verweis ab                               | nicht ausliefern, Hinweis                                                                                                                                                                                                                           | nie eine andere Fassung als die verwiesene ausliefern                                    |

## Ausnahmen und Grenzfälle

Bleibt der Ausgang des Anhängens offen, bleibt das Dokument gesperrt, bis
die Verknüpfung geklärt ist. Geklärt wird beim Öffnen der Durchführung durch
eine Kanzleiperson (höchstens zehn Verknüpfungen je Aufruf, erst nach fünf
Minuten, damit ein noch laufendes Anhängen nicht freigegeben wird); eine
Durchführung, die niemand öffnet, behält die Sperre. Einen Hintergrundjob
gibt es nicht: Der Lesepfad ist Kanzleipersonen vorbehalten, und der
Zustell-Worker bestätigt nur den Systemakteur (TCMS-AKTEUR-001).
Für Anlagen einer Ereignismeldung gibt es keinen solchen Abgleich: Das
Tax-CMS bietet keinen Lesepfad „Ereignisse je Dokument“; eine Anlage, deren
Meldung offen geblieben ist (Zeitlimit, Transport), bleibt ohne Ereignis-ID
gebunden, bis eine Kanzleiperson sie in der Datenbank klärt (Vorschlag an
das Tax-CMS). Freigegeben wird nur nach dem bestätigten Verwerfen, nicht nach
dem Abschließen eines Ereignisses – die Meldung verweist weiter.
Verweise aus der Zeit vor dieser Regel (z. B. Demo-Daten mit
Ablagepfad statt Dokument-ID) liefert die kanzleikonsole nicht aus. Die
technische Aufbewahrungsklasse hochgeladener Nachweise ist „Allgemein“ (ohne
Object Lock); eine fachlich gebotene Höherstufung bleibt eine Entscheidung
nach DOC-RETENTION-CLASS-001 in der Dokumentablage.

## Beispiele

### Normalfall

Eine Mitarbeiterin lädt zur Kontrolle „Kreditorencheck § 13b“ eine
CSV-Liste hoch. Die kanzleikonsole scannt, speichert und hasht die Datei am
Mandanten und übergibt dem Tax-CMS nur Dokument-ID, Name, Typ, Größe und
SHA-256 der gespeicherten Version. Später versucht jemand, das Dokument in der
Ablage zu löschen; die Ablage weist mit Hinweis auf den Nachweis ab.

### Grenzfall

Ein Dokument wird nach dem Anhängen durch einen Fehler außerhalb der Ablage
verändert. Beim Herunterladen stimmt der SHA-256 der Version nicht mehr mit
dem Verweis überein; die Datei wird nicht ausgeliefert, die Seite zeigt eine
Abweichung.

## Umsetzung in TaxTronik

`server/tcms/durchfuehrung/verweis.ts` bildet Verweise aus der Datenbank,
legt die Verknüpfung unter geteilter Zeilensperre des Dokuments in einer
Tenant-Transaktion vor dem Dienstaufruf an (beim Hochladen in der
Commit-Transaktion des Dokuments) und gibt sie nach eindeutiger Ablehnung oder
Entfernung frei; `sperre.ts` enthält die Sperrprüfung für Ablage und
Versions-Route. `abgleich.ts` klärt offene Verknüpfungen ohne Nachweis-ID
(`offeneNachweiseAbgleichen`, aufgerufen von der Seite der Durchführung am
aktuellen Stand): je Dokument ein Aufruf von `nachweiseJeDokumentLesen` mit
dem Akteur der Seite, Entscheidung rein aus der geprüften Antwort
(`abgleichEntscheidung`), Bestätigen bzw. Freigeben in eigenen kurzen
Transaktionen; jeder Lesefehler lässt die Verknüpfung offen. Die Tabelle
`tcms_document_reference` (Migration `20261019180000`) hält die Verknüpfung
mit RLS je Tenant; ein Trigger lässt nur die neueste saubere Version eines
Dokuments desselben Mandanten mit gleichem SHA-256 zu und macht Bezug und
Inhalt unveränderlich. Der Trigger
`document_tcms_reference_delete_guard` weist jedes Soft-Delete eines
Dokuments mit offener Verknüpfung ab; die Löschaktion der Ablage
(`documents/actions.ts`) prüft vorher selbst und nennt den Grund, die
Versions-Route (`new-version/commit`) sperrt neue Versionen; seit der
Härtung D3 (Migration `20261020100100`) weist der Trigger
`document_version_tcms_reference_guard` jede neue Version eines Dokuments mit
offener Verknüpfung für jede Rolle ab. Er sperrt zuerst die Dokumentzeile
(FOR NO KEY UPDATE), so dass sich eine neue Version und das Anlegen einer
Verknüpfung serialisieren; die Route bildet die Ablehnung der Datenbank wie
ihre eigene Prüfung ab (409 `locked_by_tcms_evidence`).
`nachweis-aktion.ts` legt hochgeladene Dateien über die Dokumentenpipeline
(`runJournaledUpload`, Klassifikation „Allgemein“) am Mandanten ab, schreibt
in derselben Commit-Transaktion Audit und Verknüpfung, hängt danach an und
gibt die Verknüpfung nur bei eindeutiger Ablehnung frei (4xx, offener
Breaker); Zeitlimit, Transport, 5xx und Protokollfehler lassen sie offen.
`nachweis-download.ts` liefert nach `tcmsMandantRoute` nur über
`loadDocumentDelivery` und `documentDownloadResponse` aus und vergleicht
SHA-256 und Größe vor dem Abrufnachweis und erneut an der geladenen Fassung;
beim Streamen prüft die Ablage den Objektinhalt (R-05).
Im Mandantenportal legt `portal/anlagen.ts` (`portalNachweisAblegen`) Anlagen
einer Kontrollaufgabe über die Portal-Dokumentenpipeline am Sitzungsmandanten
ab und verknüpft sie in derselben Commit-Transaktion mit der Durchführung
(`created_by` = Kontakt der Sitzung); die Aktionen der Kontrollaufgabe
(`portal/(protected)/tcms/aufgaben/[id]/actions.ts`) hängen über
`nachweisAnhaengenUndBinden` mit dem Portal-Endpunkt an und geben die
Verknüpfung nach dem Entfernen über `nachweisEntfernenUndFreigeben` frei.
Anlagen einer Ereignismeldung legt `portalAnlageAblegen` ebenso ab und bindet
sie über `meldungsAnlageVerknuepfenTx` (Bezug „Ereignis“, ohne Ereignis-ID) in
der Commit-Transaktion; `portal/meldung.ts` gibt die schon gebundenen
Anlagen frei, wenn eine weitere Datei scheitert, meldet danach, setzt nach
Annahme die Ereignis-ID (`meldungsAnlagenZuordnen`) und gibt nach
eindeutiger Ablehnung frei. Die Bestätigung des Verwerfens
(`ereignisse/actions.ts`) gibt die Anlagen des Ereignisses frei, wenn die
Antwort dasselbe Ereignis mit Status „verworfen“ nennt
(`meldungsAnlagenNachVerwerfen`). Die Migration `20261019190000` ergänzt
`tcms_subject` (EXECUTION/EVENT) und `tcms_event_id`; ein CHECK verlangt
genau einen Bezug (Durchführung mit Durchführungs-ID und ohne Ereignis-ID,
Ereignis ohne Durchführung und ohne Nachweis-ID) und lässt „verworfen“ nur
für Ereignisse, „entfernt“ nur für Durchführungen zu; der Trigger hält den
Bezug unveränderlich und setzt die Ereignis-ID höchstens einmal. Löschsperre,
RLS und Rechte gelten für beide Bezüge unverändert.
Seit dem Angriffsdurchlauf 3b (RT3B-K-01) hält die Bindung das Dokument auch
in seinem Rahmen: Die Umklassifizierung der Ablage (`documents/retag.ts`)
prüft nach der Zeilensperre die Verknüpfung und weist den Wechsel nach
GWG_EVIDENCE, PERSONNEL oder STAFF_PRIVATE sowie einen Re-Store mit neuer
Version mit festem Grund ab, bevor der Speicher berührt wird; der Trigger
`document_tcms_reference_scope_guard` (Migration `20261020100000`) weist
denselben Wechsel, einen Lohnbezug sowie einen Onboarding- oder
Formularbezug für jede Rolle ab. Die GwG-Pflichtvernichtung
(`admin/gwg-retention/actions.ts`) prüft die Verknüpfung vor der Vormerkung
und vor jedem Object-Store-Löschen; der Claim
`app.assert_gwg_document_destruction_due` weist ein gebundenes Dokument unter
der Dokumentsperre ab, vor Klassifikation und Frist, und damit auch
`app.destroy_gwg_document_versions`. Alle diese Sperren meldet die Datenbank
mit SQLSTATE 23001 und dem Marker „als Nachweis im Tax-CMS verknüpft“
(`database-error.ts`: `TCMS_EVIDENCE_LOCKED`).
Den Dateinamen eines Nachweises bzw. einer Portal-Anlage zeigt die
kanzleikonsole aus der eigenen Ablage (Titel und Typ des gebundenen
Dokuments, `nachweisAblageStandTx`; im Portal nur freigegebene Dokumente des
Sitzungsmandanten), nicht aus der Antwort des Tax-CMS; ohne Dokument nur den
nach der Zeichenregel bereinigten Wert des Dienstes (RT3B-K-04).

## Bekannte Abweichungen und Grenzen

Die fachliche Freigabe steht aus. Offen gebliebene Verknüpfungen nach
unklarem Ausgang werden nur beim Öffnen der Durchführung geklärt, nicht im
Hintergrund. Anlagen einer
Ereignismeldung mit offenem Ausgang der Meldung bleiben ohne Abgleich
gebunden (siehe Ausnahmen). Hart gelöschte
Dokumente verhindert der Fremdschlüssel; Pfade mit eigener Vernichtung
(GwG) sind von der Auswahl ausgeschlossen, und ein gebundenes Dokument kann
nicht in sie wechseln. Ein vor RT3B-K-01 zum GwG-Beleg umklassifiziertes,
noch gebundenes Dokument (Altbestand) bleibt gebunden; die
GwG-Pflichtvernichtung weist es ab, bis die Verknüpfung frei ist.

## Fachliche Prüffragen

- Reicht die Aufbewahrungsklasse „Allgemein“ für Nachweise eines
  Tax-Compliance-Systems, oder ist eine eigene Klasse mit Object Lock nötig?
- Soll eine neue Fassung eines Nachweises künftig als neuer Nachweis statt
  als neue Version des Dokuments entstehen (heute gesperrt)?
- Genügt die Klärung beim Öffnen der Durchführung, oder braucht es einen
  Hintergrundabgleich (dafür wäre ein Lesepfad des Systemakteurs im Tax-CMS
  nötig)?
- Sollen Anlagen eines abgeschlossenen (nicht verworfenen) Ereignisses
  dauerhaft gesperrt bleiben, oder endet die Bindung mit einer Frist?
- Wie ist ein GwG-Beleg zu behandeln, der (als Altbestand) zugleich als
  Nachweis gebunden ist und dessen Vernichtungspflicht nach § 8 Abs. 4 GwG
  greift? Heute gewinnt die Bindung, bis der Nachweis entfernt ist.

## Technische Nachweise

`nachweis-verweis-db.test.ts` belegt gegen PostgreSQL (App-Rolle, RLS) die
Zulassung nur der neuesten sauberen Version desselben Mandanten, die
Unveränderlichkeit, die Lösch- und Versionssperre über die Ablage und den
Trigger sowie die Freigabe und das parallele Löschen und Verknüpfen.
`abgleich.test.ts` belegt den Abgleich offener Verknüpfungen (Entscheidung,
Mindestalter, Begrenzung, je Dokument ein Aufruf, unverändert bei
Lesefehlern), `nachweis-verweis-db.test.ts` dessen Abfrage unter RLS,
`seiten.test.tsx` der Durchführungen den Aufruf nur am aktuellen Stand.
`nachweis-aktion.test.ts` und `nachweis-download.test.ts` belegen Upload-Weg,
Freigabe nur nach eindeutiger Ablehnung und den Abgleich vor jeder
Auslieferung; `bereich-c-live.test.tsx` (Opt-in gegen einen laufenden Dienst)
führt Auswahl, Sperre, Abruf bis zum Speicher und Freigabe beim Entfernen über
die echten Aktionen aus. Die Aktionen der Durchführung übernehmen IDs aus
Antworten des Dienstes nur nach Formatprüfung (`safeParse`).
`bulk-actions.test.ts` belegt die Löschsperre der Ablage mit Grund,
`route-poa-lock.test.ts` die Versionssperre der Route (auch zwischen Vor- und
Nachprüfung). `nachweis-aktion.test.ts` belegt Freigabe nur bei eindeutiger
Ablehnung, Ablage über die Pipeline und Verknüpfung in der Commit-Transaktion,
`nachweis-download.test.ts` die Auslieferung nur bei gleichem SHA-256 und
gleicher Größe, nur für Dokumente dieses Mandanten und ohne Abrufnachweis bei
Abweichung, `actions.test.ts` der Durchführung die Auswahl nur über die
gespeicherte Version. Für das Portal belegen `portal-anlagen.test.ts`
(Verknüpfung in der Commit-Transaktion, Kontakt als Urheber, kein Commit ohne
Verknüpfung), `portal-aktionen.test.ts` (Nachweis-ID nach Annahme, Freigabe
nach eindeutiger Ablehnung bzw. nach dem Entfernen, offener Ausgang hält die
Sperre) und `bereich-d-db.test.ts` (Verknüpfung im Kontext des Kontakts unter
RLS, Löschsperre bis zur Freigabe, nur Dokumente des Sitzungsmandanten).
Für Anlagen einer Ereignismeldung belegen `portal-anlagen.test.ts` die
Bindung in der Commit-Transaktion, `portal-meldung.test.ts` Freigabe der
schon gebundenen bei einer gescheiterten Datei, Ereignis-ID nach Annahme,
Freigabe nur nach eindeutiger Ablehnung und nach eindeutigem Verwerfen,
`portal-aktionen.test.ts` und `ereignisse-aktionen.test.ts` die Aufrufe
aus den Aktionen (gebundener Mandant), `nachweis-verweis-db.test.ts` den
CHECK „genau ein Bezug“, die einmalige Ereignis-ID, die Löschsperre für App-
und Owner-Rolle und die Freigabe nur dieses Ereignisses dieses Mandanten,
`bereich-d-db.test.ts` die Bindung im Kontext des Kontakts unter RLS. Die
Datenbanktests prüfen Meldungen der Datenbank ohne den Codeausschnitt, den
Prisma an Fehler hängt (er enthält sonst das erwartete Muster).
Für RT3B-K-01 belegen `nachweis-bindung-db.test.ts` (App- und Owner-Rolle,
Umklassifizierung der Ablage mit Grund ohne Speicherzugriff, Claim und
DB-Vernichtung, nebenläufiges Verknüpfen und Umklassifizieren),
`redteam-dokumente-db.test.ts` (Angriffe K-01a bis K-01c),
`retag-race.test.ts` (kein Re-Store mit neuer Version, keine Bytes gelesen),
für RT3B-K-04 `nachweis-liste.test.tsx`, `seiten.test.tsx` der
Durchführungen, `portal-seiten.test.tsx` und `redteam-boeser-dienst-db.test.tsx`
(Name aus der Ablage, sonst bereinigt, nie der Dienstwert) sowie
`nachweis-bindung-db.test.ts` (Namen nur aus Dokumenten des Mandanten, im
Portal nur freigegebene),
für die Härtung D3 `nachweis-bindung-db.test.ts` (neue Version für App- und
Owner-Rolle gesperrt, nach der Freigabe möglich, nebenläufig mit dem
Verknüpfen in beiden Reihenfolgen) und `route-poa-lock.test.ts` (Abbildung
der Datenbankablehnung als 409),
`actions-db.test.ts` und `actions.test.ts` der GwG-Vernichtung (Abweisung
ohne Vormerkung, Audit und Bytes; Prüfung vor jedem Object-Store-Löschen)
sowie `tcms-document-reference-guards.test.ts` (Altbestand, Superuser,
Einordnung über SQLSTATE und Marker).
`packages/db/src/__tests__/tcms-db-regeln.test.ts` belegt jede Schutzregel
der Tabelle einzeln (Trigger-Zweige, CHECK-Bedingungen ohne Trigger, RLS
USING und WITH CHECK, Rechte); jede ist durch eine Mutation in der
Datenbank belegt. Seit Migration `20261020200000` weist
`tcms_document_reference_release_check` auch eine Freigabe ohne Grund ab
(`release_reason IS NOT NULL` vor dem Vergleich: NULL erfüllt die Bedingung
nie, dreiwertige Logik); der Test prüft das für App-Rolle und Superuser,
und ein Inventar verlangt, dass jede CHECK-Bedingung der TCMS-Tabellen auf
dieselbe Falle geprüft ist.
