---
id: INV-STORNO-REFERENCE-001
title: Ausgestellte In-App-Rechnungen durch referenzierten Korrekturbeleg stornieren
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
  summary: Für ausgelieferte In-App-Rechnungen erzeugt TaxTronik einen nummerierten negativen Korrekturbeleg mit TypeCode 384 und Referenz auf das Original; bestehende ausgestellte Archivfassungen bleiben unverändert.
sources:
  - kind: official_guidance
    citation: E-Rechnung in der Bundesverwaltung, FAQ zu Gutschriften und Rechnungskorrekturen; BT-3 384 für Korrektur und Storno
    url: https://e-rechnung-bund.de/faq/wie-sind-gutschriften-und-rechnungskorrekturen-anzugeben/
    checked_at: '2026-09-06'
    primary: true
  - kind: official_law
    citation: § 17 UStG, Berichtigung bei Änderung der Bemessungsgrundlage und Rückgängigmachung
    url: https://www.gesetze-im-internet.de/ustg_1980/__17.html
    checked_at: '2026-08-24'
    primary: true
  - kind: technical_standard
    citation: KoSIT, Spezifikation XRechnung 3.0.2, vorausgehende Rechnungsreferenz und Rechnungsberichtigungen
    url: https://xeinkauf.de/app/uploads/2024/07/XRechnung-v3.0.2.pdf
    checked_at: '2026-08-24'
    primary: false
  - kind: product_documentation
    citation: Technische Modulbeschreibung Fakturierung, Korrekturbeleg und bekannte Grenzen
    path: docs/development/module/fakturierung.md
    checked_at: '2026-08-24'
    primary: true
code_refs:
  - apps/web/src/server/invoicing/storno.ts
  - apps/web/src/server/invoicing/xrechnung.ts
  - apps/web/src/server/invoicing/sample-fixture.ts
  - apps/web/src/app/staff/(protected)/invoices/actions.ts
test_refs:
  - apps/web/src/server/invoicing/__tests__/storno.test.ts
  - apps/web/src/server/invoicing/__tests__/xrechnung.test.ts
  - apps/web/src/server/invoicing/__tests__/archive.test.ts
feature_refs:
  - docs/development/module/fakturierung.md
  - docs/anwenderdoku/rechnungen.md
  - docs/adr/0008-xrechnung-zugferd-en16931.md
related_rules:
  - INV-NUMBER-ALLOCATION-001
  - INV-LIFECYCLE-FREEZE-001
  - INV-ARCHIVE-EINVOICE-001
tags:
  - rechnung
  - storno
  - korrekturbeleg
  - xrechnung
---

# INV-STORNO-REFERENCE-001 — Ausgestellte In-App-Rechnungen durch referenzierten Korrekturbeleg stornieren

## Kurzfassung

Eine bereits ausgelieferte In-App-Rechnung wird nicht inhaltlich geändert.
TaxTronik erzeugt stattdessen einen neuen Korrekturbeleg mit eigener Nummer,
invertierten Positions- und Gesamtbeträgen, XRechnung-TypeCode `384` und
Referenz auf die ursprüngliche Rechnungsnummer. Erst wenn der Korrekturbeleg
archiviert und auf `SENT` festgeschrieben ist, wird das Original atomar auf
`CANCELLED` gesetzt.

## Wann gilt die Regel?

Die Regel gilt für versendete, überfällige oder bezahlte In-App-Rechnungen in
den Formaten XRechnung oder ZUGFeRD. Ein noch nicht ausgelieferter Entwurf kann
ohne Korrekturbeleg abgebrochen werden. Externe PDF-Rechnungen müssen im
führenden Fremdsystem korrigiert werden.

## Benötigte Angaben

- ursprüngliche Rechnung und unveränderte Positionen
- aktueller Status des Originals
- neue Korrekturbelegnummer und Korrekturdatum
- Referenz auf ID und Nummer des Originals
- ursprüngliche Steuermerkmale und Leistungszeitraum
- Archivierungs- und Versandstatus des Korrekturbelegs
- Information, ob das Original bereits bezahlt war

## Entscheidungslogik

| Ausgangslage                                   | Ergebnis                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Original ist noch nicht ausgelieferter Entwurf | Entwurf abbrechen; keinen ausgestellten Korrekturbeleg erzeugen                                      |
| Original ist ausgelieferte In-App-Rechnung     | genau einen Korrekturbeleg-Entwurf mit neuer Nummer erzeugen                                         |
| reguläre positive Originalposition             | Menge negieren, Preis positiv lassen und Nettobetrag invertieren                                     |
| negative Vollkorrektur wird als CII ausgegeben | TypeCode `384` mit Vorgängerreferenz verwenden; keine zusätzliche Gutschriftwirkung durch `381`      |
| Altposition hat negativen Einzelpreis          | Preis positiv normalisieren und Mengenzeichen so wählen, dass der Zeilenbetrag exakt invertiert wird |
| Korrekturarchiv oder Festschreibung scheitert  | Original aktiv lassen; Korrekturentwurf erneut bearbeitbar lassen                                    |
| Korrekturbeleg ist erfolgreich `SENT`          | Original in derselben Transaktion auf `CANCELLED` setzen                                             |
| Original war bezahlt                           | Rückzahlungsbedarf dokumentieren; keinen automatischen Zahlungsfluss ausführen                       |
| Original ist externe PDF                       | Korrektur in TaxTronik ablehnen und Fremdsystemprozess verlangen                                     |

## Ausnahmen und Grenzfälle

Ein partieller Unique-Index erlaubt höchstens einen Korrekturbeleg je Original.
Parallele Anlegeversuche verwenden den bereits gewonnenen Beleg. Nicht bezahlte
Zeiteinträge werden erst nach wirksamer Korrektur wieder freigegeben; bei einem
bezahlten Original bleiben sie verknüpft, weil die Rückzahlung ein getrennter
Vorgang ist.

## Beispiele

### Normalfall

Eine versendete Rechnung über 100 Euro netto und 19 Euro Steuer wird
vollständig storniert. Der Korrekturbeleg enthält eine Position mit negativer
Menge und positivem Preis, Summen von -100, -19 und -119 Euro, TypeCode 384 und
die Nummer des Originals als Vorgängerreferenz.

### Grenzfall

Die ZUGFeRD-Archivierung des Korrekturentwurfs schlägt fehl. TaxTronik setzt das
Original nicht auf `CANCELLED`; der Forderungsbestand bleibt erhalten, bis ein
Korrekturbeleg erfolgreich festgeschrieben wurde.

## Umsetzung in TaxTronik

`storno.ts` transformiert jede Originalposition mit positivem Einzelpreis und
invertiertem Zeilenbetrag. `actions.ts` serialisiert Archiv- und Statuspfade,
erzeugt den eindeutigen Korrekturentwurf und koppelt dessen erfolgreiche
Festschreibung an die Stornierung des Originals. `xrechnung.ts` bildet
Storno-Belege auf TypeCode 384 und die vorausgehende Rechnungsreferenz ab.
Dies entspricht der beschriebenen Vollkorrektur nach Kapitel 13.1 der
XRechnung 3.0.2 und der FAQ der Bundesverwaltung. Kaufmännische Gutschriften
mit TypeCode 381 sind ein anderer Belegfall und werden durch diesen
Stornoprozess nicht erzeugt.

Die frühere Kombination aus TypeCode 381 und invertierten Beträgen war auch
in dieser Regel und den Tests hinterlegt. Sie widersprach der amtlichen
Einordnung des Korrekturfalls und konnte beim Empfänger eine zusätzliche
Vorzeichenumkehr auslösen. Die Änderung betrifft neu erzeugte Fassungen;
bereits ausgestellte Archive werden nicht umgeschrieben. Vorhandene
Korrekturbelege des Altstands sind fachlich am Einzelfall zu prüfen.

## Bekannte Abweichungen und Grenzen

Die Umsetzung deckt die vollständige technische Invertierung einer
ausgelieferten In-App-Rechnung ab, nicht Teilkorrekturen, Preisnachlässe,
Retouren, mehrstufige Berichtigungen oder die materielle Berechtigung einer
Berichtigung. Rückzahlungen und Zahlungsabgleich erfolgen nicht automatisch.
Der vollständige Server-Action-Orchestrierungsfluss ist nach der
Moduldokumentation noch nicht direkt als End-to-End-Funktionstest belegt.

## Fachliche Prüffragen

- Wann ist Vollstorno statt Teilkorrektur oder berichtigter Rechnung fachlich
  richtig?
- Welche umsatzsteuerlichen Zeitpunkte und Buchungsnachweise sind bei
  Berichtigung oder Rückgängigmachung erforderlich?
- Sind Altbelege mit TypeCode 381 und negativen Beträgen beim jeweiligen
  Empfänger als beabsichtigte Korrektur verarbeitet worden?
- Wie werden Rückzahlung, Forderungsausgleich und Zeiteinträge bei bereits
  bezahlten Rechnungen behandelt?
- Welche Korrekturbelege aus Fremdsystemen müssen in TaxTronik verknüpft werden?

## Technische Nachweise

Die Storno-Unit-Tests prüfen negative Menge, positiven Preis und die
Normalisierung negativer Altpreise. XRechnungstests prüfen TypeCode 384,
Originalreferenz, positive BT-146-Preise und negative Mengen und Beträge bis
zur CII-Ausgabe aus einer Originalposition. Die gemeinsame KoSIT-Fixture
verwendet denselben Korrekturtyp. Ein Archivtest belegt, dass bereits
ausgestellte Alt-Stornos ohne Neugenerierung ausgeliefert werden. DB-Tests der
Festschreibung decken den eindeutigen Korrekturbeleg und den terminalen Status
ab; die direkte Action-Orchestrierung bleibt als Grenze dokumentiert.
