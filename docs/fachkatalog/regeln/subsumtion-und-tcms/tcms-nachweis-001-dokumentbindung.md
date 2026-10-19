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
    Mandanten. Solange ein Nachweis verweist, sind Löschen und neue
    Versionen des Dokuments gesperrt. Oberfläche und Auslieferung über die
    Dokumentauslieferung der kanzleikonsole folgen mit der Durchführungsseite.
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
  - apps/web/src/app/staff/(protected)/documents/actions.ts
  - apps/web/src/app/api/staff/documents/[id]/new-version/commit/route.ts
  - packages/db/prisma/schema.prisma
  - packages/db/prisma/migrations/20261019180000_tcms_document_reference/migration.sql
test_refs:
  - apps/web/src/server/tcms/__tests__/nachweis-verweis-db.test.ts
  - apps/web/src/app/staff/(protected)/documents/__tests__/bulk-actions.test.ts
  - apps/web/src/app/api/staff/documents/[id]/new-version/commit/__tests__/route-poa-lock.test.ts
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
Version hochladen.

## Wann gilt die Regel?

Für das Hochladen, Auswählen, Entfernen und Herunterladen von Nachweisen
einer Kontrolldurchführung im Modul „Tax-CMS“ durch Kanzleipersonen sowie für
das Löschen und Versionieren von Dokumenten, auf die ein solcher Nachweis
verweist. Nicht erfasst sind Anlagen im Mandantenportal (eigene
Portal-Dokumentenpipeline) und die fachliche Frage, welche Unterlagen eine
Kontrolle belegen.

## Benötigte Angaben

- Mandant der Durchführung (geprüft über den Akteur, TCMS-AKTEUR-001)
- Dokument dieses Mandanten mit neuester Version im Status `CLEAN` und
  Abschluss des Scans
- SHA-256, Größe und MIME-Typ der gespeicherten Version
- Verweis des Tax-CMS (Dokument-ID, SHA-256) beim Herunterladen
- offene Verknüpfungen (Tabelle `tcms_document_reference`)

## Entscheidungslogik

| Wenn                                                                                        | Dann                                                                                                                | Begründung                                                       |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| eine Datei als Nachweis hochgeladen wird                                                    | Ablage über die Dokumentenpipeline (Journal, Virenscan, SHA-256) am Mandanten, Verweis aus der Version              | Datei und Prüfsumme gehören der kanzleikonsole                   |
| ein vorhandenes Dokument ausgewählt wird                                                    | nur nicht gelöschte Dokumente dieses Mandanten mit sauberer neuester Version; keine GwG-, Personal-, Lohnunterlagen | keine fremden, ungeprüften oder besonders geschützten Unterlagen |
| das Tax-CMS den Nachweis annimmt                                                            | offene Verknüpfung mit Nachweis-ID                                                                                  | Grundlage der Lösch- und Versionssperre                          |
| das Tax-CMS den Nachweis eindeutig ablehnt                                                  | Verknüpfung freigeben („nicht angehängt“)                                                                           | kein Verweis, keine Sperre                                       |
| der Ausgang des Anhängens offen ist (Zeitlimit, Transport)                                  | Verknüpfung bleibt offen                                                                                            | im Zweifel schützen statt still löschen lassen                   |
| jemand ein Dokument mit offener Verknüpfung löschen will                                    | Löschen abweisen mit Hinweis auf den Nachweis (Ablage) bzw. Datenbankfehler (jeder andere Pfad)                     | ein Nachweis darf nicht still verschwinden                       |
| jemand eine neue Version eines solchen Dokuments hochladen will                             | abweisen (409)                                                                                                      | der Verweis bindet genau diese Fassung                           |
| der Nachweis im Tax-CMS entfernt wird                                                       | Verknüpfung freigeben („entfernt“)                                                                                  | Sperre endet mit dem Verweis                                     |
| der Nachweis heruntergeladen wird und SHA-256 oder Größe der Version weichen vom Verweis ab | nicht ausliefern, Hinweis                                                                                           | nie eine andere Fassung als die verwiesene ausliefern            |

## Ausnahmen und Grenzfälle

Bleibt der Ausgang des Anhängens offen, bleibt das Dokument gesperrt, bis
die Verknüpfung geklärt ist; eine automatische Klärung gibt es noch nicht.
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
Versions-Route. Die Tabelle
`tcms_document_reference` (Migration `20261019180000`) hält die Verknüpfung
mit RLS je Tenant; ein Trigger lässt nur die neueste saubere Version eines
Dokuments desselben Mandanten mit gleichem SHA-256 zu und macht Bezug und
Inhalt unveränderlich. Der Trigger
`document_tcms_reference_delete_guard` weist jedes Soft-Delete eines
Dokuments mit offener Verknüpfung ab; die Löschaktion der Ablage
(`documents/actions.ts`) prüft vorher selbst und nennt den Grund, die
Versions-Route (`new-version/commit`) sperrt neue Versionen.
Die Auslieferung über die Dokumentauslieferung der kanzleikonsole (Route
Handler, server/tcms/route.ts) folgt mit der Durchführungsseite.

## Bekannte Abweichungen und Grenzen

Die fachliche Freigabe steht aus. Offen gebliebene Verknüpfungen nach
unklarem Ausgang werden nicht automatisch geklärt. Entfernt eine andere
Oberfläche (z. B. das Mandantenportal) einen Nachweis, gibt sie die
Verknüpfung nur frei, wenn sie diese Regel ebenfalls umsetzt. Hart gelöschte
Dokumente verhindert der Fremdschlüssel; Pfade mit eigener Vernichtung
(GwG) sind von der Auswahl ausgeschlossen.

## Fachliche Prüffragen

- Reicht die Aufbewahrungsklasse „Allgemein“ für Nachweise eines
  Tax-Compliance-Systems, oder ist eine eigene Klasse mit Object Lock nötig?
- Soll eine neue Fassung eines Nachweises künftig als neuer Nachweis statt
  als neue Version des Dokuments entstehen (heute gesperrt)?
- Wer klärt offen gebliebene Verknüpfungen nach einem unklaren Ausgang?

## Technische Nachweise

`nachweis-verweis-db.test.ts` belegt gegen PostgreSQL (App-Rolle, RLS) die
Zulassung nur der neuesten sauberen Version desselben Mandanten, die
Unveränderlichkeit, die Lösch- und Versionssperre über die Ablage und den
Trigger sowie die Freigabe und das parallele Löschen und Verknüpfen.
`bulk-actions.test.ts` belegt die Löschsperre der Ablage mit Grund,
`route-poa-lock.test.ts` die Versionssperre der Route (auch zwischen Vor- und
Nachprüfung).
