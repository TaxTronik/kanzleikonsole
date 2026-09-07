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
    nicht abschließend automatisch festgestellt; zudem bezeichnet das interne
    Mapping DATEV-Gesamtleistung und einen Betriebsergebnis-Fallback zu weit.
sources:
  - kind: technical_standard
    citation: DATEV-Musterauswertung Planungsrechnung, Planungscockpit BWA 01 Kurzform, Positionen 1051, 1300, 1345 und 1380
    url: https://www.datev.de/dnlexom/v2/content/files/st13860276747_de.pdf
    checked_at: '2026-08-24'
    primary: false
  - kind: product_documentation
    citation: Anwenderdokumentation BWA und Planung, Abschnitt Import und Prüfpflichten
    path: docs/anwenderdoku/bwa-planung.md
    checked_at: '2026-08-24'
    primary: true
code_refs:
  - apps/web/src/server/bwa/datev-parser.ts
  - apps/web/src/server/bwa/addison-parser.ts
  - apps/web/src/lib/xlsx/read-xlsx.ts
  - apps/web/src/lib/xlsx/xml.ts
test_refs:
  - apps/web/src/server/bwa/__tests__/datev-parser.test.ts
  - apps/web/src/server/bwa/__tests__/addison-parser.test.ts
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

| Wenn                                                                                                     | Dann                                                                                | Begründung                                                                   |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| eine DATEV-XLSX enthält in den ersten zehn Zeilen eine Spalte `Zeile` und erkennbare Datumsüberschriften | numerisch nummerierte Hauptpositionen je erkannter Periode importieren              | der Parser bindet an dieses strukturierte Layout                             |
| eine DATEV-Zelle keinen sicher lesbaren Betrag enthält                                                   | den einzelnen Wert auslassen und gegebenenfalls eine Warnung liefern                | ein unlesbarer Wert darf nicht erfunden werden                               |
| eine Addison-CSV enthält ein bekanntes Periodenformat und numerische Positionsnummern                    | Positionen in die erkannte Monats-, Quartals- oder Jahresperiode übernehmen         | nur die bekannten Strukturmerkmale sind automatisiert                        |
| der kompakte Addison-Parser ausdrücklich verwendet wird                                                  | normalisierte Bezeichnungen auf die fest hinterlegte kleine Positionsliste abbilden | die Zuordnung ist eine Produktkonvention, keine allgemeine Kontenrahmenlogik |
| Umsatz, Ergebnis oder Personalaufwand auf bekannte DATEV-/Addison-Positionen passen                      | daraus die unterstützten BWA-Kennzahlen ableiten                                    | die Kennzahlabbildung ist positionsbasiert                                   |
| Header, Zeitraum oder Werte fehlen                                                                       | Import mit Warnung oder ohne Perioden beenden                                       | unvollständige Struktur wird nicht durch Schätzwerte ergänzt                 |
| Quelllayout oder fachliche Bedeutung weicht ab                                                           | nicht ungeprüft weiterrechnen; manuell zuordnen oder Import verwerfen               | Parsererfolg ersetzt keine Plausibilitätskontrolle                           |

## Ausnahmen und Grenzfälle

Der DATEV-Parser berücksichtigt Hauptpositionszeilen, nicht die darunter
stehenden Kontendetails. Beim Addison-Import werden zweistellige Jahre unter
70 als 20xx und ab 70 als 19xx interpretiert. Nicht erkannte Addison-
Periodenbezeichnungen können als Jahresbereich eingeordnet werden, ohne dass
damit ein vollständiges Wirtschaftsjahr bewiesen ist.

Die Kennzahlabbildung nutzt feste Positionen. Dabei speichert der aktuelle Code
DATEV 1051 **Gesamtleistung** im internen Feld `revenue`; diese Position ist
nicht mit Umsatzerlösen gleichzusetzen. Für `resultBeforeTax` wird zunächst
DATEV 1345 **Ergebnis vor Steuern**, ersatzweise aber DATEV 1300
**Betriebsergebnis** verwendet. DATEV 1380 ist das **vorläufige Ergebnis**, nicht
allgemein ein fachlich abschließend bestimmtes „Ergebnis nach Steuern“. 1100
wird für Personalaufwand genutzt; im Addison-Pfad sind unter anderem 1990, 3250
und 3030 fest hinterlegt. Andere BWA-Schemata, individuelle Zeilen und
Kontenrahmen sind nicht automatisch abgedeckt. Nullwerte im internen
`revenue`-Feld führen bei Quoten zu `null`; Vorzeichen werden nicht fachlich
normalisiert.

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
Steuern sowie Personalaufwand ab.

Der vorgeschaltete XLSX-Leser ordnet Blattnamen anhand der tatsächlichen
Workbook-Relationships den XML-Blättern zu. Die Relationship-Datei wird
ausdrücklich mit entpackt und unterliegt denselben Größenbudgets wie andere
gelesene Einträge. Damit bleiben auch vertauschte interne Blattnummern und
abweichende Blattdateinamen dem richtigen Namen zugeordnet. Fehlen die
Relationships vollständig, bleibt der bestehende konventionelle Fallback
erhalten. Der XML-Attributscanner konsumiert fehlerhafte Namen fortlaufend;
unbekannte benannte Entities bleiben Quelltext. Perioden-, Positions- und
Kennzahlabbildung ändern sich durch diese technische Lesekorrektur nicht.

## Bekannte Abweichungen und Grenzen

Die Umsetzung ist teilweise. Es gibt keine automatische Prüfung auf
Vollständigkeit, richtige Auswertungsart, Kontenrahmen, Saldengleichheit,
Vorzeichen, Periodenabgrenzung oder fachliche Plausibilität. Der referenzierte
Unit-Test belegt den DATEV-Pfad; der direkte Addison-Kompakt-Test prüft
bekannte Spalten, deutsche Beträge und Quartalsgrenzen anhand synthetischer
Daten. Ein gleichwertiger direkter Nachweis für die Addison-Langform fehlt.
Zusätzlich sind
die internen Feldnamen beziehungsweise Fallbacks fachlich zu weit: 1051 wird
als `revenue` und 1300 ersatzweise als `resultBeforeTax` behandelt. Manuelle
Prüfung ist daher auch bei technisch erfolgreichem Import erforderlich.

## Fachliche Prüffragen

- Sind die fest hinterlegten DATEV- und Addison-Positionen für alle
  freigegebenen Exportvarianten zutreffend?
- Welche Kontrollsummen und Pflichtpositionen müssen einen Import sperren?
- Wie werden individuelle BWA-Schemata und abweichende Vorzeichen dokumentiert?
- Darf ein nicht erkanntes Periodenlabel überhaupt als Jahresbereich
  weiterverarbeitet werden?

## Technische Nachweise

Der DATEV-Test belegt Header- und Datumsfindung, Hauptpositionsimport und
Warnungen für synthetische Dateien. Er prüft weder die fachliche Trennung der
Ergebnispositionen noch Vollständigkeit realer Exporte oder
die fachliche Richtigkeit eines fremden Schemas.
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
