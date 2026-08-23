---
id: TAX-DEADLINE-WORKDAY-001
title: Fristende auf den nächsten Werktag verschieben
domain: fristen-und-bescheide
rule_type: statute
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Steuerrecht
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: Die Verschiebung ist implementiert und getestet; örtliche Feiertage und historische Feiertagsstände sind nur teilweise abgebildet.
sources:
  - kind: official_law
    citation: § 108 Abs. 3 AO
    url: https://www.gesetze-im-internet.de/ao_1977/__108.html
    checked_at: '2026-08-23'
    primary: true
code_refs:
  - packages/tax/src/engine.ts
  - packages/tax/src/materialize.ts
test_refs:
  - packages/tax/src/__tests__/engine.test.ts
  - packages/tax/src/__tests__/plausibility-engine.test.ts
feature_refs:
  - FEATURES.md
  - docs/anwenderdoku/kalender-fristen-bescheide.md
related_rules:
  - TAX-NOTICE-APPEAL-001
tags:
  - fristende
  - feiertag
  - werktag
---

# TAX-DEADLINE-WORKDAY-001 — Fristende auf den nächsten Werktag verschieben

## Kurzfassung

Fällt das Ende einer steuerlichen Frist auf einen Samstag, Sonntag oder am
maßgeblichen Ort geltenden gesetzlichen Feiertag, verschiebt TaxTronik das
Ergebnis auf den nächsten berücksichtigten Werktag. Das Ergebnis bleibt ein
Kontrollvorschlag, weil örtliche und historische Feiertagsbesonderheiten nicht
vollständig modelliert sind.

## Wann gilt die Regel?

Die Regel gilt für Fristenden, auf die § 108 Abs. 3 AO anwendbar ist und die
TaxTronik aus einer fachlich passenden Ausgangsregel berechnet. Ob § 108 AO für
den konkreten Termin überhaupt gilt, wird durch diese Regel nicht entschieden.
Insbesondere behördlich gesetzte Termine und andere gesetzliche Ausnahmen sind
vorher gesondert einzuordnen.

## Benötigte Angaben

- zunächst berechnetes Fristende
- maßgebliches Bundesland
- bei Bayern die für Mariä Himmelfahrt verwendete Gemeindeannahme
- für den Einzelfall bekannte örtliche Feiertage

## Entscheidungslogik

| Wenn                                                        | Dann                                                       | Begründung                      |
| ----------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------- |
| Fristende ist Samstag oder Sonntag                          | Auf den nächsten berücksichtigten Werktag verschieben      | § 108 Abs. 3 AO                 |
| Fristende ist ein für den Standort hinterlegter Feiertag    | Auf den nächsten berücksichtigten Werktag verschieben      | § 108 Abs. 3 AO                 |
| Auch der Folgetag ist Wochenende oder hinterlegter Feiertag | Weitergehen, bis ein berücksichtigter Werktag erreicht ist | Kettenverschiebung              |
| Kein Ausschlusstag liegt vor                                | Ursprüngliches Fristende beibehalten                       | Keine Verschiebung erforderlich |

## Ausnahmen und Grenzfälle

Die Norm enthält Ausnahmen, etwa für bestimmte behördlich gesetzte Termine;
diese Regel darf nicht ohne Prüfung auf jeden im Kalender „Termin“ genannten
Tag übertragen werden. Maßgeblich kann zudem ein anderer Feiertagsort als der
Kanzleisitz sein. Kommunale Besonderheiten und frühere Feiertagsfassungen
können von der hinterlegten Liste abweichen.

## Beispiele

### Normalfall

Das zunächst berechnete Fristende fällt auf einen Sonntag. Der Montag ist am
konfigurierten Standort kein Feiertag. TaxTronik zeigt den Montag als
verschobenes Fristende an.

### Grenzfall

Das zunächst berechnete Fristende fällt auf einen landes- oder ortsabhängigen
Feiertag. Ist der maßgebliche Ort nicht eindeutig oder der Feiertag nicht
hinterlegt, muss die Kanzlei das Ergebnis manuell prüfen und gegebenenfalls
korrigieren.

## Umsetzung in TaxTronik

Die Steuer-Engine arbeitet mit UTC-Kalendertagen und wertet die Fälligkeit im
Kanzleialltag mit Tagesgrenzen für `Europe/Berlin` aus. Sie berücksichtigt
Samstag, Sonntag, bundesweite Feiertage und eine Auswahl landesabhängiger
Feiertage. Die Tenant-Einstellung liefert das Bundesland; für Mariä Himmelfahrt
in Bayern existiert zusätzlich eine Gemeindeannahme.

## Bekannte Abweichungen und Grenzen

Die Feiertagsdaten sind nicht nach historischem Rechtsstand versioniert. Eine
kommunale Differenzierung besteht nur für die bayerische Annahme zu Mariä
Himmelfahrt; andere örtliche Besonderheiten sind nicht modelliert. Deshalb ist
die technische Umsetzung nur als **teilweise** gekennzeichnet, obwohl die
vorhandenen Fälle automatisiert getestet werden.

## Fachliche Prüffragen

- Für welche Arten von Steuerterminen ist § 108 Abs. 3 AO in TaxTronik
  tatsächlich anwendbar, und welche Ausnahmen müssen eigene Regeln erhalten?
- Welcher Ort ist je Fristart für die Feiertagsprüfung maßgeblich?
- Reicht die vorhandene regionale Granularität für die eingesetzten Kanzleien?
- Ab welchem Rechtsstand müssen Feiertagskalender versioniert werden?

## Technische Nachweise

`engine.ts` enthält Feiertagsberechnung und Werktagsverschiebung;
`materialize.ts` übernimmt die Tenant-Region. Die referenzierten Tests prüfen
Wochenenden, Bundes- und Landesfeiertage sowie Monats- und Jahresgrenzen.
