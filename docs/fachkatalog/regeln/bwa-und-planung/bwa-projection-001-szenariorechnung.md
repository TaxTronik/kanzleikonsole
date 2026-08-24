---
id: BWA-PROJECTION-001
title: BWA-Hochrechnungen nur als bandbreitenbehaftete Szenarien ausweisen
domain: bwa-und-planung
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger BWA und betriebswirtschaftliche Beratung
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: deviates
  summary: >-
    Die lineare Run-rate ist als begrenztes Rechenmodell umgesetzt. Die
    Trendregression filtert jedoch nicht auf Jahre vor dem Zieljahr und kann
    deshalb Ziel- oder Zukunftsjahre einbeziehen; damit weicht sie von der
    beschriebenen Vorjahresregel ab.
sources:
  - kind: product_documentation
    citation: Anwenderdokumentation BWA und Planung, Abschnitt Hochrechnung und Grenzen
    path: docs/anwenderdoku/bwa-planung.md
    checked_at: '2026-08-24'
    primary: true
code_refs:
  - apps/web/src/server/bwa/projection.ts
test_refs:
  - apps/web/src/server/bwa/__tests__/projection.test.ts
feature_refs:
  - docs/anwenderdoku/bwa-planung.md
related_rules:
  - BWA-IMPORT-MAPPING-001
  - BWA-TAX-ESTIMATE-001
tags:
  - bwa
  - hochrechnung
  - szenario
  - regression
  - bandbreite
---

# BWA-PROJECTION-001 — BWA-Hochrechnungen nur als bandbreitenbehaftete Szenarien ausweisen

## Kurzfassung

TaxTronik stellt zwei bewusst einfache Szenarien bereit: eine lineare
Jahres-Run-rate aus der jüngsten unterjährigen Periode und eine lineare
Regression aus mindestens zwei vollständigen Vorjahren. Beide zeigen einen
Schätzwert und eine heuristische Spanne. Die Werte sind keine Garantie für
Ergebnis, Steuer, Liquidität oder Saisonalität.

## Wann gilt die Regel?

Die lineare Hochrechnung gilt nur, wenn im Zieljahr eine Periode mit weniger
als zwölf abgedeckten Monaten vorhanden ist. Die Trendregression soll nur bei
mindestens zwei als `YEAR` erfassten Perioden gelten, die rechnerisch zwölf
Monate umfassen und vor dem Zieljahr liegen. Der aktuelle Code erzwingt die
zeitliche Lage vor dem Zieljahr nicht. Eingaben müssen zuvor nach
`BWA-IMPORT-MAPPING-001` fachlich geprüft worden sein.

Die Regel beschreibt ein Produkt-Rechenmodell. Sie ist keine fachliche
Prognosemethodik für saisonale Betriebe, Strukturbrüche, Gründungen,
Sanierungen, M&A, außergewöhnliche Geschäftsvorfälle oder
Liquiditätsplanung.

## Benötigte Angaben

- fachlich geprüfte BWA-Perioden und Positionen
- Beginn und Ende jeder Periode
- Zieljahr
- für die Run-rate eine aktuelle unterjährige Periode
- für die Regression mindestens zwei vollständige Vorjahre
- Kenntnis wesentlicher Saison-, Struktur- und Einmaleffekte

## Entscheidungslogik

| Wenn                                                            | Dann                                                                             | Begründung                                            |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------- |
| im Zieljahr eine unterjährige Periode vorliegt                  | jüngsten Stand mit `12 / abgedeckte Monate` linear hochrechnen                   | dies ist die ausdrücklich implementierte Run-rate     |
| die Datenabdeckung zunimmt                                      | heuristische Spanne nach der hinterlegten Formel verengen                        | die Restjahresunsicherheit soll sichtbar bleiben      |
| mindestens zwei volle Jahresperioden vor dem Zieljahr vorliegen | je Kennzahl eine lineare Regression auf das Zieljahr rechnen                     | separates Trendszenario aus historischen Jahreswerten |
| Regressionsresiduen klein sind                                  | mindestens fünf Prozent des Schätzwerts als Spanne ansetzen                      | die Anzeige soll nicht künstlich punktgenau werden    |
| ein Ergebnis vor Steuern verfügbar ist                          | dieses statt eines DATEV-Ergebnisses nach Steuern projizieren                    | Ertragsteuern sollen nicht doppelt abgezogen werden   |
| ein positives Vorsteuerergebnis projiziert wird                 | grobe Steuerbandbreite mit 30 Prozent Mitte und 25 bis 35 Prozent Rändern zeigen | reine Produktpauschale, keine Steuerberechnung        |
| Datenbasis oder Kennzahl fehlt                                  | für diese Strategie oder Achse `null` liefern                                    | fehlende Werte werden nicht erfunden                  |

## Ausnahmen und Grenzfälle

Der Name `linearSeasonalProjection` ändert nichts daran, dass keine echte
Saisongewichtung stattfindet. Monate werden nur gezählt; Monatsverteilungen
früherer Jahre werden nicht verwendet. Die Regressionsspanne ist kein
statistisches Konfidenzintervall, sondern das Maximum aus 1,5-facher
Residuenstandardabweichung und fünf Prozent des Schätzwerts.

Die pauschale Steuerachse ist Teil der Szenarioanzeige und nicht identisch mit
der detaillierteren, ebenfalls nur teilweisen Steuerschätzung nach
`BWA-TAX-ESTIMATE-001`. Verlustnutzung, Vorauszahlungen, Steuersubjekt,
Rechtsform, kommunaler Hebesatz und persönliche Verhältnisse fehlen in dieser
Projektionspauschale vollständig.

## Beispiele

### Normalfall

Nach sechs Monaten beträgt das geprüfte Ergebnis vor Steuern 200.000 Euro.
Die lineare Mitte beträgt 400.000 Euro. TaxTronik zeigt zusätzlich die nach
Datenabdeckung berechnete Bandbreite und eine grobe Steuerbandbreite. Der
Berater ergänzt bekannte Saison- und Einmaleffekte außerhalb des Modells.

### Grenzfall

Zwei volle Vorjahre enthalten einen einmaligen Veräußerungsgewinn. Die
Regression kann technisch einen Trendwert liefern, erkennt den Einmaleffekt
aber nicht. Der Wert darf nicht ungeprüft als Erwartung oder Planvorgabe
verwendet werden.

## Umsetzung in TaxTronik

`linearSeasonalProjection` wählt die jüngste unterjährige Periode des
Zieljahrs, zählt UTC-Kalendermonate und rechnet jede vorhandene Kennzahl linear
hoch. `trendRegressionProjection` verwendet vollständige Jahresperioden und
berechnet je Achse Steigung, Achsenabschnitt und Residuenstreuung. Beide Pfade
nutzen das Ergebnis vor Ertragsteuern und geben `estimate`, `low` und `high`
aus. Bei der Regression fehlt aktuell der Filter `Periodenjahr < Zieljahr`.

## Bekannte Abweichungen und Grenzen

Die Umsetzung weicht bei der Trendregression von der beschriebenen Regel ab:
Sie nimmt alle rechnerisch zwölfmonatigen `YEAR`-Perioden und kann dadurch auch
das Zieljahr oder spätere Jahre einbeziehen. Darüber hinaus bestehen keine
echte Saisonalität, keine Kausal- oder Treibermodelle, keine
Strukturbrucherkennung, keine Wahrscheinlichkeitskalibrierung, keine
Liquiditätsrechnung und keine belastbare Steuerprognose. Der vorhandene Test
fokussiert die lineare Vorsteuerbasis und den Schutz vor doppeltem Steuerabzug;
die Regression und ihre Bandbreite werden darin nicht nachgewiesen.

## Fachliche Prüffragen

- Welche Betriebe dürfen ohne manuelle Saisonkorrektur linear hochgerechnet
  werden?
- Welche Mindestdatenqualität und welche Strukturbruchkontrollen sind nötig?
- Ist die heuristische Spanne für die freigegebenen Anwendungsfälle
  ausreichend konservativ?
- Soll die grobe Steuerpauschale aus der Projektion entfernt oder ausdrücklich
  von einer fachlich geprüften Steuerrechnung ersetzt werden?

## Technische Nachweise

Der referenzierte Test belegt für synthetische DATEV-Werte, dass die
Vorsteuerposition projiziert und die Steuerpauschale nur einmal abgezogen
wird. Er bestätigt weder die zeitliche Auswahl noch die Berechnung der
Regression und auch nicht Prognosegüte, Saisonalität, Steuerbelastung oder
Liquiditätswirkung eines realen Mandats.
