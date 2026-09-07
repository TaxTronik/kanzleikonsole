---
id: BWA-IMPORT-MAPPING-001
title: DATEV- und Addison-BWA nur anhand bekannter Strukturen importieren
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
  status: partial
  summary: >-
    Strukturierte DATEV-XLSX- und Addison-CSV-Daten werden anhand fest
    hinterlegter Perioden- und BWA-Positionsmuster importiert. Vollständigkeit,
    Vorzeichen, Kontenrahmen, Quellformat und fachliche Plausibilität werden
    nicht abschließend automatisch festgestellt. DATEV-Umsatzerlöse,
    Gesamtleistung, betriebliche Kosten und Ergebnis vor Steuern werden getrennt;
    unvollständige oder nicht darstellbare Planbasen werden nicht automatisch vorbelegt.
sources:
  - kind: technical_standard
    citation: DATEV-Musterauswertung Planungsrechnung, Planungscockpit BWA 01 Kurzform, Positionen 1020, 1051, 1060, 1090, 1280, 1300, 1345 und 1380
    url: https://www.datev.de/dnlexom/v2/content/files/st13860276747_de.pdf
    checked_at: '2026-08-24'
    primary: false
  - kind: technical_standard
    citation: DATEV Standard-BAB SKR42, getrennte Umsatzerlöse, Gesamtleistung, Betriebsergebnis, neutraler Aufwand/Ertrag und Ergebnis vor Steuern
    url: https://help-center.apps.datev.de/api/amr/knowledge-common/v1/entities/st18014421205989515_de.pdf
    checked_at: '2026-09-07'
    primary: false
  - kind: product_documentation
    citation: Anwenderdokumentation BWA und Planung, Abschnitt Import und Prüfpflichten
    path: docs/anwenderdoku/bwa-planung.md
    checked_at: '2026-08-24'
    primary: true
code_refs:
  - apps/web/src/app/portal/(protected)/bwa/plan/plan-wizard.tsx
  - apps/web/src/app/portal/(protected)/bwa/plan/new/page.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/bwa/plans/new/page.tsx
  - apps/web/src/server/bwa/datev-parser.ts
  - apps/web/src/server/bwa/addison-parser.ts
  - apps/web/src/server/bwa/plan-basis.ts
  - apps/web/src/server/bwa/liquidity.ts
  - apps/web/src/lib/xlsx/read-xlsx.ts
  - apps/web/src/lib/xlsx/xml.ts
test_refs:
  - apps/web/src/components/bwa/__tests__/plan-page-basis.test.tsx
  - apps/e2e/tests/21-bwa-basis-state.spec.ts
  - apps/web/src/server/bwa/__tests__/datev-parser.test.ts
  - apps/web/src/server/bwa/__tests__/addison-parser.test.ts
  - apps/web/src/server/bwa/__tests__/kpis.test.ts
  - apps/web/src/server/bwa/__tests__/plan-basis.test.ts
  - apps/web/src/server/bwa/__tests__/liquidity.test.ts
  - apps/web/src/lib/xlsx/__tests__/read-xlsx.test.ts
  - apps/web/src/lib/xlsx/__tests__/xml.test.ts
feature_refs:
  - docs/anwenderdoku/bwa-planung.md
related_rules:
  - BWA-PROJECTION-001
  - BWA-TAX-ESTIMATE-001
tags:
  - bwa
  - datev
  - addison
  - import
  - mapping
---

# BWA-IMPORT-MAPPING-001 — DATEV- und Addison-BWA nur anhand bekannter Strukturen importieren

## Kurzfassung

TaxTronik liest strukturierte DATEV-BWA aus XLSX und Addison-BWA aus
Semikolon-CSV ein. Perioden und Kennzahlen entstehen nur aus den im Parser
bekannten Spalten-, Zeilen- und Positionsmustern. Ein erfolgreicher Import
belegt weder die Vollständigkeit der Quelldatei noch die richtige fachliche
Zuordnung oder Vorzeichenlogik.

## Wann gilt die Regel?

Die Regel gilt für die beiden ausdrücklich unterstützten Importfamilien und
deren im Code beschriebenen Varianten. Sie gilt nicht für beliebige Excel-
oder CSV-Dateien, Kontennachweise, Buchungsstapel, individuelle
Kontenrahmenauswertungen oder eine direkte DATEV-/Addison-Synchronisation.
Umbenannte Zeilen, abweichende Exportlayouts und kanzleispezifische
Auswertungsschemata müssen vor Übernahme geprüft werden.

## Benötigte Angaben

- Quellsystem und konkrete Exportart
- unveränderte strukturierte Quelldatei
- Mandant und auszuwertender Zeitraum
- verwendetes BWA-Schema und erwartete Positionsnummern
- erwartete Vorzeichen und Kontrollsummen
- bei zweistelligen Jahresangaben das tatsächlich gemeinte Jahrhundert

## Entscheidungslogik

| Wenn                                                                                                     | Dann                                                                                         | Begründung                                                                             |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| eine DATEV-XLSX enthält in den ersten zehn Zeilen eine Spalte `Zeile` und erkennbare Datumsüberschriften | numerisch nummerierte Hauptpositionen je erkannter Periode importieren                       | der Parser bindet an dieses strukturierte Layout                                       |
| eine DATEV-Zelle keinen sicher lesbaren Betrag enthält                                                   | den einzelnen Wert auslassen und gegebenenfalls eine Warnung liefern                         | ein unlesbarer Wert darf nicht erfunden werden                                         |
| eine Addison-CSV enthält ein bekanntes Periodenformat und numerische Positionsnummern                    | Positionen in die erkannte Monats-, Quartals- oder Jahresperiode übernehmen                  | nur die bekannten Strukturmerkmale sind automatisiert                                  |
| der kompakte Addison-Parser ausdrücklich verwendet wird                                                  | normalisierte Bezeichnungen auf die fest hinterlegte kleine Positionsliste abbilden          | die Zuordnung ist eine Produktkonvention, keine allgemeine Kontenrahmenlogik           |
| Umsatz, Ergebnis oder Personalaufwand auf bekannte DATEV-/Addison-Positionen passen                      | daraus die unterstützten BWA-Kennzahlen ableiten                                             | die Kennzahlabbildung ist positionsbasiert                                             |
| DATEV 1020 beziehungsweise 1345 fehlt                                                                    | Umsatz beziehungsweise Ergebnis vor Steuern `null` lassen                                    | Gesamtleistung 1051 und Betriebsergebnis 1300 sind keine gleichbedeutenden Ersatzwerte |
| DATEV 1060 und 1280 vorliegen                                                                            | betriebliche Aufwendungen als Summe beider Positionen ermitteln                              | Material-/Wareneinkauf steht außerhalb der Kostenartensumme                            |
| direkte Kostenbasis fehlt, aber 1051, 1090 und 1300 vollständig vorliegen                                | Kosten als Gesamtleistung plus sonstige betriebliche Erlöse minus Betriebsergebnis ermitteln | diese Überleitung verwendet alle benannten Bestandteile                                |
| vollständige und mit den Planachsen centgenau abstimmbare Basis vorliegt                                 | echte Einzelachsen zur manuellen Prüfung vorbelegen                                          | keine rechnerische Restgröße als angebliche Ertragsquelle etikettieren                 |
| Header, Zeitraum oder Werte fehlen                                                                       | Import mit Warnung oder ohne Perioden beenden                                                | unvollständige Struktur wird nicht durch Schätzwerte ergänzt                           |
| Quelllayout oder fachliche Bedeutung weicht ab                                                           | nicht ungeprüft weiterrechnen; manuell zuordnen oder Import verwerfen                        | Parsererfolg ersetzt keine Plausibilitätskontrolle                                     |

## Ausnahmen und Grenzfälle

Der DATEV-Parser berücksichtigt Hauptpositionszeilen, nicht die darunter
stehenden Kontendetails. Beim Addison-Import werden zweistellige Jahre unter
70 als 20xx und ab 70 als 19xx interpretiert. Nicht erkannte Addison-
Periodenbezeichnungen können als Jahresbereich eingeordnet werden, ohne dass
damit ein vollständiges Wirtschaftsjahr bewiesen ist.

Die Kennzahlabbildung nutzt feste Positionen. `revenue` verwendet DATEV 1020
**Umsatzerlöse**, `resultBeforeTax` ausschließlich DATEV 1345 **Ergebnis vor
Steuern**. Fehlt die betreffende Position, bleibt die Kennzahl unbekannt.
DATEV 1051 **Gesamtleistung** enthält zusätzlich Bestandsänderungen und
aktivierte Eigenleistungen. DATEV 1300 **Betriebsergebnis** enthält die
anschließenden neutralen Aufwendungen und Erträge noch nicht. Keine dieser
Positionen ersetzt Umsatz oder Ergebnis vor Steuern. DATEV 1380 ist das
**vorläufige Ergebnis**, nicht
allgemein ein fachlich abschließend bestimmtes „Ergebnis nach Steuern“. 1100
wird für Personalaufwand genutzt; im Addison-Pfad sind unter anderem 1990, 3250
und 3030 fest hinterlegt. Andere BWA-Schemata, individuelle Zeilen und
Kontenrahmen sind nicht automatisch abgedeckt. Nullwerte im internen
`revenue`-Feld führen bei Quoten zu `null`; Vorzeichen werden nicht fachlich
normalisiert. Die betriebliche Kostenkennzahl umfasst Material-/Wareneinkauf
1060 plus Kostenarten 1280. Fehlt diese direkte Basis, ist nur die vollständige
Überleitung `1051 + 1090 − 1300` zulässig. Fehlt ein benötigter Bestandteil,
bleiben die Kosten `null`; fehlender Quelltext belegt keinen Nullbetrag.
Neutraler Aufwand ist in dieser betrieblichen Kostenkennzahl nicht enthalten.

Der einfache Cashflow-Proxy addiert zum vorläufigen Ergebnis ausschließlich
die vorhandenen Abschreibungen (DATEV 1240, Addison 3100). DATEV 1200 sind
Werbe-/Reisekosten und werden nicht als Abschreibungen addiert. Fehlt eine
Abschreibungsposition, bleiben Proxy und Monatsdurchschnitt unbekannt.

## Beispiele

### Normalfall

Eine unveränderte DATEV-XLSX enthält die Spalte `Zeile`, Monatsüberschriften
und die bekannten Hauptpositionen. TaxTronik übernimmt die lesbaren Beträge je
Monat. Der Bearbeiter gleicht anschließend Zeitraum, Gesamtleistung,
Umsatzerlöse, Betriebsergebnis, Ergebnis vor Steuern, vorläufiges Ergebnis,
Vorzeichen und Kontrollsummen mit dem Original ab.

### Grenzfall

Eine individuelle BWA verwendet für das Ergebnis vor Steuern eine andere
Position. Der Import kann andere bekannte Werte trotzdem lesen, würde diese
Position aber nicht fachlich erraten. Projektion und Steuerschätzung dürfen
erst nach manueller Zuordnung und Plausibilisierung verwendet werden.

## Umsetzung in TaxTronik

`datev-parser.ts` sucht das strukturierte DATEV-Layout, liest Periodenspalten
und importiert numerische Hauptpositionen. `addison-parser.ts` verarbeitet das
ausführliche und ein kompaktes Addison-CSV-Format. `computeBwaKpis` bildet nur
die im Code genannten Positionen auf Umsatz, Kosten, Ergebnis vor und nach
Steuern sowie Personalaufwand ab. DATEV-Gesamtleistung wird dabei nicht mehr
als Umsatzerlös und Betriebsergebnis nicht mehr als Vorsteuerergebnis verwendet.

`computeBwaPlanBasis` überträgt nur bekannte Quellachsen. Für DATEV sind das
1020, 1100, 1060 und 1240 sowie die Summe der tatsächlich vorhandenen 1090 und
1330 als sonstige Erträge. Bestandsänderungen 1040, Eigenleistungen 1045 und
neutraler Aufwand 1320 müssen ausdrücklich mit 0 vorliegen; sonst können die
bestehenden Planachsen diese Bestandteile nicht getrennt darstellen. Alle
Vorbelegungswerte müssen vorhanden sein, und Umsatz plus sonstige Erträge minus
betriebliche Kosten muss centgenau zu 1345 passen. Addison verwendet die
bestehenden Zuordnungen 1990/3150/3250/3030/3010/3100/1010, ebenfalls nur mit
vollständigen, rechnerisch passenden Werten. Eine kompakte BWA kann deshalb
weiterhin Kennzahlen liefern, ohne eine vollständige automatische Planbasis zu
liefern. Manuelle Planung bleibt möglich. Es wird weder eine fehlende Achse als
null Euro noch ein ungeklärter Unterschied als sonstiger Ertrag erfunden.

Gespeicherte Rohpositionen und bereits gespeicherte oder manuell bearbeitete
Planwerte werden nicht umgeschrieben. Kennzahlen und Projektionen bestehender
BWA werden beim Lesen neu abgeleitet und können deshalb nach der Korrektur
andere oder fehlende Werte zeigen. Frühere Planvorbelegungen müssen anhand der
Original-BWA geprüft werden; eine pauschale Bestandsmigration wäre ohne Kenntnis
manueller Anpassungen nicht verlässlich.

Der vorgeschaltete XLSX-Leser ordnet Blattnamen anhand der tatsächlichen
Workbook-Relationships den XML-Blättern zu. Die Relationship-Datei wird
ausdrücklich mit entpackt und unterliegt denselben Größenbudgets wie andere
gelesene Einträge. Damit bleiben auch vertauschte interne Blattnummern und
abweichende Blattdateinamen dem richtigen Namen zugeordnet. Fehlen die
Relationships vollständig, bleibt der bestehende konventionelle Fallback
erhalten. Der XML-Attributscanner konsumiert fehlerhafte Namen fortlaufend;
unbekannte benannte Entities bleiben Quelltext. Perioden-, Positions- und
Kennzahlabbildung ändern sich durch diese technische Lesekorrektur nicht.

Manuelle BWA-Daten (`MANUAL`) besitzen keine dokumentierte automatische Positionszuordnung. Die Planbasis bleibt daher vollständig unbekannt und kann nur manuell erfasst werden; sie wird nicht still als Addison- oder DATEV-Schema behandelt. Beide Planseiten transportieren diesen Zustand unverändert in den Assistenten.

## Bekannte Abweichungen und Grenzen

Die Umsetzung ist teilweise. Es gibt keine automatische Prüfung auf
Vollständigkeit, richtige Auswertungsart, Kontenrahmen, Saldengleichheit,
Vorzeichen, Periodenabgrenzung oder fachliche Plausibilität. Der referenzierte
Unit-Test belegt den DATEV-Pfad; der direkte Addison-Kompakt-Test prüft
bekannte Spalten, deutsche Beträge und Quartalsgrenzen anhand synthetischer
Daten. Ein gleichwertiger direkter Nachweis für die Addison-Langform fehlt.
Die zuvor dokumentierte Verwechslung von 1051 mit Umsatz und der Ersatz von
1345 durch 1300 sind technisch korrigiert. Die Positionen sind weiterhin nur
für die beschriebenen Schemata hinterlegt; andere Auswertungen und bereits
übernommene Planwerte brauchen manuelle Prüfung. Die ergänzende offizielle
DATEV-Auswertung belegt die getrennten Positionsbedeutungen, keine allgemeine
Freigabe beliebiger Kontenrahmen oder individueller BWA-Schemata.

## Fachliche Prüffragen

- Sind die fest hinterlegten DATEV- und Addison-Positionen für alle
  freigegebenen Exportvarianten zutreffend?
- Welche Kontrollsummen und Pflichtpositionen müssen einen Import sperren?
- Wie werden individuelle BWA-Schemata und abweichende Vorzeichen dokumentiert?
- Darf ein nicht erkanntes Periodenlabel überhaupt als Jahresbereich
  weiterverarbeitet werden?

## Technische Nachweise

Die Liquiditätsregression trennt abweichende Werbe-/Reisekosten von
tatsächlichen Abschreibungen und prüft, dass fehlende Abschreibungen weder
einen Nullbetrag noch einen scheinbar positiven Cashflow erzeugen. Das
Rechenmodell bleibt ein PNL-Proxy ohne Bilanz- oder Zahlungsdaten.

Der DATEV-Test belegt Header- und Datumsfindung, Hauptpositionsimport und
Warnungen für synthetische Dateien. Der zusätzliche KPI-Test trennt gezielt
unterschiedliche Umsatzerlöse/Gesamtleistung und Betriebs-/Vorsteuerergebnisse,
prüft beide Kostenwege einschließlich sonstiger betrieblicher Erlöse und
belegt fehlende versus echte Nullwerte. Er führt die Werte bis zur USt-Pauschale
sowie zur linearen und Trendprojektion weiter. Planbasistests prüfen echte
Einzelachsen, nicht darstellbare Bestandteile, fehlende Werte und Centdifferenzen.
Diese Nachweise belegen weder Vollständigkeit realer Exporte noch die fachliche
Richtigkeit eines fremden Schemas.
Der direkte Addison-Kompakt-Test hält die bekannte Spaltenzuordnung,
Quartalsgrenzen, negative deutsche Beträge, fehlende Werte und die Warnung
bei unbekannten Spalten fest. Die Aufteilung des Parsers in Hilfsfunktionen
ändert weder Zuordnungen noch Periodenregeln.

Die direkten XLSX-Regressionen verwenden kleine synthetische ZIP-Dateien mit
vertauschten Relationship-Zielen, individuellen Blattpfaden und einer
überhöhten deklarierten Entpackgröße. Der XML-Test begrenzt einen separaten
Prozess für ein langes fehlerhaftes Attribut zeitlich und prüft unbekannte
Entities einschließlich geerbter Objektnamen. Diese Nachweise betreffen die
technisch richtige Quellzuordnung, keine fachliche Freigabe des BWA-Mappings.
