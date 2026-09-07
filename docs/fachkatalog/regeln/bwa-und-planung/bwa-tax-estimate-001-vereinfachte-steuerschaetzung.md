---
id: BWA-TAX-ESTIMATE-001
title: BWA-Steuerschätzung auf eng begrenzte Annahmen beschränken
domain: bwa-und-planung
rule_type: professional_interpretation
jurisdiction: DE
validity:
  valid_from: '2025-01-01'
  valid_until: '2026-12-31'
professional_owner_role: Berufsträger Ertragsteuern und Umsatzsteuer
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    Der Produktstand bildet einzelne Tarife und Rechenschritte für 2025 und
    2026 nach, setzt aber das BWA-Ergebnis vereinfachend mit steuerlichen
    Bemessungsgrundlagen gleich. Persönliche Faktoren, zahlreiche
    Gewinnkorrekturen, gemischte Umsatzsteuersachverhalte und Sonderfälle
    fehlen. DATEV-Umsatzerlöse werden getrennt von Gesamtleistung verwendet;
    eine fehlende Vorsteuerposition wird nicht ersetzt und eine als nachsteuerlich
    gekennzeichnete Eingabe abgewiesen. Hinweise oder Beta-Kennzeichnung heilen
    die verbleibenden Modelllücken nicht.
sources:
  - kind: official_guidance
    citation: Amtliches Lohnsteuer-Handbuch 2025, § 32a EStG mit Tarifparametern 2025
    url: https://ksth.bundesfinanzministerium.de/lsth/2025/A-Einkommensteuergesetz/IV-Tarif-31-34b/Paragraf-32a/inhalt.html
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: § 32a EStG, Einkommensteuertarif ab Veranlagungszeitraum 2026
    url: https://www.gesetze-im-internet.de/estg/__32a.html
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: § 35 EStG, Steuerermäßigung bei Einkünften aus Gewerbebetrieb
    url: https://www.gesetze-im-internet.de/estg/__35.html
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: § 4 Abs. 5b EStG, Gewerbesteuer ist keine Betriebsausgabe
    url: https://www.gesetze-im-internet.de/estg/__4.html
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: §§ 2, 7 und 11 GewStG, Steuergegenstand, Gewerbeertrag und Messbetrag
    url: https://www.gesetze-im-internet.de/gewstg/
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: § 23 KStG, Körperschaftsteuersatz nach Veranlagungszeitraum
    url: https://www.gesetze-im-internet.de/kstg_1977/__23.html
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: §§ 3 und 4 SolzG 1995, Bemessungsgrundlage und Zuschlagsatz
    url: https://www.gesetze-im-internet.de/solzg_1995/
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: §§ 12 und 15 UStG, Steuersätze und Vorsteuerabzug
    url: https://www.gesetze-im-internet.de/ustg_1980/
    checked_at: '2026-08-24'
    primary: true
  - kind: technical_standard
    citation: DATEV-Musterauswertung Planungsrechnung, Planungscockpit BWA 01 Kurzform, Umsatzerlöse 1020, Gesamtleistung 1051 und Ergebnis vor Steuern 1345
    url: https://www.datev.de/dnlexom/v2/content/files/st13860276747_de.pdf
    checked_at: '2026-08-24'
    primary: false
  - kind: product_documentation
    citation: Anwenderdokumentation BWA und Planung, fachliche Grenzen der Planung
    path: docs/anwenderdoku/bwa-planung.md
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/app/staff/(protected)/clients/[id]/bwa/[periodId]/page.tsx
  - apps/web/src/server/bwa/tax-estimator.ts
  - apps/web/src/server/bwa/addison-parser.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/bwa/[periodId]/tax-estimator-card.tsx
test_refs:
  - apps/web/src/components/bwa/__tests__/tax-basis.test.tsx
  - apps/e2e/tests/21-bwa-basis-state.spec.ts
  - apps/web/src/server/bwa/__tests__/tax-estimator.test.ts
  - apps/web/src/server/bwa/__tests__/kpis.test.ts
feature_refs:
  - docs/anwenderdoku/bwa-planung.md
related_rules:
  - BWA-IMPORT-MAPPING-001
  - BWA-PROJECTION-001
tags:
  - bwa
  - steuerschaetzung
  - einkommensteuer
  - koerperschaftsteuer
  - gewerbesteuer
  - umsatzsteuer
---

# BWA-TAX-ESTIMATE-001 — BWA-Steuerschätzung auf eng begrenzte Annahmen beschränken

## Kurzfassung

TaxTronik berechnet eine unverbindliche Orientierung aus einem vorläufigen
BWA-Ergebnis. Einzelne gesetzliche Parameter sind für 2025 und 2026 im Code
hinterlegt; die erforderlichen steuerlichen Bemessungsgrundlagen werden aber
nicht aus einem vollständigen Steuerfall ermittelt. Deshalb ist der Stand nur
teilweise umgesetzt und ungeprüft. Ein Disclaimer, die Bezeichnung „Beta“ oder
eine plausible Zahl macht eine sachlich unvollständige Berechnung nicht
richtig.

## Wann gilt die Regel?

Der dokumentierte ESt-Teil gilt nur für die Veranlagungszeiträume 2025 und
2026 und nur für die technische Annahme eines alleinstehenden
Einzelunternehmers, dessen positives BWA-Ergebnis zugleich das gesamte zu
versteuernde Einkommen darstellt. Der KSt-/SolZ-Teil ist als grobe Rechnung
für GmbH, AG und UG angelegt. Der GewSt-Teil setzt einen inländischen
Gewerbebetrieb und einen manuell übergebenen Hebesatz voraus. Der USt-Teil
setzt vereinfachend 19 Prozent auf sämtliche Erlöse an.

Die Regel gilt nicht als Steuerberechnung, Veranlagungssimulation,
Vorauszahlungsberechnung oder fachliche Handlungsempfehlung. Negative,
gemischte, grenzüberschreitende, organschaftliche und anderweitig besondere
Sachverhalte erfordern eine gesonderte Berechnung.

## Benötigte Angaben

- Veranlagungsjahr 2025 oder 2026
- zutreffende Rechtsform und tatsächliches Steuersubjekt
- Ergebnis vor Ertragsteuern aus fachlich geprüfter BWA
- Einordnung als Gewerbebetrieb oder freiberufliche Tätigkeit
- kommunaler Gewerbesteuer-Hebesatz
- Erlöse, abziehbare Vorsteuer und bereits geleistete Umsatzsteuer
- vollständige persönliche Verhältnisse und weitere Einkünfte für jede echte
  Einkommensteuerberechnung
- steuerliche Gewinnkorrekturen, Verluste, Hinzurechnungen und Kürzungen

## Entscheidungslogik

| Wenn                                                                             | Dann                                                                                                                                      | Begründung                                                                                                          |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Jahr 2025 oder 2026 und Einzelunternehmen                                        | hinterlegten Grundtarif auf das abgerundete positive BWA-Ergebnis anwenden                                                                | technische Annahme eines alleinstehenden Steuerpflichtigen ohne weitere Faktoren                                    |
| anderes ESt-Jahr                                                                 | Einkommensteuer `null` lassen und fehlenden verifizierten Tarif anzeigen                                                                  | ein alter Tarif darf nicht still fortgeschrieben werden                                                             |
| gewerbliche Tätigkeit                                                            | positives Ergebnis auf volle 100 Euro abrunden, gegebenenfalls 24.500 Euro Freibetrag abziehen und mit 3,5 Prozent sowie Hebesatz rechnen | vereinfachte Abbildung von § 11 GewStG                                                                              |
| Einzelunternehmen mit positiver Gewerbesteuer                                    | ESt technisch um höchstens das Vierfache des Messbetrags, die berechnete GewSt und die tarifliche ESt mindern                             | begrenzte Produktabbildung des § 35 EStG                                                                            |
| `isFreiberufler` gesetzt                                                         | keine Gewerbesteuer und keine §-35-Anrechnung ansetzen                                                                                    | Produktannahme für reine freiberufliche Tätigkeit                                                                   |
| GmbH, AG oder UG                                                                 | 15 Prozent des positiven BWA-Ergebnisses als KSt und 5,5 Prozent darauf als SolZ ansetzen                                                 | vereinfachte Rechnung mit den für 2025/2026 geltenden Sätzen                                                        |
| das interne Feld `revenue` ist befüllt                                           | 19 Prozent dieses Werts abzüglich übergebener Vorsteuer als USt-Saldo rechnen                                                             | Produktpauschale auf DATEV 1020 oder die bekannte Addison-Erlösposition; keine vollständige USt-Bemessungsgrundlage |
| eine Vorsteuerbasis fehlt oder die Eingabe als nachsteuerlich gekennzeichnet ist | keine Schätzung auf Ersatzbasis ausführen                                                                                                 | zuerst ein fachlich geprüftes Ergebnis vor Steuern bestimmen                                                        |

## Ausnahmen und Grenzfälle

Das BWA-Ergebnis ist regelmäßig nicht ohne Weiteres das zu versteuernde
Einkommen, das körperschaftsteuerliche Einkommen oder der Gewerbeertrag. Nicht
modelliert sind insbesondere persönliche Freibeträge und Abzüge,
Zusammenveranlagung, Kinder, Sonderausgaben, außergewöhnliche Belastungen,
weitere positive oder negative Einkünfte, Verlustverrechnung,
Progressionsvorbehalt, Tarifermäßigungen, Kirchensteuer und der
Solidaritätszuschlag auf Einkommensteuer.

Für Körperschaften fehlen unter anderem steuerliche Gewinnkorrekturen,
nichtabziehbare Aufwendungen, Beteiligungserträge, Verlustvorträge und
Organschaft. Der Code verwendet unabhängig vom Jahr 15 Prozent KSt, obwohl
§ 23 KStG nach heutigem Stand ab 2028 andere Sätze vorsieht. Für
Personengesellschaften wird keine individuelle ESt berechnet.

Bei der Gewerbesteuer fehlen die Ermittlung nach § 7 GewStG,
Hinzurechnungen und Kürzungen, Gewerbeverluste, Zerlegung, mehrere Gemeinden
und gemischte Tätigkeiten. Das Freiberufler-Flag ist eine binäre Eingabe und
keine rechtliche Tätigkeitsprüfung. Bei § 35 EStG fehlen insbesondere die
vollständige Ermittlung des Ermäßigungshöchstbetrags und die Aufteilung bei
Mitunternehmerschaften.

Die Umsatzsteuerrechnung kennt weder steuerfreie, ermäßigte oder
nullbesteuerte Umsätze noch Reverse Charge, innergemeinschaftliche Fälle,
Mischumsätze, Vorsteueraufteilung, Berichtigungen, Ist-/Sollversteuerung oder
abweichende Bemessungsgrundlagen. Fehlende Vorsteuer wird als null behandelt.
Im DATEV-Import wird ausschließlich Position 1020 **Umsatzerlöse** als
`revenue` geführt. Gesamtleistung 1051 ersetzt diese Position nicht;
Bestandsänderungen und aktivierte Eigenleistungen werden so nicht mehr
als zusätzliche Umsätze in die 19-Prozent-Pauschale eingeschleust. Fehlt 1020,
bleiben die USt-Werte mangels Basis `null`. Auch echte Umsatzerlöse sind wegen
der vorstehenden fehlenden Umsatzsteuermerkmale keine hinreichend geprüfte
Bemessungsgrundlage. USt-Salden werden nicht in `gesamt`
einbezogen; die Bezeichnung dieses Felds darf daher nicht als Gesamtsteuerlast
verstanden werden.

## Beispiele

### Normalfall

Für ein Einzelunternehmen wird für 2026 ein positives Vorsteuerergebnis,
reine gewerbliche Tätigkeit und der zutreffende Hebesatz eingegeben. Das
Produkt wendet den Grundtarif 2026, den technischen GewSt-Messbetrag und die
begrenzte §-35-Anrechnung an. Vor jeder Verwendung prüft der Berufsträger das
zvE, weitere Einkünfte, Abzüge, Hinzurechnungen, Kürzungen und Vorauszahlungen.

### Grenzfall

Eine GmbH erzielt teilweise steuerfreie Umsätze und Beteiligungserträge; die
BWA zeigt nur ein vorläufiges Ergebnis nach Steuern. Die automatische
Steuerschätzung bleibt wegen der fehlenden Vorsteuerbasis gesperrt. Selbst mit
einer vorhandenen Vorsteuerposition bilden die pauschalen Sätze weder die
KSt- noch die USt-Bemessungsgrundlage dieses Sachverhalts ab.

## Umsetzung in TaxTronik

`einkommensteuerGrundtarif` enthält die amtlichen Tarifparameter 2025 und
2026, rundet das zvE und den Steuerbetrag ab und liefert für andere Jahre
`null`. `estimateTaxes` verzweigt nach Rechtsform, verwendet positive
BWA-Ergebnisse, einen übergebenen Hebesatz, feste KSt-/SolZ-/Messzahl-Sätze
und eine 19-Prozent-USt-Pauschale auf das intern als `revenue` bezeichnete
Feld. Die Kennzahlenübergabe verwendet für DATEV 1020 und strikt 1345; ein
Betriebsergebnis 1300 ersetzt keine fehlende 1345. Die Karte zeigt bei fehlender
geeigneter Vorsteuerbasis einen Hinweis und ruft die Engine nicht mit dem
vorläufigen Ergebnis auf. Auch ein direkter Engine-Aufruf mit
`resultIsAfterTax=true` wird mit einem Eingabefehler abgewiesen. Gültige
Vorsteuer-Eingaben behalten den bestehenden Rechenweg und Resultattyp.
Andere sachlich unvollständige Eingaben werden weiterhin nicht vollständig
automatisch erkannt.

Die Steuerkarte sperrt den Aufruf bei fehlender oder ungeeigneter Vorsteuerbasis mit einem verständlichen Hinweis. Ein vorhandenes Ergebnis vor Steuern bleibt auch ohne nachsteuerliche Ergebnisposition nutzbar. Gerenderte Karten- und Browserfälle belegen fehlende Basis, echte Null und gültiges Vorsteuerergebnis; der direkte Engine-Test schützt zusätzliche Aufrufer.

## Bekannte Abweichungen und Grenzen

Die Umsetzung ist teilweise und fachlich hoch priorisiert. Die Tarifparameter
2025/2026, die Abrundung des Gewerbeertrags, der Freibetrag und einzelne
Deckelungen sind technisch getestet. Die zentrale Abweichung bleibt, dass
vorläufige BWA-Werte ohne vollständige steuerliche Überleitung als
Bemessungsgrundlagen verwendet werden. Die bekannte Nachsteuerbasis wird
inzwischen abgewiesen; eine lediglich falsch als vorsteuerlich deklarierte
Eingabe kann die Engine nicht fachlich erkennen. Unplausible Hebesätze oder
widersprüchliche Flags werden noch nicht konsequent fail-closed abgewiesen.
Die Korrektur der DATEV-Ausgangspositionen verändert keine importierten
Rohdaten oder gespeicherten Planwerte. Vor einer produktiven fachlichen Freigabe sind
Eingaben, Überleitungen, Gültigkeitsjahre und Sonderfälle neu zu entscheiden.

## Fachliche Prüffragen

- Soll die Funktion bis zu einer vollständigen steuerlichen Überleitung nur
  interne Testszenarien zulassen?
- Welche Mindestangaben müssen für ESt, KSt, GewSt, SolZ und USt jeweils
  vorhanden sein, bevor überhaupt eine Zahl gezeigt wird?
- Welche zusätzlichen Belege sind für eine als vorsteuerlich deklarierte
  Eingabe erforderlich?
- Wie werden Tarif- und Rechtsänderungen jahrgangsbezogen freigegeben und
  abgelaufene Jahre gesperrt?
- Welche Plausibilitätsgrenzen gelten für Hebesatz, Rechtsform und
  Freiberufler-Einordnung?

## Technische Nachweise

Der Test belegt die hinterlegten ESt-Tarife 2025/2026, das Auslassen eines
unbekannten ESt-Jahrs, die GewSt-Abrundung, den Freibetrag, eine begrenzte
§-35-Anrechnung und das Freiberufler-Flag anhand synthetischer Fälle. Er
belegt keine vollständige steuerliche Bemessungsgrundlage, keine persönliche
Veranlagung, keine KSt-/USt-Sonderfälle und keine fachliche Richtigkeit einer
realen Schätzung.

Die zusätzlichen Regressionen belegen die Ablehnung einer ausdrücklich
nachsteuerlichen Engine-Eingabe und die Übernahme von DATEV-Umsatzerlösen
anstelle von Gesamtleistung in die USt-Pauschale. Fehlende 1345 liefert auch
in beiden Projektionsstrategien keine Ergebnis- oder Steuerersatzachse.
Diese Positions- und Eingabekorrektur ist keine Freigabe der verbleibenden
steuerlichen Vereinfachungen.
