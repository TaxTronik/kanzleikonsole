---
id: DSGVO-REQUEST-DEADLINE-001
title: Monatsfrist für Betroffenenanträge als Kontrolltermin berechnen
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
    TaxTronik berechnet ab dem dokumentierten Eingang monatsende-sicher einen
    Kontrolltermin einen Kalendermonat später. Verlängerung, Identitätsklärung
    und weitere einzelfallbezogene Abweichungen sind nicht modelliert.
sources:
  - kind: official_law
    citation: Art. 12 Abs. 3 und 6 DSGVO
    url: https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=de
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: DSGVO-Lösch-, Aufbewahrungs- und Verarbeitungskonzept
    path: docs/compliance/dsgvo-konzept.md
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/server/dsgvo/deadline.ts
  - apps/web/src/app/staff/(protected)/admin/dsgvo/actions.ts
test_refs:
  - apps/web/src/server/dsgvo/__tests__/deadline.test.ts
feature_refs:
  - docs/compliance/dsgvo-konzept.md
related_rules:
  - DSGVO-REQUEST-EVIDENCE-001
tags:
  - betroffenenantrag
  - frist
  - kontrolltermin
---

# DSGVO-REQUEST-DEADLINE-001 — Monatsfrist für Betroffenenanträge als Kontrolltermin berechnen

## Kurzfassung

Art. 12 Abs. 3 DSGVO verlangt die Information über Maßnahmen grundsätzlich
unverzüglich, spätestens innerhalb eines Monats nach Antragseingang. TaxTronik
berechnet dafür ab dem erfassten Eingangsdatum einen monatsende-sicheren
Kontrolltermin. Dieser Wert ist kein abschließend freigegebenes Fristende.

## Wann gilt die Regel?

Die Regel gilt für in TaxTronik erfasste Betroffenenanträge, deren tatsächlicher
Eingangstag dokumentiert ist. Sie beschreibt nur den unverlängerten Regelfall.
Eine mögliche Verlängerung um weitere zwei Monate, Zweifel an der Identität,
eine offensichtlich unbegründete oder exzessive Anfrage und sonstige
Einzelfallfragen werden nicht automatisch entschieden.

## Benötigte Angaben

- tatsächliches Eingangsdatum des Antrags
- Identität und Kontaktweg der betroffenen Person
- Art und Umfang des geltend gemachten Rechts
- dokumentierte Gründe für eine mögliche Verlängerung oder Rückfrage

## Entscheidungslogik

| Wenn                                                  | Dann                                                              | Begründung                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| Eingangstag ist belastbar erfasst                     | Kontrolltermin einen Kalendermonat später berechnen               | technischer Regelfall zu Art. 12 Abs. 3 DSGVO              |
| der Zielmonat hat den Eingangstag nicht               | letzten Kalendertag des Zielmonats verwenden                      | monatsende-sichere Kalenderrechnung                        |
| Wochenende oder Feiertag fällt auf den Termin         | Termin nicht automatisch nach hinten verschieben                  | Produkt zeigt bewusst den früheren Kontrolltermin          |
| Verlängerung oder Identitätsklärung kommt in Betracht | nicht automatisch umrechnen; manuell beurteilen und dokumentieren | Tatbestand und Mitteilungspflichten sind einzelfallbezogen |

## Ausnahmen und Grenzfälle

Die zulässige Verlängerung nach Art. 12 Abs. 3 DSGVO hängt von Komplexität und
Anzahl der Anträge ab und verlangt eine rechtzeitige Mitteilung mit Gründen.
Art. 12 Abs. 6 erlaubt bei begründeten Zweifeln zusätzliche Informationen zur
Identitätsbestätigung. Die aktuelle Datenstruktur bildet weder eine eigene
Verlängerungsentscheidung noch deren Mitteilung und auch keine gesonderte
Zeitrechnung für Identitätsrückfragen ab.

## Beispiele

### Normalfall

Ein Antrag geht am 12. August 2026 ein. TaxTronik zeigt den 12. September 2026
als Kontrolltermin. Der Vorgang muss gleichwohl unverzüglich bearbeitet werden.

### Grenzfall

Ein Antrag geht am 31. Januar 2026 ein. Der technische Kontrolltermin ist der 28. Februar 2026. Ob eine Verlängerung zulässig ist, entscheidet die Kanzlei
gesondert und darf nicht durch bloßes Ändern des Eingangstags simuliert werden.

## Umsetzung in TaxTronik

`dsgvoResponseDeadline` addiert in UTC genau einen Kalendermonat und begrenzt
den Tag auf das Ende des Zielmonats. Die Admin-Action speichert den tatsächlichen
Eingang und den daraus berechneten Termin. Wochenenden und Feiertage werden
nicht nach hinten verschoben, damit die Anzeige nicht zu einem späteren und
dadurch riskanteren internen Kontrolltermin führt.

## Bekannte Abweichungen und Grenzen

Die Umsetzung ist teilweise: Sie kennt nur den unverlängerten Monatswert. Es
fehlen strukturierte Entscheidungen und Nachweise für die Zwei-Monats-
Verlängerung, deren Mitteilung, Identitätszweifel und weitere Ablehnungs- oder
Gebührenfälle. Der angezeigte Wert darf deshalb nicht als vollständige
rechtliche Fristberechnung bezeichnet werden.

## Fachliche Prüffragen

- Genügt der bewusst nicht nach hinten verschobene Kontrolltermin der
  kanzleiinternen Fristenorganisation?
- Welche Angaben und Freigaben braucht eine Verlängerungsentscheidung?
- Wie sollen Identitätsrückfragen und ihre Auswirkungen dokumentiert werden?
- Welche weiteren Fallgruppen müssen vor einer Fachfreigabe modelliert werden?

## Technische Nachweise

Der referenzierte Unit-Test belegt Monatswechsel, Monatsende, Schaltjahr und
den unveränderten Wochenend-/Feiertagswert. Er belegt weder die rechtliche
Zulässigkeit einer Verlängerung noch eine vollständige Einzelfallprüfung.
