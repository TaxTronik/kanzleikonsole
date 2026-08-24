---
id: DSGVO-REQUEST-EVIDENCE-001
title: Abschluss und Ablehnung eines Betroffenenantrags technisch nachweisen
domain: datenschutz
rule_type: product_rule
jurisdiction: EU/DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Datenschutz
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: >-
    Terminale Vorgänge verlangen einen Versandnachweis und je nach Ergebnis
    ein geprüftes Ergebnisartefakt oder eine begründete Ablehnung; Datenbank-
    Invarianten frieren den technischen Abschlussstand ein.
sources:
  - kind: product_documentation
    citation: DSGVO-Lösch-, Aufbewahrungs- und Verarbeitungskonzept
    path: docs/compliance/dsgvo-konzept.md
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: Art. 12 Abs. 1 bis 5 sowie Art. 15 bis 20 DSGVO
    url: https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=de
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/server/dsgvo/workflow.ts
  - apps/web/src/app/staff/(protected)/admin/dsgvo/actions.ts
  - packages/db/prisma/migrations/20260801003510_dsgvo_request_evidence/migration.sql
test_refs:
  - apps/web/src/server/dsgvo/__tests__/workflow.test.ts
  - packages/db/src/__tests__/dsgvo-evidence.test.ts
feature_refs:
  - docs/compliance/dsgvo-konzept.md
related_rules:
  - DSGVO-REQUEST-DEADLINE-001
  - DSGVO-CONTACT-EXPORT-001
tags:
  - betroffenenantrag
  - nachweis
  - abschluss
---

# DSGVO-REQUEST-EVIDENCE-001 — Abschluss und Ablehnung eines Betroffenenantrags technisch nachweisen

## Kurzfassung

TaxTronik lässt einen Betroffenenantrag nur mit einem strukturierten
technischen Nachweis auf `COMPLETED` oder `REJECTED` wechseln. Auskunft und
Datenübertragbarkeit benötigen ein Ergebnisartefakt, eine dokumentierte
personelle Prüfung und einen Versandnachweis; eine Ablehnung benötigt eine
Begründung und den bestätigten Hinweis auf Rechtsbehelfe. Das Produkt beurteilt
nicht, ob Inhalt und Rechtsauffassung fachlich richtig sind.

## Wann gilt die Regel?

Die Regel gilt beim terminalen Abschluss eines im DSGVO-Modul geführten
Vorgangs. Arbeitsstände `RECEIVED` und `IN_PROGRESS` bleiben änderbar.
`COMPLETED` und `REJECTED` sind im bezeichneten Datenmodell terminal und werden
als eingefrorener Beweisstand behandelt.

## Benötigte Angaben

- Antragstyp und dokumentierter Eingang
- aussagekräftige interne Abschlussnotiz
- bei Auskunft oder Portabilität: Ergebnisdatei oder SHA-256 des Exportpakets
- vorbereitende und prüfende Person samt Zeitpunkten
- Versanddatum und Versandweg
- bei Ablehnung: konkrete Begründung und Bestätigung des Beschwerde-/Rechtsbehelfshinweises

## Entscheidungslogik

| Wenn                                                  | Dann                                                                               | Begründung                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------- |
| Arbeitsvorgang bleibt offen                           | Status `RECEIVED` oder `IN_PROGRESS` zulassen                                      | noch kein Abschlussnachweis behauptet          |
| Auskunft/Portabilität soll abgeschlossen werden       | Ergebnis, personelle Prüfung und Versandnachweis verlangen                         | technischer Mindestnachweis für die Antwort    |
| anderer Antrag soll abgeschlossen werden              | Abschlussnotiz und Versandnachweis verlangen                                       | nachvollziehbarer terminaler Stand             |
| Antrag soll abgelehnt werden                          | ausreichend konkrete Begründung, Versandnachweis und bestätigten Hinweis verlangen | Ablehnung darf nicht beweislos terminal werden |
| terminaler Datensatz soll inhaltlich verändert werden | Änderung datenbankseitig blockieren                                                | Abschlussnachweis bleibt unverändert           |

## Ausnahmen und Grenzfälle

Der Bestätigungsschritt belegt nur, dass eine Person den im Produkt angezeigten
Stand geprüft hat. Er prüft weder Berufsqualifikation noch inhaltliche
Vollständigkeit, Identität, zulässige Schwärzungen, Empfänger oder die
materielle Rechtmäßigkeit einer Ablehnung. Eine notwendige Korrektur erfolgt
nicht durch Überschreiben des terminalen Beweisstands.

## Beispiele

### Normalfall

Ein Auskunftspaket wird erzeugt, gehasht, von einer zweiten Person geprüft und
am dokumentierten Tag per sicherem Weg übermittelt. Erst mit diesen Angaben
kann der Vorgang abgeschlossen werden.

### Grenzfall

Eine Ablehnung enthält nur „nicht möglich“. Die Mindestlänge und der
fehlende Versandnachweis blockieren den Abschluss. Auch eine längere Begründung
würde ihre fachliche Richtigkeit nicht automatisch beweisen.

## Umsetzung in TaxTronik

`workflow.ts` validiert die statusabhängigen Pflichtfelder. Die Admin-Actions
erzeugen und prüfen Ergebnisartefakte, speichern Versandangaben und führen den
Statuswechsel aus. Check-Constraints sichern Feldpaare, Reihenfolge und
Hashlänge; ein Trigger blockiert Änderungen an terminalen Nachweisen und prüft
die Mandantenzugehörigkeit eines Ergebnisdokuments.

## Bekannte Abweichungen und Grenzen

Keine bekannte technische Abweichung innerhalb des eng beschriebenen
Nachweis- und Unveränderlichkeitsscopes. Nicht umfasst sind die materielle
Entscheidung über den Antrag, eine qualifikationsgebundene Freigabe, die
Authentizität eines externen Versandbelegs und ein eigener Korrekturworkflow
für bereits terminale Fälle.

## Fachliche Prüffragen

- Welche Rolle darf Ergebnis und Ablehnung fachlich freigeben?
- Welche Versandwege und Belege gelten kanzleiintern als ausreichend?
- Wie wird eine erforderliche Korrektur eines terminalen Vorgangs geführt?
- Reichen die statusabhängigen Pflichtfelder für alle Betroffenenrechte aus?

## Technische Nachweise

Workflow-Tests prüfen Pflichtfelder und Statusübergänge. Der
Datenbank-Integrationstest belegt Feldpaare, Ergebnisdokument-Tenantgrenze und
Unveränderlichkeit des terminalen Stands. Diese Tests validieren keinen
Antwortinhalt und keine Rechtsauffassung.
