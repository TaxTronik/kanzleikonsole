---
id: INV-VAT-TOTALS-001
title: Netto-, Umsatzsteuer- und Bruttosummen je Steuersatzgruppe bilden
domain: rechnungen
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Umsatzsteuer und Rechnungswesen
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: TaxTronik gruppiert In-App-Positionen nach USt-Satz, rundet die Steuer je Gruppe und erzeugt daraus konsistente Netto-, Steuer- und Bruttosummen.
sources:
  - kind: official_law
    citation: § 14 Abs. 4 Nr. 7 und 8 UStG, Aufschlüsselung des Entgelts und Ausweis von Steuersatz oder Befreiung
    url: https://www.gesetze-im-internet.de/ustg_1980/__14.html
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: § 12 UStG, allgemeiner und ermäßigter Umsatzsteuersatz
    url: https://www.gesetze-im-internet.de/ustg_1980/__12.html
    checked_at: '2026-08-24'
    primary: false
  - kind: technical_standard
    citation: KoSIT, Spezifikation XRechnung 3.0.2, VAT Breakdown und Umsatzsteuerregeln
    url: https://xeinkauf.de/app/uploads/2024/07/XRechnung-v3.0.2.pdf
    checked_at: '2026-08-24'
    primary: false
  - kind: product_documentation
    citation: Technische Modulbeschreibung Fakturierung, USt-Logik und E-Rechnung
    path: docs/development/module/fakturierung.md
    checked_at: '2026-08-24'
    primary: true
code_refs:
  - apps/web/src/server/invoicing/vat.ts
  - apps/web/src/server/invoicing/time-billing.ts
  - apps/web/src/server/invoicing/xrechnung.ts
test_refs:
  - apps/web/src/server/invoicing/__tests__/vat.test.ts
  - apps/web/src/server/invoicing/__tests__/time-billing.test.ts
  - apps/web/src/server/invoicing/__tests__/xrechnung.test.ts
feature_refs:
  - docs/development/module/fakturierung.md
  - docs/anwenderdoku/rechnungen.md
  - docs/adr/0008-xrechnung-zugferd-en16931.md
related_rules:
  - INV-ARCHIVE-EINVOICE-001
  - INV-STORNO-REFERENCE-001
  - INV-TIME-ENTRY-CLAIM-001
tags:
  - rechnung
  - umsatzsteuer
  - summen
  - xrechnung
---

# INV-VAT-TOTALS-001 — Netto-, Umsatzsteuer- und Bruttosummen je Steuersatzgruppe bilden

## Kurzfassung

TaxTronik berechnet In-App-Rechnungsbeträge serverseitig aus den Positionen.
Nettobeträge werden nach Umsatzsteuersatz gruppiert, die Steuer wird einmal je
Gruppe auf zwei Dezimalstellen gerundet und die Kopfwerte werden aus den
Gruppensummen gebildet. Für E-Rechnungen werden technische Kategorien für
steuerpflichtige, nullbesteuerte, befreite und Reverse-Charge-Positionen
abgeleitet.

## Wann gilt die Regel?

Die Regel gilt für in TaxTronik erzeugte In-App-Rechnungen und
Stundenabrechnungen. Sie beschreibt Rechenweg und technische Abbildung der
erfassten Steuermerkmale. Sie entscheidet nicht, welcher Satz oder welche
Steuerbefreiung für eine konkrete Leistung materiell-rechtlich zutrifft.
Extern hochgeladene PDFs werden nicht positionsweise nachgerechnet.

## Benötigte Angaben

- Menge und positiver Einzelpreis jeder Position
- daraus berechneter Nettobetrag je Position
- erfasster Umsatzsteuersatz je Position
- bei 0 Prozent gegebenenfalls Befreiungsgrund
- Kennzeichnung Reverse Charge
- Rechnungswährung und für die E-Rechnung erforderliche Verkäufer-/Käuferdaten

## Entscheidungslogik

| Eingabe                                                | Ergebnis                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| mehrere Positionen mit demselben Satz                  | Nettobeträge addieren und Steuer einmal auf Gruppensumme runden |
| mehrere Sätze                                          | getrennte Gruppen bilden; Kopf-Steuersatz auf `null` setzen     |
| Satz größer 0                                          | technische EN-16931-Kategorie `S` verwenden                     |
| 0 Prozent mit Befreiungsgrund                          | Kategorie `E` und Befreiungsgrund ausgeben                      |
| 0 Prozent ohne Befreiungsgrund und ohne Reverse Charge | In-App-Anlage ablehnen                                          |
| Reverse Charge                                         | nur 0-Prozent-Positionen zulassen und Kategorie `AE` verwenden  |
| Netto- und Steuergruppen sind berechnet                | Netto und Steuer summieren; Brutto als gerundete Summe bilden   |

## Ausnahmen und Grenzfälle

Die In-App-Actions lassen derzeit nur 0, 7 und 19 Prozent zu. Die reine
Summenfunktion kann rechnerisch weitere numerische Sätze gruppieren, ist aber
nicht der Eingabe-Guard. Bei drei Positionen zu 0,33 Euro und 19 Prozent
entsteht aus 0,99 Euro Gruppen-Netto eine Steuer von 0,19 Euro; eine Rundung je
Position würde abweichen.

## Beispiele

### Normalfall

Eine Rechnung enthält 100 Euro zu 19 Prozent und 100 Euro zu 7 Prozent. Die
Gruppensteuer beträgt 19 Euro und 7 Euro; Kopfwerte sind 200 Euro netto, 26
Euro Umsatzsteuer und 226 Euro brutto.

### Grenzfall

Eine Position ist mit 0 Prozent erfasst. Ohne Reverse-Charge-Kennzeichnung oder
Befreiungsgrund verweigert der In-App-Anlagepfad den Entwurf, statt die
steuerliche Bedeutung des Nullsatzes still zu erraten.

## Umsetzung in TaxTronik

`vat.ts` gruppiert und rundet die Werte und ordnet technische
Steuerkategorien zu. Die Rechnungs- und Stunden-Actions validieren den engen
Satzvorrat und zusätzliche Nullsatzangaben. `xrechnung.ts` erzeugt je Gruppe
einen Header-Steuerblock und verwendet dieselben Gruppen für die strukturierten
Summen.

## Bekannte Abweichungen und Grenzen

Die technische Summenbildung ist umgesetzt, die fachliche Steuerlogik jedoch
nur teilweise. Die Auswahl des richtigen Steuersatzes, Voraussetzungen von
Steuerbefreiungen und § 13b UStG, Sonderbemessungsgrundlagen,
innergemeinschaftliche oder internationale Fälle, Kleinbetrags- und
Anzahlungsrechnungen sowie weitere gesetzliche Pflichtangaben sind nicht
vollständig als Regeln modelliert. Die Whitelist 0/7/19 ist keine Aussage,
dass diese Sätze in jedem Kanzleisachverhalt ausreichen oder richtig sind.

## Fachliche Prüffragen

- Für welche Leistungen der Kanzlei kommen 7 Prozent oder 0 Prozent überhaupt
  zulässig in Betracht?
- Welche Nachweise und Pflichtangaben brauchen Befreiung und Reverse Charge?
- Welche Rundungsmethode soll für alle unterstützten Zielsysteme verbindlich
  sein?
- Welche Sonderfälle müssen vor produktiver Nutzung ausgeschlossen oder als
  eigene Regeln ergänzt werden?
- Muss EXTERNAL mehr als einen erfassten Kopfsatz abbilden können?

## Technische Nachweise

Die VAT-Tests prüfen einheitliche und gemischte Sätze, Gruppensortierung,
Gruppenrundung, Nullwerte und Kategorien `S`, `Z`, `E` und `AE`.
Stundenabrechnungstests prüfen die Nullsatz-Guards; XRechnungstests prüfen
Steuerblöcke und konsistente Netto-, Steuer- und Bruttosummen der Fixture.
