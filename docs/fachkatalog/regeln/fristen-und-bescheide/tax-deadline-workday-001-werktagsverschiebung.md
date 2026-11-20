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
  summary: >-
    Der beweisorientierte Bescheidpfad prüft Fristart und einen eigenen
    Feiertagskontext je Rechenschritt und fällt bei unvollständigem Kontext auf
    manuelle Prüfung zurück. Die allgemeine Steuertermin-Materialisierung nutzt
    weiterhin den Tenant-Standardkalender; historische, ausländische und
    automatisch bezogene kommunale Kalender sind nicht vollständig umgesetzt.
sources:
  - kind: official_law
    citation: § 108 AO
    url: https://www.gesetze-im-internet.de/ao_1977/__108.html
    checked_at: '2026-08-23'
    primary: true
  - kind: official_law
    citation: § 193 BGB
    url: https://www.gesetze-im-internet.de/bgb/__193.html
    checked_at: '2026-08-23'
    primary: false
  - kind: official_guidance
    citation: AEAO zu § 108 AO, Ausgabe 2025
    url: https://ao.bundesfinanzministerium.de/ao/2025/Abgabenordnung/Dritter-Teil/Erster-Abschnitt/Vierter-Unterabschnitt/Paragraf-108/inhalt.html
    checked_at: '2026-08-23'
    primary: false
  - kind: case_law
    citation: BFH, Beschluss vom 05.05.2014 – III B 85/13
    url: https://www.bundesfinanzhof.de/de/entscheidung/entscheidungen-online/detail/STRE201450312/
    checked_at: '2026-08-23'
    primary: false
  - kind: official_guidance
    citation: OFD Cottbus, Verfügung vom 14.01.2004 – S 0260 - 3 - St 251
    url: https://bravors.brandenburg.de/verwaltungsvorschriften/feiertagsrecht
    checked_at: '2026-08-23'
    primary: false
  - kind: official_law
    citation: Berlin, Gesetz vom 30.01.2019, Art. 1–3, GVBl. S. 22 (Frauentag und 08.05.2020)
    url: https://www.berlin.de/sen/justiz/service/gesetze-und-verordnungen/2019/ausgabe-nr-3-vom-6-2-2019-s-21-32.pdf
    checked_at: '2026-11-20'
    primary: true
  - kind: official_law
    citation: Berlin, Gesetz vom 10.07.2024, Art. 1–4, GVBl. S. 460 (08.05.2025 und 17.06.2028)
    url: https://www.berlin.de/sen/justiz/service/gesetze-und-verordnungen/2024/ausgabe-nr-28-vom-2072024-s-457-484.pdf
    checked_at: '2026-11-20'
    primary: true
  - kind: official_law
    citation: Mecklenburg-Vorpommern, Viertes Änderungsgesetz zum Feiertagsgesetz vom 07.07.2022, Art. 1 und 2, GVOBl. S. 427 (Frauentag)
    url: https://www.regierung-mv.de/static/Regierungsportal/Justizministerium/Inhalte/Rechtliches/GVOBI.M-V/GVOBl.%20Nr.%2031%20v.%2012.7.2022.pdf
    checked_at: '2026-11-20'
    primary: true
  - kind: official_law
    citation: Thüringen, Drittes Änderungsgesetz zum Thüringer Feier- und Gedenktagsgesetz vom 19.03.2019, Art. 1 und 2, GVBl. S. 22 (Weltkindertag)
    url: https://parldok.thueringer-landtag.de/ParlDok/dokument/70512/gesetz_und_verordnungsblatt_nr_2_2019.pdf
    checked_at: '2026-11-20'
    primary: true
  - kind: official_guidance
    citation: Niedersächsisches Innenministerium, einmaliger bundesweiter Feiertag am 31.10.2017
    url: https://www.mi.niedersachsen.de/startseite/aktuelles/presseinformationen/reformationstag-ist-im-jahr-2017-ein-arbeitsfreier-gesetzlicher-feiertag--148206.html
    checked_at: '2026-11-20'
    primary: true
  - kind: official_law
    citation: Bremen, Gesetz vom 26.06.2018, Art. 1 und 2, Brem.GBl. S. 302 (Reformationstag)
    url: https://www.gesetzblatt.bremen.de/fastmedia/218/2018_06_28_GBl_Nr_0063_signed.pdf
    checked_at: '2026-11-20'
    primary: true
  - kind: official_guidance
    citation: Hamburg, Übersicht über die gesetzlichen Feiertage in der Bundesrepublik Deutschland, Stand September 2018 (31. Oktober)
    url: https://www.hamburg.de/contentblob/70230/7a4a9de67fd46caec0947c11bf23316d/data/bsb-feiertage.pdf
    checked_at: '2026-11-20'
    primary: true
  - kind: official_law
    citation: Niedersachsen, Gesetz vom 22.06.2018, Art. 1 und 2, Nds. GVBl. S. 121 (Reformationstag)
    url: https://www.niedersachsen.de/download/132379/Nds._GVBl._Nr._7_2018_vom_28.06.2018_S._111-154.pdf
    checked_at: '2026-11-20'
    primary: true
  - kind: official_law
    citation: Schleswig-Holstein, Gesetz zur Änderung des Sonn- und Feiertagsgesetzes vom 21.03.2018, GVOBl. S. 69 (Reformationstag)
    url: https://www.schleswig-holstein.de/DE/landesregierung/ministerien-behoerden/IV/Service/GVOBl/GVOBl/2018/gvobl_6_2018.pdf?__blob=publicationFile&v=3
    checked_at: '2026-11-20'
    primary: true
code_refs:
  - packages/tax/src/engine.ts
  - packages/tax/src/index.ts
  - packages/tax/src/legal-assessments.ts
  - packages/tax/src/materialize.ts
  - apps/web/src/server/settings/tax-region.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/notice-assessment.ts
  - packages/db/prisma/migrations/20260823201000_tax_professional_control_model/migration.sql
test_refs:
  - packages/db/src/__tests__/tax-deadline-materialize-consistency.test.ts
  - packages/tax/src/__tests__/engine.test.ts
  - packages/tax/src/__tests__/legal-assessments.test.ts
  - packages/tax/src/__tests__/plausibility-engine.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/notices/__tests__/notice-assessment.test.ts
feature_refs:
  - FEATURES.md
  - docs/anwenderdoku/kalender-fristen-bescheide.md
related_rules:
  - TAX-NOTICE-APPEAL-001
  - TAX-NOTICE-DATARETRIEVAL-001
tags:
  - fristende
  - feiertag
  - werktag
---

# TAX-DEADLINE-WORKDAY-001 — Fristende auf den nächsten Werktag verschieben

## Kurzfassung

TaxTronik darf ein Datum nur dann nach § 108 Abs. 3 AO verschieben, wenn es
das Ende einer Frist ist und keine gesetzliche Ausnahme greift. Fällt dieses
Fristende auf einen Sonnabend, Sonntag oder einen am rechtlich maßgeblichen Ort
geltenden gesetzlichen Feiertag, endet die Frist mit Ablauf des
nächstfolgenden Werktags.

Die Regel ist keine allgemeine Verschiebelogik für jeden im Kalender als
„Termin“ oder „Fälligkeit“ bezeichneten Tag. Vorher müssen Fristart,
Rechtsgrundlage und maßgeblicher Feiertagsort feststehen.

## Wann gilt die Regel?

Die Regel gilt, wenn die fachliche Ausgangsregel ein Fristende liefert und
§ 108 Abs. 3 AO unmittelbar oder über eine besondere Regel anwendbar ist.
„Fälligkeitstermine“ können nach dem AEAO Fristenden sein; die Bezeichnung
„Termin“ entscheidet das aber nicht allein.

Vor der Verschiebung sind insbesondere die Ausnahmen zu prüfen:

- § 108 Abs. 4 AO für einen Zeitraum, in dem eine Behörde selbst eine
  Leistung zu erbringen hat,
- § 108 Abs. 5 AO für einen von einer Behörde auf einen bestimmten Tag
  gesetzten Termin und
- § 108 Abs. 6 AO für nach Stunden bestimmte Fristen.

## Benötigte Angaben

- zunächst berechnetes Fristende als reines Kalenderdatum
- Rechtsgrundlage und Fristklassifikation
- Handlungskontext zur Bestimmung des Erklärungs- oder Leistungsorts
- konkreter Empfänger, Behördensitz oder Ort der Finanzkasse, soweit
  einschlägig
- Bundesland und bei örtlichen Feiertagen die genaue Gebietseinheit
- für historische Berechnungen der damalige Feiertagsrechtsstand
- im Einzelfall bekannte örtliche oder ausländische Feiertage

## Entscheidungslogik

### 1. Anwendbarkeit vorprüfen

| Vorprüfung                                                    | Folge                                     |
| ------------------------------------------------------------- | ----------------------------------------- |
| Das Datum ist ein Fristende und § 108 Abs. 3 AO ist anwendbar | Feiertagsprüfung durchführen              |
| § 108 Abs. 4, 5 oder 6 AO ist einschlägig                     | Nicht schematisch nach Abs. 3 verschieben |
| Fristart oder Rechtsgrundlage ist unklar                      | Nur Warnung und manuelle Prüfung          |

### 2. Regelmäßig maßgeblichen Feiertagsort bestimmen

Die folgende Zuordnung gibt die amtlich veröffentlichte Verwaltungsauffassung
für Standardfälle wieder. Sie ist wegen ihres Kontexts und möglicher
Sonderregeln keine universelle Ortsregel.

| Rechenschritt                                                     | Regelmäßig maßgeblicher Ort                                                   |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Ende einer Bekanntgabefiktion nach § 122 Abs. 2 oder 2a AO        | Ort des tatsächlichen Empfängers, gegebenenfalls des Empfangsbevollmächtigten |
| Frist für eine gegenüber der Finanzbehörde vorzunehmende Handlung | Sitz der zuständigen Finanzbehörde                                            |
| Zahlungsfrist                                                     | Ort der zuständigen Finanzkasse                                               |
| Sonstige Frist                                                    | Ort nach der Ausgangsregel beziehungsweise Erklärungs- oder Leistungsort      |

Ist der Ort nicht sicher bestimmbar, darf das Tenant-Bundesland nicht
stillschweigend als rechtlich maßgeblicher Ort ausgegeben werden.

### 3. Kalenderdatum verschieben

| Wenn                                                        | Dann                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| Fristende ist Sonnabend oder Sonntag                        | Auf den nächsten berücksichtigten Werktag verschieben |
| Fristende ist am maßgeblichen Ort ein gesetzlicher Feiertag | Auf den nächsten berücksichtigten Werktag verschieben |
| Auch der Folgetag ist ein Ausschlusstag                     | Fortsetzen, bis ein Werktag erreicht ist              |
| Kein Ausschlusstag liegt vor                                | Ursprüngliches Fristende beibehalten                  |

Kanzleischließtage, Brückentage sowie der 24. oder 31. Dezember führen ohne
gesetzlichen Feiertagsstatus nicht zu einer Verschiebung.

## Ausnahmen und Grenzfälle

- Eine Empfangsvollmacht kann den für die Bekanntgabefiktion maßgeblichen Ort
  verändern.
- Bei Auslandsbekanntgaben kann ausländisches Feiertagsrecht relevant werden.
- Landes- und kommunalabhängige Feiertage dürfen nicht allein aus dem
  Kanzleisitz abgeleitet werden.
- Historische Berechnungen benötigen den damaligen Feiertagsrechtsstand.
- Spezielle Fristnormen können § 108 AO verdrängen oder verändern.

Die präzise Ortszuordnung ist eine noch ungeprüfte fachliche Interpretation
innerhalb dieser Regel und keine dokumentierte Berufsträgerfreigabe.

## Beispiele

### Einspruchsfrist

Das zunächst berechnete Ende einer Einspruchsfrist fällt auf einen gesetzlichen
Feiertag am Sitz der zuständigen Finanzbehörde. Im Standardfall wird es auf den
nächsten dortigen Werktag verschoben.

### Zwei unterschiedliche Feiertagsorte

Der vierte Tag der postalischen Bekanntgabefiktion fällt auf einen nur am Ort
des Empfangsbevollmächtigten geltenden Feiertag. Für diesen Fiktionstag ist im
Standardfall der Empfängerort maßgeblich. Das spätere Ende der
Einspruchsfrist wird dagegen am Sitz der zuständigen Finanzbehörde geprüft.

### Ausschlussfall

Die Finanzbehörde setzt für eine konkrete Mitwirkung einen bestimmten Termin
auf einen Sonnabend. Dieser wird nicht allein wegen § 108 Abs. 3 AO auf den
folgenden Montag verschoben; § 108 Abs. 5 AO ist gesondert zu prüfen.

## Umsetzung in TaxTronik

Die neue Assessment-API `assessWorkdayShift` arbeitet mit UTC-kodierten
Kalendertagen und verlangt eine maschinenlesbare Fristklassifikation. Nur
`STANDARD_DEADLINE_END` kann ein berechnetes Datum liefern. Behördeneigene
Leistungszeiträume, behördlich bestimmte Termine, Stundenfristen und unklare
Fälle liefern `MANUAL_REVIEW` und werden nicht schematisch verschoben.

Für Bescheide werden Empfängerort und Behördensitz als getrennte
Feiertagskontexte gespeichert. Ein automatisch verwendbares Ergebnis setzt
Deutschland, Bundesland, Ort/Gemeinde, einen für Datum und Ort bestätigten
Kalenderstand und in Bayern eine ausdrückliche Annahme zu Mariä Himmelfahrt
voraus. Bundes- und Landesfeiertage werden aus der Engine berechnet; zusätzlich
erfasste örtliche Feiertage werden in die Verschiebung einbezogen. Bei
unvollständigem oder ausländischem Kontext wird nur ein technischer
Kontrollwert mit Begründung gespeichert, kein scheinbar festgestelltes
Rechtsdatum. Auch ein als bestätigt markierter Kalenderkontext ohne konkret
dokumentierten Ort bleibt mit `HOLIDAY_LOCALITY_UNKNOWN` in manueller Prüfung.

Bislang wendete die Engine mehrere Landesfeiertage rückwirkend an und ließ
einmalige Feiertage aus. Der Landesstand berücksichtigt den Frauentag ab 2019
in Berlin und ab 2023 in Mecklenburg-Vorpommern sowie den Weltkindertag ab
2019 in Thüringen. Der 31. Oktober ist 2017 bundesweit und in Bremen,
Hamburg, Niedersachsen und Schleswig-Holstein ab 2018 jährlich enthalten.
Berlin berücksichtigt zusätzlich den 8. Mai 2020 und 2025 sowie den 17. Juni 2028 jeweils nur am gesetzlich bezeichneten Datum. Der 17. Juni 2028 fällt auf einen Sonnabend. Weitere historische Rechtsstände
bedürfen der fallbezogenen Prüfung.

Für Hamburg führt § 1 Nr. 8 des Feiertagsgesetzes den 31. Oktober.
Das Fünfte Änderungsgesetz vom 12. März 2018 steht im
[Hamburgischen Gesetz- und Verordnungsblatt, Seite 63](https://www.luewu.de/wp-content/uploads/2025/08/GVBL_HH_2018-9.pdf).

Daneben verwendet die allgemeine Steuertermin-Engine weiterhin
`shiftToNextWorkday` mit der Tenant-Steuerregion. Dieser Pfad kennt weder die
vorgelagerte Einordnung nach § 108 Abs. 3 bis 6 AO noch einen konkreten
Feiertagsort je Vorgang. Seine Ergebnisse bleiben Kontrollvorschläge.

Die Kandidatenanlage liest diesen Standardkalender unter demselben
tenantgebundenen Transaktions-Gate wie Schedule-Änderungen und der
Steuerregions-Writer. Eine spätere Regionsänderung datiert bestehende Termine
gemäß der ausdrücklich angezeigten Produktpolicy weiterhin nicht automatisch
neu; das Gate sichert die Reihenfolge für neu angelegte Kandidaten. Der
PostgreSQL-Parallelitätstest belegt diese technische Grenze, keine neue
fachliche Kalender- oder Ortsfreigabe.

## Bekannte Abweichungen und Grenzen

- Die eingetragenen Kalenderquelle, Orte, lokalen Feiertage und die fachliche
  Klassifikation werden nicht aus einer amtlichen, historisch versionierten
  Quelle verifiziert. Die Oberfläche erzwingt eine Beschreibung, aber keinen
  verknüpften unveränderbaren Nachweis.
- Ausländische Feiertagskalender werden nicht berechnet. Kommunale Feiertage
  werden nur berücksichtigt, wenn sie für den konkreten Vorgang eingegeben
  wurden.
- Der ältere Steuerterminpfad nutzt weiterhin die Tenant-Region als technischen
  Standard und bildet die neue beweisorientierte Vorprüfung nicht ab.
- Ein berechenbares Ergebnis ist keine fachliche Freigabe. Jeder berechtigte
  Mitarbeiter kann den Kalenderkontext erfassen; eine gesonderte
  Berufsträger- oder Vier-Augen-Freigabe ist nicht implementiert.

Der Implementierungsstatus bleibt deshalb **teilweise**.

## Fachliche Prüffragen

- Liefert jede fristerzeugende Ausgangsregel eine eindeutige Einordnung nach
  § 108 Abs. 3 bis 6 AO?
- Welche Rolle darf einen als vollständig bestätigten Feiertagskontext
  fachlich freigeben?
- Wann wird auch die Steuertermin-Materialisierung auf die beweisorientierte
  Assessment-API umgestellt?
- Welche kommunalen und ausländischen Feiertagskalender werden benötigt?
- Ab welchem Datum müssen Feiertagsstände versioniert werden?

## Technische Nachweise

`legal-assessments.ts` enthält Fristklassifikation, Fail-closed-Entscheidung und
den Feiertagskontext je Rechenschritt. Die zugehörigen Tests prüfen die
Ausnahmen nach § 108 Abs. 4 bis 6 AO, getrennte Orte, unvollständige und
historisch ungeprüfte Kontexte, lokale Feiertagsketten, Bayern und
Auslandsfälle. `engine.ts` und `materialize.ts` belegen den fortbestehenden
Tenant-Standardpfad. Nicht getestet oder implementiert sind eine amtliche
Kalenderquellen-Verifikation und eine rollenabhängige fachliche Freigabe.

Die Plausibilitätstests grenzen die genannten Rechtsänderungen nach Jahr und
Land ab und prüfen den Reformationstag 2016, 2017 und 2018 für alle
Bundesländer. Die Assessment-Tests prüfen die Vorschläge für den 8. Mai 2025
in Berlin (9. Mai) und Brandenburg (8. Mai), den 8. Mai 2020 in Berlin
(11. Mai), den 8. März 2022 in Mecklenburg-Vorpommern (8. März) und den 31. Oktober 2017 in Nordrhein-Westfalen (2. November nach Allerheiligen).
