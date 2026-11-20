---
id: DOC-RETENTION-CLASS-001
title: Dokumenttyp in technische Schutz- und Aufbewahrungsklasse überführen
domain: dokumente-und-aufbewahrung
rule_type: professional_interpretation
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Steuer- und Berufsrecht
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    Datei-Typ und Schutzstufe steuern NONE, GWG oder GOBD sowie bei GOBD
    sechs, acht oder zehn Jahre; unbekannte GOBD-Klassen fallen auf zehn Jahre
    zurück. Inhaltliche Einordnung, richtiger Fristanker, Übergangsrecht und
    verlängerte steuerliche Bedeutung werden nicht automatisch entschieden.
sources:
  - kind: official_law
    citation: § 147 Abs. 1 bis 4 AO
    url: https://www.gesetze-im-internet.de/ao_1977/__147.html
    checked_at: '2026-11-20'
    primary: true
  - kind: official_law
    citation: § 14b UStG
    url: https://www.gesetze-im-internet.de/ustg_1980/__14b.html
    checked_at: '2026-11-20'
    primary: false
  - kind: official_law
    citation: Art. 97 § 19a EGAO, Übergang zur Achtjahresfrist
    url: https://www.gesetze-im-internet.de/aoeg_1977/art_97__19a.html
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: § 257 Abs. 4 und 5 HGB, einschließlich Sonderregel für beaufsichtigte Institute
    url: https://www.gesetze-im-internet.de/hgb/__257.html
    checked_at: '2026-11-20'
    primary: true
  - kind: product_documentation
    citation: Benutzerhandbuch Dokumente und Archiv
    path: docs/anwenderdoku/dokumente.md
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - packages/config/src/retention-calendar.ts
  - packages/storage/src/service.ts
  - apps/web/src/server/storage/document-type.ts
  - apps/web/src/server/inbox/accept-attachment.ts
  - apps/web/src/server/documents/retag.ts
  - packages/db/prisma/migrations/20260801003520_document_type_retention_years/migration.sql
test_refs:
  - packages/db/src/__tests__/tcms-gwg-aufbewahrung.test.ts
  - packages/storage/src/__tests__/retention.test.ts
  - apps/web/src/app/api/staff/documents/commit/__tests__/route-toctou.test.ts
  - apps/web/src/server/inbox/__tests__/accept-attachment.test.ts
  - apps/web/src/server/documents/__tests__/retag-db.test.ts
feature_refs:
  - docs/anwenderdoku/dokumente.md
  - docs/compliance/gobd.md
related_rules:
  - DOC-OBJECT-LOCK-001
  - DOC-VERSION-IMMUTABILITY-001
  - DSGVO-OPERATIONAL-RETENTION-001
  - PORTAL-INBOX-SUBMISSION-001
tags:
  - aufbewahrung
  - dokumenttyp
  - klassifikation
---

# DOC-RETENTION-CLASS-001 — Dokumenttyp in technische Schutz- und Aufbewahrungsklasse überführen

## Kurzfassung

TaxTronik bildet einen gewählten Datei-Typ auf die technische Schutzstufe
`NONE`, `GWG` oder `GOBD` ab. Für GoBD-Typen sind ausschließlich sechs, acht
oder zehn Jahre vorgesehen; die Kernzuordnung lautet Vertrag sechs,
Rechnung/Buchungsbeleg acht und Steuerunterlage zehn Jahre. Diese Zuordnung ist
eine Produktklassifikation und ersetzt keine Inhalts- und Fristbeginnprüfung.

## Wann gilt die Regel?

Die Regel gilt beim Upload, bei einer neuen Version und bei zulässiger
Höherstufung eines Dokuments. Sie beschreibt die technische Retention aus dem
gewählten Typ. Sie entscheidet nicht, ob eine konkrete Datei unter § 147 AO,
§ 14b UStG, § 66 StBerG, GwG oder eine andere Vorschrift fällt.

## Benötigte Angaben

- tatsächlicher Inhalt und Funktion der Unterlage
- aktiver Datei-Typ und dessen Schutzstufe
- bei GoBD-Typen das festgelegte Intervall sechs, acht oder zehn Jahre
- fachlich maßgebliches Ereignis für den Fristbeginn
- Übergangsrecht und länger fortdauernde steuerliche Bedeutung
- konkurrierende Aufbewahrungs- oder Vernichtungspflichten

## Entscheidungslogik

| Wenn                                                  | Dann                                                                    | Begründung                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| Typ trägt `NONE`                                      | kein Object-Lock und keine gesetzliche Produktfrist setzen              | ungeschützte Produktklasse                                      |
| Typ trägt `GWG`                                       | getrennten GwG-Speicherpfad und technische Fünfjahresbarriere verwenden | eigener Vernichtungsworkflow; keine GoBD-Einordnung             |
| GoBD-Typ hat sechs, acht oder zehn Jahre              | dieses Intervall am gewählten Retention-Anker berechnen                 | dokumenttypbezogene Produktkonfiguration                        |
| Kernklassifikation ist Rechnung                       | acht Jahre verwenden                                                    | technische Abbildung der Buchungsbelegklasse                    |
| Kernklassifikation ist Vertrag                        | sechs Jahre verwenden                                                   | technische Grundannahme für Geschäftsbrief-/sonstige Unterlagen |
| Kernklassifikation ist Steuerunterlage oder unbekannt | zehn Jahre verwenden                                                    | konservativer Produktdefault, keine Rechtsentscheidung          |
| GoBD-Intervall ist ein anderer Wert                   | Upload ablehnen                                                         | zulässige Produktintervalle sind geschlossen                    |

## Ausnahmen und Grenzfälle

§ 147 AO ordnet Fristen nach der Funktion der Unterlage, nicht nach ihrem
Dateinamen. Ein Vertrag kann eine andere steuerliche Bedeutung haben; eine
„Steuerunterlage“ ist nicht automatisch zehn Jahre aufzubewahren. § 147 Abs. 3
AO kann das Fristende bei fortdauernder steuerlicher Bedeutung hinausschieben.
Übergangsregeln zur verkürzten Buchungsbelegfrist und der tatsächlich
maßgebliche Entstehungs-, Empfangs-, Absende- oder Eintragungszeitpunkt sind im
Typ allein nicht enthalten.

## Beispiele

### Normalfall

Eine fachlich als Buchungsbeleg eingeordnete Rechnung wird dem aktiven
GoBD-Rechnungstyp zugewiesen. Die Storage-Schicht berechnet acht volle Jahre
nach dem Jahr des übergebenen Retention-Ankers und setzt den technischen
Stichtag auf den folgenden 1. Januar.

### Grenzfall

Eine Datei heißt „Vertrag“, enthält aber zugleich einen für ein offenes
Steuerverfahren erheblichen Nachweis. Die Sechsjahresvorgabe des Typs darf
nicht ungeprüft als endgültiges Fristende verwendet werden; gegebenenfalls ist
eine andere Klasse oder ein zusätzlicher Schutz erforderlich.

## Umsetzung in TaxTronik

Der Produktanker ist ein Zeitpunkt. Die Rechnung verwendet dessen Kalenderjahr
in Europe/Berlin und setzt die technische Freigabe am folgenden 1. Januar
um 00:00 UTC. Beispielsweise fällt ein Buchungsbeleg vom 31.12.2026 um
23:00 UTC in das deutsche Jahr 2027 und erhält im Achtjahrestyp den
01.01.2036. Frühere Berechnung und Tests verwendeten das UTC-Ankerjahr.
Upload, ursprüngliche Dokumentanlage beim Retag und Zeitpunkt der
Mandantenangaben-Revision sind unterschiedliche, jeweils gespeicherte Anker.
Das gespeicherte Aufbewahrungsende eines Dokuments wird bei neuen Versionen
und beim Retag nur verlängert, nie verkürzt. Ein Retag am Anker der
ursprünglichen Anlage kann deshalb ein von einer späteren Version angehobenes
Ende nicht zurücknehmen; der Object-Lock älterer Versionen bleibt ohnehin
bestehen.
Ob diese das fachliche Ereignis treffen, muss die Kanzlei prüfen. Bei den in
§ 257 Abs. 4 Satz 2 HGB genannten Instituten können für Buchungsbelege zehn
Jahre gelten. Die Produktklasse „Rechnung“ erkennt diesen Branchenfall nicht.

`document-type.ts` erhält für benutzerdefinierte Typen die gewählte
Schutzstufe über eine Carrier-Klassifikation. `service.ts` akzeptiert bei GOBD
nur sechs, acht oder zehn Jahre, berechnet jahresende-basiert den Stichtag und
verwendet für unbekannte GOBD-Klassifikationen zehn Jahre. Die Migration
erzwingt konsistente Intervalle je Schutzstufe in der Datenbank.

## Bekannte Abweichungen und Grenzen

Die Umsetzung ist teilweise. Auswahl und Benennung des Typs beweisen die
rechtliche Einordnung nicht. Als Retention-Anker dient je Pfad typischerweise
Upload-/Dokumentanlage oder ein übergebener Zeitstempel, nicht zwingend das in
§ 147 Abs. 4 AO maßgebliche Ereignis. Übergangsrecht, offene Verfahren,
Legal Holds, mehrere Funktionen derselben Datei und fallbezogene längere
Fristen werden nicht vollständig modelliert.

## Fachliche Prüffragen

- Sind Kern- und benutzerdefinierte Dokumenttypen funktional richtig abgegrenzt?
- Welcher belegte Zeitpunkt muss je Typ als Fristanker verwendet werden?
- Wie werden Übergangsfälle und fortdauernde steuerliche Bedeutung behandelt?
- Wie wird mit einer Datei umgegangen, die mehrere Aufbewahrungszwecke erfüllt?

## Technische Nachweise

Die Retention-Tests belegen die 6/8/10-Zuordnung, Jahresende-Arithmetik,
konservativen Default und unzulässige Intervalle. Der Route-Test belegt, dass
Typ und Frist zwischen Prüfung und Commit stabilisiert werden. Der
Retag-Test gegen PostgreSQL belegt, dass eine Höherstufung von sechs auf acht
Jahre ein durch eine spätere Version auf 2033 angehobenes Aufbewahrungsende
nicht auf 2029 senkt (CVP-Nachprüfung vom 20.11.2026, Befund 1). Kein Test liest
oder klassifiziert den fachlichen Inhalt einer Datei.

Inbox-Staging-Anlagen erhalten vor einer ausdrücklichen Kanzleiannahme keine
Dokumentklasse und keine daraus abgeleitete Aufbewahrungsfrist. Ein Portal-
Kontakt kann weder Schutzstufe noch bindende Dokumentart festlegen. Erst der
getrennte Annahmepfad darf ein klassifiziertes Dokument erzeugen; dessen
fachliche Einordnung bleibt von einer berechtigten Kanzleiperson zu prüfen.

Die Tests vergleichen den letzten Millisekundenwert vor und den ersten Zeitpunkt ab dem deutschen Jahreswechsel. Unbekannte Typnamen fallen auch bei Namensgleichheit mit einem JavaScript-Objektfeld auf zehn Jahre zurück.
