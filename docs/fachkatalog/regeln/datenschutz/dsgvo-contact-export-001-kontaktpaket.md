---
id: DSGVO-CONTACT-EXPORT-001
title: Kontaktbezogenes Auskunfts- und Portabilitätspaket vorbereiten
domain: datenschutz
rule_type: professional_interpretation
jurisdiction: EU/DE
validity:
  valid_from: '2018-05-25'
  valid_until: null
professional_owner_role: Berufsträger Datenschutz
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    Das System bündelt direkt oder heuristisch kontaktbezogene Datenklassen in
    einem byte-stabil gehashten JSON-Paket. Dokumentinhalte, Freitexte,
    Altimporte und Drittbezüge erfordern weiterhin eine manuelle Suche und
    Prüfung.
sources:
  - kind: official_law
    citation: Art. 12, 15 und 20 DSGVO
    url: https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=de
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: DSGVO-Konzept, Abschnitt Betroffenenrechte
    path: docs/compliance/dsgvo-konzept.md
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/server/dsgvo/export-package.ts
  - apps/web/src/app/staff/(protected)/admin/dsgvo/actions.ts
  - packages/db/src/dsgvo-contact-export.ts
  - packages/db/src/privacy-notice.ts
  - apps/web/src/server/privacy/notice.ts
  - packages/db/prisma/migrations/20261012101000_dsgvo_export/migration.sql
  - packages/db/prisma/schema.prisma
  - apps/worker/src/jobs/dsgvo-export.ts
  - apps/web/src/server/dsgvo/export-download.ts
  - apps/web/src/server/dsgvo/export-status.ts
  - apps/web/src/app/api/staff/admin/dsgvo/[id]/export/route.ts
  - apps/web/src/app/staff/(protected)/admin/dsgvo/[id]/page.tsx
  - apps/web/src/app/staff/(protected)/admin/dsgvo/[id]/export-button.tsx
  - apps/web/src/server/audit/labels.ts
test_refs:
  - apps/web/src/server/dsgvo/__tests__/export-package.test.ts
  - apps/web/src/server/dsgvo/__tests__/workflow.test.ts
  - packages/db/src/__tests__/dsgvo-contact-export.test.ts
  - apps/worker/src/jobs/__tests__/dsgvo-export.test.ts
  - apps/web/src/server/dsgvo/__tests__/export-download.test.ts
  - apps/web/src/server/dsgvo/__tests__/export-status.test.ts
  - apps/web/src/app/staff/(protected)/admin/dsgvo/__tests__/actions.test.ts
feature_refs:
  - docs/compliance/dsgvo-konzept.md
related_rules:
  - DSGVO-REQUEST-EVIDENCE-001
tags:
  - auskunft
  - datenexport
  - portabilitaet
---

# DSGVO-CONTACT-EXPORT-001 — Kontaktbezogenes Auskunfts- und Portabilitätspaket vorbereiten

## Kurzfassung

TaxTronik erzeugt für einen Mandantenkontakt ein strukturiertes JSON-Paket aus
den technisch zuordenbaren Datenklassen und bindet die exakten Ausgabebytes mit
SHA-256. Das Paket ist eine Arbeitsgrundlage für Auskunft und gegebenenfalls
Datenübertragbarkeit, keine Vollständigkeitsbestätigung. Vor Herausgabe sind
Identität, Umfang, Daten Dritter und weitere Speicherorte manuell zu prüfen.

## Wann gilt die Regel?

Die Regel gilt für einen offenen Vorgang vom Typ `ACCESS` oder `PORTABILITY`
mit Bezug auf einen konkreten `CLIENT_CONTACT`. Sie gilt nicht als
automatischer Export sämtlicher Daten eines Mandanten, aller Akteninhalte oder
aller Daten, die eine Person nur indirekt identifizieren können.

## Benötigte Angaben

- offener DSGVO-Vorgang und Antragstyp
- eindeutig ausgewählter Mandantenkontakt im selben Tenant
- dokumentierte Identitätsprüfung
- manueller Suchumfang für Freitexte, Altbestand und externe Systeme
- Prüfung von Rechten und Daten Dritter

## Entscheidungslogik

| Wenn                                         | Dann                                                         | Begründung                                              |
| -------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| Vorgang ist weder Auskunft noch Portabilität | Kontaktpaket nicht als Ergebnis erzeugen                     | Paket ist auf diese Arbeitsfälle begrenzt               |
| kein eindeutiger Kontaktbezug besteht        | automatische Erzeugung blockieren                            | keine belastbare technische Zuordnung                   |
| direkter Tabellen- oder Auditbezug besteht   | Datenklasse in das Paket aufnehmen                           | reproduzierbare Produktzuordnung                        |
| Telefonnotiz passt nur über Name und Mandant | als heuristischen Treffer aufnehmen und kennzeichnen         | mögliche Relevanz ohne eindeutige Fremdschlüsselbindung |
| Paket wird neu erzeugt                       | exakte Bytes hashen und alte personelle Prüfung zurücksetzen | geänderter Inhalt braucht neue Prüfung                  |
| manuelle Prüfung ist abgeschlossen           | geprüften Hash und Versandnachweis im Vorgang binden         | technischer Abschlussnachweis                           |

## Ausnahmen und Grenzfälle

Namensgleiche Personen können bei Telefonnotizen zu Falschtreffern führen;
abweichende Schreibweisen können Treffer auslassen. Dokumente erscheinen nur
mit Metadaten, nicht mit ihren Dateiinhalten. Freitexte, historische Importe,
gelöste Verknüpfungen, externe Dienste, Empfängerinformationen,
Rechtsgrundlagen und konkrete Löschfristen können zusätzliche manuelle Arbeit
verlangen. Portabilität und Auskunft haben zudem unterschiedliche sachliche
Reichweiten.

## Beispiele

### Normalfall

Ein Portal-Kontakt verlangt Auskunft. Das Paket enthält Kontaktstammdaten,
eigene Antworten, Einwilligungssnapshots, Terminanfragen und direkt
zugeordnete Dokumentmetadaten. Eine Person prüft Paket und weitere Speicherorte
vor dem Versand.

### Grenzfall

Zwei Kontakte desselben Mandanten tragen denselben Namen. Eine Telefonnotiz
wird heuristisch gefunden. Sie darf nicht ungeprüft herausgegeben werden, weil
sie der anderen Person oder beiden Personen zuzuordnen sein kann.

## Umsetzung in TaxTronik

`packages/db/src/dsgvo-contact-export.ts` lädt direkte und heuristische
Beziehungen und serialisiert die festgelegten Datenklassen deterministisch zu
exakt hashbaren Bytes; `export-package.ts` reicht die Serialisierung an die
Web-App durch. Das Paket enthält eigene Hinweise auf manuell zu prüfende
Bereiche und den aktuellen Datenschutzhinweis; dessen Erzeugung liegt seit
Welle 15 unverändert in `packages/db/src/privacy-notice.ts`,
`apps/web/src/server/privacy/notice.ts` reicht sie weiter.

Seit Welle 15 (Folgepunkt P-11) erzeugt der Worker `dsgvo-export` das Paket;
vorher lief die Erzeugung in einer 15-s-Transaktion des Webprozesses. Die
Admin-Action legt nur einen Auftrag in `dsgvo_export` an (Status
Angefordert, höchstens ein aktiver Auftrag je Antrag, nur für einen offenen
Auskunfts- oder Portabilitätsantrag über genau diesen Kontakt) und stößt den
Job an; einen synchronen Pfad für kleine Pakete gibt es nicht, weil die
frühere Erzeugung keine Größenschwelle kannte. Der Worker baut das Paket als
App-Rolle im SYSTEM-Kontext des Tenants (RLS) mit demselben Code wie bisher,
legt die Bytes im Object Store ab und bindet im selben Abschluss wie bisher
den Hash am Antrag, setzt eine frühere Prüfung zurück, schreibt
`dsgvo.export.contact` im Namen der anfordernden Person und setzt den
Auftrag auf Fertig. Fehler enden als Fehlgeschlagen mit Meldung. Ein Auftrag,
der 15 Minuten lang angefordert bleibt oder läuft, gilt als hängengeblieben;
eine neue Anforderung schließt ihn als Fehlgeschlagen ab, ein doch noch
laufender Worker kann ihn danach nicht mehr abschließen. Der Download
liefert nur das am Antrag gebundene Paket nach Größen- und Hash-Prüfung der
gespeicherten Objektversion an ADMIN/PARTNER aus und wird auditiert. Ein
Datenbank-Trigger begrenzt die Statusübergänge des Auftrags und hält dessen
Antrags-, Kontakt- und Personenbezug unveränderlich.

## Bekannte Abweichungen und Grenzen

Die Umsetzung ist teilweise. Es gibt keine vollständige, semantische Suche
über sämtliche Freitexte, Dokumentbytes, Altimporte und Drittsysteme. Die
Telefonnotiz-Zuordnung ist namensbasiert. Auskunftsumfang, Schwärzungen,
Identität, Rechtsgrundlagen, Empfänger und Portabilitätsumfang werden nicht
abschließend automatisch entschieden.

Das zuletzt erzeugte Paket bleibt nach Abschluss des Antrags im Object Store
gespeichert; eine Löschfrist ist nicht festgelegt. Bricht der Worker zwischen
Ablage und Abschluss ab, kann ein nicht gebundenes Paketobjekt verbleiben; es
wird im Worker-Log mit Schlüssel gemeldet, aber nicht automatisch bereinigt.
Pakete über der allgemeinen Upload-Grenze des Object Stores scheitern mit
Meldung.

## Fachliche Prüffragen

- Welche weiteren Datenquellen und Freitextfelder sind je Installation zu durchsuchen?
- Wie wird die Identität vor Herausgabe belastbar dokumentiert?
- Welche Daten Dritter sind zu entfernen oder zu begrenzen?
- Welche Teilmenge erfüllt gegebenenfalls Art. 20 DSGVO?

## Technische Nachweise

Die Tests belegen deterministische Serialisierung, Hashbindung,
Hinweisabschnitte und das Zurücksetzen einer vorherigen Prüfung. Ein
Datenbanktest vergleicht die eingefrorene Erzeugung vor Welle 15 bytegenau mit
dem Paketaufbau im SYSTEM-Kontext und prüft Statusübergänge,
Unveränderlichkeit und Tenant-Isolation des Auftrags. Worker- und Web-Tests
belegen Ablauf, Fehlerstatus, Hashbindung des Downloads und Audit. Sie können
weder Vollständigkeit außerhalb der abgefragten Tabellen noch die fachliche
Richtigkeit einer Herausgabe belegen.
