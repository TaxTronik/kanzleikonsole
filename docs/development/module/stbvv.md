# StBVV-Katalog und Gebührenkalkulation

Fachregel: **STBVV-CALCULATION-001**, fachlich **unreviewed**, Modul
`feeCalculator` standardmäßig aus. Rechtsstand:
`STBVV-2026-08-31/TABLES-2025-07-01`.

Die aktuelle [amtlich bereitgestellte konsolidierte StBVV](https://www.gesetze-im-internet.de/stbgebv/BJNR014420981.html)
nennt als letzte Änderung Art. 5 der Verordnung vom 19.12.2025 (BGBl. 2025 I
Nr. 372). Die Gebührenwerte der Tabellen stammen aus BGBl. 2025 I Nr. 105.
Abruf und Abgleich erfolgten am 31.08.2026; keine Einzelbeträge wurden geschätzt.

## Vollständigkeit und bewusste Grenze

Der Katalog umfasst alle aktuellen Gebührenpositionen der §§ 21–39 mit
Untertatbeständen sowie explizite Einträge für § 2, § 4, § 13 und die RVG-Verweise.
Er ist in `packages/tax/src/stbvv/catalog.ts` mit Vorschrift, Quellenlink,
Gebührenart, Tabelle, Rahmen, Nenner, Mindestwert, Wertumrechnung und Eingabehinweis
vollständig enumeriert. Aufgehobene Positionen werden nicht als Gebühr angeboten.

| Bereich          | Umfang und Rechenweg                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| § 21             | Rat/Auskunft A, Verbraucher-Erstgespräch 190-Euro-Grenze, ausdrücklich gewählte Beratungsanrechnung; Abs. 2 RVG-Fremdberechnung                           |
| § 22             | Gutachten/verbindliche Auskunft A, nur eine Position desselben Gegenstands                                                                                |
| § 23             | Alle zehn Einzelanträge A; Kassenmitteilung erstes/weiteres System, reine Abmeldung einmal                                                                |
| § 24             | Alle aktiven Nummern 1–26 einschließlich 11a; Mindeststeuererklärung und Berichtsanrechnung; Zugewinn, Lohnsteuerermäßigung und alle acht Zeitgebührfälle |
| §§ 25–27         | EÜR, Durchschnittssatzgewinn, Überschusseinkünfte, jeweils einschlägige Vorarbeiten/Berichte                                                              |
| §§ 28–32         | Bescheidprüfung, Prüfung/Nachschau, Einwendungen, Selbstanzeige, Besprechung, Buchführungseinrichtung                                                     |
| §§ 33–34         | Alle Buchführungs- und Lohngebühren, Monats-/Personen-/Zeitraumeinheiten, sonstige Zeitgebühren und Abgeltung von USt-/LSt-Anmeldungen                    |
| § 35             | Alle aktiven Abschluss-, Anhang-, Ableitungs-, Eröffnungs-, Auseinandersetzungs-, Mitwirkungs- und Berichtspositionen; zusätzliche Vorarbeiten            |
| §§ 36–38         | Prüfungen einschließlich kombinierter Wert-/Zeitgebühr, Status aus eigenen/übergebenen Zahlen, Berichte, Bescheinigungen und Mitwirkung                   |
| § 39             | Alle vier laufenden, sechs Abschluss- und zwei Einrichtungs-/Anfangswertfälle; D a+b oder nur D a, Halbierung des Umsatzmehrbetrags beim Abschluss        |
| §§ 2, 4          | Begründete manuelle Analogie bzw. Vergütungsvereinbarung als ausdrücklicher Fremdbetrag                                                                   |
| §§ 21 Abs. 2, 40 | Sichtbare RVG-Verweise mit extern ermitteltem Betrag und Pflichtbegründung; keine Nutzung einer StBVV-Tabelle als Ersatz                                  |
| §§ 15–20         | Einheitliche 19/0-%-USt, Postpauschale/tatsächlich, enger VV-7000-Dokumentenverweis, Fahrt-/Abwesenheitsgeld, tatsächliche Auslagen                       |

**Vollständiger Katalog bedeutet nicht vollständige automatische Rechtsprüfung.**
Das Programm entscheidet weder über das Entstehen einer Gebühr noch über die
Angemessenheit des gewählten Satzes. Gegenstandswertbesonderheiten, gleiche
Angelegenheit/Teilgegenstände, Voraufträge, bereits entstandene Gebühren,
Vorschüsse, Verteilung von Reisekosten und Vereinbarungen sind durch den
Bearbeiter zu bestimmen und zu dokumentieren. Eine Bestätigung in der Oberfläche
ist keine Freigabe im Fachkatalog.

Die Berechnungsgrundlagen bei § 35, Grundsteuer-Messbetrag/Messzahl und die
gewichtete landwirtschaftliche Betriebsfläche werden ausdrücklich bereits
fachlich ermittelt eingegeben. `closingValue` stellt für § 35 zusätzlich einen
getesteten Hilfsrechner bereit; die überlappende 3.000-Euro-Ausnahme wird abgewiesen
und nicht durch erfundene Vorrangregeln entschieden. Es gibt keinen automatischen
Datenabruf aus Finanzbuchhaltung, Flächenkataster oder Mandantenstammdaten.

## Tabellen, Geld und Aktualisierung

`tables.json` enthält 277 unverändert aus den amtlichen HTML-Anlagen ausgelesene
numerische Tabellenzeilen: A 49, B 61, C 23, D a 59, D b 85. Dazu sind
Quelladressen, Rohdaten-SHA-256 und Abrufdatum gespeichert.
`scripts/import-stbvv-tables.py` ist ein explizites Wartungswerkzeug, kein
automatischer Aktualisierungsjob. Änderungen erfordern Quellenprüfung, neue
Versionskennung, Tests, Fachregel und dokumentierte berufliche Freigabe.

Die Rechenfunktion behandelt die „bis“-Grenzen einschließlich, berechnet die
gestaffelte Mehrbetragsfortschreibung und unterscheidet Zehntel und Zwanzigstel.
D a rechnet zusätzliche Hektar proportional, die ausdrücklich angefangenen
Wertstufen der anderen Tabellen werden aufgerundet. Gebühren werden in Cent
gespeichert; die USt wird einmal auf die Gesamtnettogruppe gerundet.
Negative Körperschaftsteuer-Einkommen und Gewerbeerträge werden auf den jeweiligen
Mindestgegenstandswert angehoben. Bei Mindeststeuergewinnen/-verlusten wird der
absolute Betrag vor Anwendung des 1-%-Anteils verwendet. Die übrigen Wertgrundlagen
werden ausdrücklich nicht durch pauschale Betragsbildung umgedeutet.

§ 13: 16,50–41 Euro je angefangene Viertelstunde, nur zulässige Zeitgebührfälle.
§ 23 kann nicht durch einen angeblich fehlenden Gegenstandswert zur Zeitgebühr
umgedeutet werden. Mehrere Auftraggeber erzeugen keinen automatischen RVG-Zuschlag.

## Bedienung und Nachweise

- `/staff/stbvv`: vollständiger Katalog mit Auswahl eines zugänglichen Mandats,
  beliebig kombinierbaren Gebührenpositionen und Auslagen, Berechnungsspur und
  JSON-Download der aktuellen Kalkulation.
- `/staff/clients/[id]/stbvv`: neue Kalkulationen sowie letzte 50 gespeicherte
  unveränderliche Nachweise mit Eingaben, Ergebnissen, Rechtsstand und Bearbeiter.
- `INVOICE_MANAGE` ist für Speichern und Übernahme nötig. Nur im Rechnungsmodus
  `IN_APP` entsteht ein **neuer DRAFT im Format XRECHNUNG**; keinerlei
  automatischer Versand. Das reine Format `PDF` ist für externe Uploads
  vorgesehen und würde ohne hochgeladenes Dokument den Versand blockieren.
  Erneute Übernahme repariert einen bereits verknüpften alten `PDF`-Entwurf
  ausschließlich bei `DRAFT`, fehlendem Versandzeitpunkt und ohne PDF-/XML-
  Dokumentzeiger. Archiv-Lock, bedingtes Update und Audit sichern diesen
  idempotenten Pfad; Nummer, Beträge und Kalkulationsnachweis bleiben bestehen.
  Alte generierte Pfeil-Rechenspuren werden dabei nur in Positionen ersetzt,
  deren vollständiger Text exakt dem gespeicherten Kalkulationsnachweis
  entspricht. Abweichende manuelle Texte werden nicht umgeschrieben.
- Advisory-Lock und eindeutiger Übernahmenachweis machen wiederholtes Übernehmen
  derselben Kalkulation idempotent. Festgeschriebene Rechnungen werden nicht
  geändert. Die Rechnung verwendet den bestehenden Nummernkreis und
  `computeVatTotals` gemäß **INV-VAT-TOTALS-001**.
- Vor Versand sind Leistungszeitraum, alle fachlichen Voraussetzungen, ggf.
  Vorschüsse und weitere Rechnungsangaben im normalen Rechnungsworkflow zu prüfen.

§ 41 muss vor jeder neuen Kalkulation ausdrücklich geprüft werden. Historische
Rechtsstände sind nicht geladen; ein künftiger Datenkatalog darf gespeicherte
Nachweise niemals still neu berechnen. Ein vollständiger RVG-/GKG-Rechner,
Prozesskostenermittlung, Erfolgshonorare, automatische Gebührenanspruchsprüfung
und automatisch rechtssichere Honorarvereinbarungen sind nicht enthalten.
Dokumentenpauschalen nach [VV 7000 RVG](https://www.gesetze-im-internet.de/rvg/anlage_1.html)
sind der einzige automatisch berechnete RVG-Verweis. Berechtigte Seiten und
elektronische Überlassungen, einschließlich der §-17-Voraussetzungen und etwaiger
100-Seiten-Grenzen, sind fachlich vorab zu bestimmen.

## Technische Validierung und Betriebsgrenzen

`packages/tax/src/stbvv/calculator.test.ts` prüft sämtliche importierten Grenzen,
unabhängige Kontrollwerte der Fortschreibung, den aktiven §-24-Bestand und einen
ausführbaren Pfad jedes Katalogeintrags. Hinzu kommen Mindestwerte, /20,
Beratungskappung, Anrechnung, Abgeltung, D-Kombination, §-35-Grenzfälle, Zeit,
Auslagen und USt-Rundung. Tests ersetzen keine Fachfreigabe.

`server/invoicing/__tests__/archive.test.ts` führt gemäß
**STBVV-CALCULATION-001** eine tatsächliche Kalkulationsübernahme durch die
Archiv-Orchestrierung bis zur Verknüpfung von XML und PDF. Datenbank, Storage
und PDF-Erzeugung sind dabei Test-Doubles; ein vollständiger produktiver
Versand ist dadurch nicht nachgewiesen. Zusätzlich prüft
`server/stbvv/__tests__/service.test.ts` eine tatsächliche Zeitgebühren-
Übernahme bis zum erzeugten XML und ausgelesenen PDF-Text. Generierte Pfeile
in Rechenspuren erscheinen im Rechnungstext als „ergibt“, damit die vorhandene
PDF-Schrift sie darstellen kann; der gespeicherte Kalkulationsnachweis bleibt
unverändert. Lange Positionstexte und Quellenadressen werden anhand der
Schriftbreite ohne Abschneiden umgebrochen. Ausgestellte Rechnungen und
Rechnungen mit vorhandenen Archivzeigern werden nicht geändert.

Tabellen `stbvv_quote` und `stbvv_quote_export` sind append-only, durch Tenant-RLS
und Mandantenzugriff geschützt. INSERT auf Kalkulation und Übernahme verlangt
auch auf SQL-Ebene die aktuelle Rechnungsberechtigung. Die neuen Nachweise benötigen
vor produktiver Aktivierung ein freigegebenes Aufbewahrungs-/Löschkonzept; sie sind bislang nicht
in den automatischen allgemeinen Löschlauf integriert. Es wurde keine
Migration auf einer produktiven Installation ausgeführt.
