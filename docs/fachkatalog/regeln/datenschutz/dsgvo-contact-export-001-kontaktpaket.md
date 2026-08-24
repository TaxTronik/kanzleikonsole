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
test_refs:
  - apps/web/src/server/dsgvo/__tests__/export-package.test.ts
  - apps/web/src/server/dsgvo/__tests__/workflow.test.ts
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

`export-package.ts` serialisiert die festgelegten Datenklassen deterministisch
und gibt damit exakt hashbare Bytes zurück. Die Admin-Action lädt direkte und
heuristische Beziehungen, speichert den Hash als Ergebnisnachweis und setzt
eine frühere Prüfung bei jeder Neuerzeugung zurück. Das Paket enthält eigene
Hinweise auf manuell zu prüfende Bereiche.

## Bekannte Abweichungen und Grenzen

Die Umsetzung ist teilweise. Es gibt keine vollständige, semantische Suche
über sämtliche Freitexte, Dokumentbytes, Altimporte und Drittsysteme. Die
Telefonnotiz-Zuordnung ist namensbasiert. Auskunftsumfang, Schwärzungen,
Identität, Rechtsgrundlagen, Empfänger und Portabilitätsumfang werden nicht
abschließend automatisch entschieden.

## Fachliche Prüffragen

- Welche weiteren Datenquellen und Freitextfelder sind je Installation zu durchsuchen?
- Wie wird die Identität vor Herausgabe belastbar dokumentiert?
- Welche Daten Dritter sind zu entfernen oder zu begrenzen?
- Welche Teilmenge erfüllt gegebenenfalls Art. 20 DSGVO?

## Technische Nachweise

Die Tests belegen deterministische Serialisierung, Hashbindung,
Hinweisabschnitte und das Zurücksetzen einer vorherigen Prüfung. Sie können
weder Vollständigkeit außerhalb der abgefragten Tabellen noch die fachliche
Richtigkeit einer Herausgabe belegen.
