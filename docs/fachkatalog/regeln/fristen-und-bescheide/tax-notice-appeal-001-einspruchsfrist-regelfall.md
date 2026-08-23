---
id: TAX-NOTICE-APPEAL-001
title: Einspruchsfrist im dokumentierten Bekanntgabe-Regelfall berechnen
domain: fristen-und-bescheide
rule_type: professional_interpretation
jurisdiction: DE
validity:
  valid_from: '2025-01-01'
  valid_until: null
professional_owner_role: Berufsträger Steuerrecht
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: Die beschriebenen Standardwege sind implementiert und getestet; besondere Bekanntgabe- und Beweisfälle bleiben manueller Prüfung vorbehalten.
sources:
  - kind: official_law
    citation: § 122 Abs. 2 und 2a AO
    url: https://www.gesetze-im-internet.de/ao_1977/__122.html
    checked_at: '2026-08-23'
    primary: true
  - kind: official_law
    citation: Art. 97 § 1 Abs. 15 EGAO
    url: https://www.gesetze-im-internet.de/aoeg_1977/art_97__1.html
    checked_at: '2026-08-23'
    primary: true
  - kind: official_law
    citation: § 355 Abs. 1 AO
    url: https://www.gesetze-im-internet.de/ao_1977/__355.html
    checked_at: '2026-08-23'
    primary: true
  - kind: official_law
    citation: § 356 AO
    url: https://www.gesetze-im-internet.de/ao_1977/__356.html
    checked_at: '2026-08-23'
    primary: true
  - kind: official_law
    citation: § 108 Abs. 3 AO
    url: https://www.gesetze-im-internet.de/ao_1977/__108.html
    checked_at: '2026-08-23'
    primary: true
  - kind: official_law
    citation: § 187 BGB
    url: https://www.gesetze-im-internet.de/bgb/__187.html
    checked_at: '2026-08-23'
    primary: true
  - kind: official_law
    citation: § 188 BGB
    url: https://www.gesetze-im-internet.de/bgb/__188.html
    checked_at: '2026-08-23'
    primary: true
code_refs:
  - packages/tax/src/engine.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/actions.ts
test_refs:
  - packages/tax/src/__tests__/plausibility-engine.test.ts
feature_refs:
  - FEATURES.md
  - docs/anwenderdoku/kalender-fristen-bescheide.md
related_rules:
  - TAX-DEADLINE-WORKDAY-001
  - TAX-CONTROL-STATUS-001
tags:
  - bescheid
  - bekanntgabe
  - einspruch
---

# TAX-NOTICE-APPEAL-001 — Einspruchsfrist im dokumentierten Bekanntgabe-Regelfall berechnen

## Kurzfassung

TaxTronik ermittelt für dokumentierte Standard-Bekanntgabewege zunächst einen
Bekanntgabetag und berechnet ab diesem grundsätzlich eine Monatsfrist. Bei
fehlender oder unrichtiger Rechtsbehelfsbelehrung wird stattdessen eine
Jahresfrist vorgeschlagen. Das Ergebnis ist ausdrücklich ein
**Kontrollvorschlag**, kein Ersatz für die Prüfung des tatsächlichen Zugangs und
des konkreten Bescheids.

## Wann gilt die Regel?

Die Regel beschreibt Verwaltungsakte ab 1. Januar 2025 in folgenden
Produktfällen: Inlandspost, Auslandspost, unmittelbar elektronisch übermittelter
Verwaltungsakt sowie eine bereits feststehende förmliche, persönliche oder
sonstige Bekanntgabe. Die Bereitstellung zum Datenabruf nach § 122a AO und
besondere Zustellungs-, Vollmachts- oder Beweisfälle sind nicht Gegenstand
dieser Regel.

## Benötigte Angaben

- Bekanntgabeweg
- Aufgabe-, Absendungs- oder nachgewiesener Bekanntgabetag
- gegebenenfalls der nachweislich spätere tatsächliche Zugang
- Angabe, ob die Rechtsbehelfsbelehrung vollständig und richtig ist
- maßgebliche Region für Wochenenden und Feiertage

## Entscheidungslogik

| Bekanntgabeweg oder Umstand                     | Bekanntgabetag im Kontrollvorschlag                     | Anschließende Frist    |
| ----------------------------------------------- | ------------------------------------------------------- | ---------------------- |
| Inlandspost ab 01.01.2025                       | vierter Tag nach Aufgabe; bei Nichtwerktag verschoben   | ein Monat              |
| unmittelbare elektronische Übermittlung         | vierter Tag nach Absendung; bei Nichtwerktag verschoben | ein Monat              |
| Auslandspost                                    | ein Monat nach Aufgabe; bei Nichtwerktag verschoben     | ein Monat              |
| förmlich, persönlich oder sonst nachgewiesen    | eingegebener tatsächlicher Bekanntgabetag               | ein Monat              |
| nachweislich späterer tatsächlicher Zugang      | der spätere tatsächliche Zugang                         | ein Monat              |
| fehlende oder unrichtige Rechtsbehelfsbelehrung | Bekanntgabetag wie oben                                 | grundsätzlich ein Jahr |

Das Ende der Monats- oder Jahresfrist wird bei einem berücksichtigten
Nichtwerktag nach `TAX-DEADLINE-WORKDAY-001` verschoben.

## Ausnahmen und Grenzfälle

Ein früherer tatsächlicher Zugang verkürzt im Produkt die für Inlandspost oder
unmittelbare elektronische Übermittlung ermittelte Fiktion nicht. Bei
bestrittenem Zugang, Zugangsvollmacht, förmlicher Zustellung, öffentlicher
Bekanntgabe, mehreren Beteiligten oder Sonderregelungen ist eine eigenständige
fachliche Prüfung nötig. Für Datenabruf-Fälle gelten zeitabhängige Regeln, die
bewusst nicht in diese Sammelregel aufgenommen sind.

## Beispiele

### Normalfall

Ein inländischer Bescheid wird nachweislich an einem Werktag im Jahr 2026 zur
Post gegeben. TaxTronik ermittelt den vierten Kalendertag, verschiebt diesen
gegebenenfalls auf einen berücksichtigten Werktag und addiert anschließend
einen Kalendermonat. Auch das Fristende wird gegebenenfalls verschoben.

### Grenzfall

Der Mandant nennt nur ein tatsächliches Zugangsdatum, bestreitet aber die
Versandangabe und verlangt Prüfung einer Empfangsvollmacht. Die Kanzlei darf
den automatischen Vorschlag nicht ungeprüft übernehmen, sondern muss
Bekanntgabeweg, Adressat und Nachweise fachlich würdigen.

## Umsetzung in TaxTronik

Die Steuer-Engine besitzt getrennte Berechnungswege für Inlandspost,
Auslandspost und einen bereits feststehenden Bekanntgabetag. Die
Bescheiderfassung ordnet die Eingaben dem gewählten Weg zu und führt
Plausibilitätsprüfungen durch. Altbescheide bis 31. Dezember 2024 werden im Code
noch mit der früheren Drei-Tages-Logik verarbeitet, gehören aber nicht zum
Geltungsbereich dieses Eintrags.

## Bekannte Abweichungen und Grenzen

Die Umsetzung bildet nur die im Abschnitt „Wann gilt die Regel?“ genannten
Wege ab; sie ist kein vollständiges Zustellungs- und Bekanntgaberecht. Der
Feiertagsumfang hat die in `TAX-DEADLINE-WORKDAY-001` beschriebenen Grenzen.
Ist der wirkliche Aufgabe- oder Absendetag nicht feststellbar, erlaubt die
Erfassungsmaske hilfsweise das Bescheiddatum; der daraus berechnete frühere
Kontrolltermin ist keine Feststellung des rechtlichen Bekanntgabetags.
Die Gleichbehandlung der unmittelbar elektronischen Übermittlung mit der
Inlandspost, die Verschiebung des Fiktionstags und sämtliche Beweisfragen sind
vor einer Freigabe ausdrücklich berufsträgerlich zu bestätigen.

## Fachliche Prüffragen

- Ist die Abgrenzung zwischen elektronischer Übermittlung und Datenabruf für
  alle verwendeten Finanzamtswege eindeutig?
- Ist die Behandlung eines früheren beziehungsweise späteren tatsächlichen
  Zugangs fachlich korrekt und ausreichend beweisorientiert?
- In welchen Fällen darf die Jahresfrist nach § 356 AO nicht schematisch
  vorgeschlagen werden?
- Welche Zustellungs- und Vollmachtsfälle benötigen eigene Regeln?

## Technische Nachweise

`engine.ts` enthält die getrennten Rechenwege und die kalendarische Monats- und
Jahresaddition. Die Bescheid-Actions validieren die erforderlichen Eingaben.
Der Plausibilitäts-Test deckt Bekanntgabewege, Rechtsbehelfsbelehrung, spätere
Zugänge und Datumsgrenzen ab.
