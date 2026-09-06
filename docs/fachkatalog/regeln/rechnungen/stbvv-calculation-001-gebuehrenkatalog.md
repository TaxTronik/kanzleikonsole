---
id: STBVV-CALCULATION-001
title: Aktuellen StBVV-Katalog nachvollziehbar kalkulieren und als Entwurf übernehmen
domain: rechnungen
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Vergütung und Rechnungswesen
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: Vollständiger aktueller StBVV-Gebührenkatalog mit Tabellen A–D, Gebührenrahmen, Zeit-/Betragsgebühren, dokumentierten manuellen Verweisen und enger VV-7000-Unterstützung. Kalkulationen sind unveränderliche Entwürfe; eine Übernahme erstellt idempotent eine neue XRECHNUNG im Status DRAFT für den regulären Archiv- und Versandpfad.
sources:
  - kind: official_law
    citation: 'StBVV § 17 in Verbindung mit RVG Anlage 1, VV 7000 Dokumentenpauschale'
    url: https://www.gesetze-im-internet.de/rvg/anlage_1.html
    checked_at: '2026-08-31'
    primary: true
  - kind: official_law
    citation: StBVV, konsolidierte Fassung, zuletzt geändert durch Art. 5 V vom 19.12.2025, BGBl. 2025 I Nr. 372; Anlagen 1 bis 4
    url: https://www.gesetze-im-internet.de/stbgebv/BJNR014420981.html
    checked_at: '2026-08-31'
    primary: true
  - kind: product_documentation
    citation: Technische Modulbeschreibung und Betriebsgrenzen
    path: docs/development/module/stbvv.md
    checked_at: '2026-08-31'
    primary: true
code_refs:
  - packages/tax/src/stbvv/catalog.ts
  - packages/tax/src/stbvv/calculator.ts
  - packages/tax/src/stbvv/tables.json
  - packages/tax/scripts/import-stbvv-tables.py
  - apps/web/src/server/stbvv/service.ts
  - apps/web/src/server/stbvv/lock.ts
  - apps/web/src/server/invoicing/archive-lock.ts
  - apps/web/src/server/invoicing/zugferd.ts
  - apps/web/src/app/staff/(protected)/stbvv/actions.ts
  - packages/db/prisma/migrations/20260831130000_screening_fees/migration.sql
test_refs:
  - packages/tax/src/stbvv/calculator.test.ts
  - apps/web/src/server/stbvv/__tests__/service.test.ts
  - apps/web/src/server/invoicing/__tests__/archive.test.ts
  - apps/web/src/server/invoicing/__tests__/zugferd.test.ts
  - packages/db/src/__tests__/screening-fees-rls.test.ts
feature_refs:
  - docs/development/module/stbvv.md
related_rules:
  - INV-VAT-TOTALS-001
  - INV-LIFECYCLE-FREEZE-001
  - INV-ARCHIVE-EINVOICE-001
  - ACCESS-STAFF-PERMISSION-001
tags:
  - feature-erweiterung
  - ungepruefter-entwurf
---

# STBVV-CALCULATION-001 — Aktuellen StBVV-Katalog nachvollziehbar kalkulieren und als Entwurf übernehmen

## Kurzfassung

Der Katalog enthält alle aktiven Gebührenpositionen der aktuellen StBVV.
Das Programm berechnet überprüfbare Beträge, entscheidet jedoch nicht über
Gebührenanspruch, angemessenen Satz oder Wirksamkeit einer Vereinbarung.

## Wann gilt die Regel?

Nur im aktivierten Modul `feeCalculator`, standardmäßig aus.
Die Anwendbarkeit des ausgewählten aktuellen Rechtsstands nach § 41 muss
ausdrücklich bestätigt werden; keine automatische historische Rückberechnung.

## Benötigte Angaben

Tatbestand, Angelegenheit/Gegenstand/Zeitraum, gewählter Satz, Berechnungsgrundlage,
Einheiten oder Zeit sowie Begründung. Landwirtschaft erfordert eine bereits
fachlich gewichtete Fläche; § 35 einen fachlich ermittelten Gegenstandswert.
Auslagen benötigen Anspruchsgrund und Beleg/Begründung; 0-%-USt einen Befreiungsgrund.

## Entscheidungslogik

| Situation                             | Produktverhalten                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wertgebühr                            | Amtliche Tabelle A–D mit einschließlich verstandenen bis-Grenzen und Mehrbetragsfortschreibung                                                     |
| Mindestwert/Prozentsatz               | Erst ausgewiesene Wertumrechnung, dann Mindestwert                                                                                                 |
| Rahmen/Zeit/Betrag                    | Benutzer wählt innerhalb gesetzlichem Rahmen; Viertelstunden werden begonnen gerechnet                                                             |
| Verbraucher-Erstgespräch              | § 21-Grenze 190 Euro vor Anrechnung                                                                                                                |
| Gleicher Gegenstand / Abgeltung       | Doppelte Positionen und ausgewählte USt-/LSt-Anmeldungen neben abgeltenden Leistungen werden zurückgewiesen                                        |
| Mindeststeuerbericht                  | Automatische Anrechnung innerhalb gleicher Gruppe bis zur Hälfte der Erklärung                                                                     |
| Beratung                              | Explizit gewählte Anrechnung höchstens einmal, Zielbetrag nicht negativ                                                                            |
| RVG-Verweis / Analogie / Vereinbarung | Deutlich manueller Fremdbetrag mit Pflichtbegründung, kein erfundener Tabellenansatz                                                               |
| Rechnung                              | Nur IN_APP und INVOICE_MANAGE; neue XRECHNUNG im Status DRAFT mit bestehendem Nummernkreis, Umsatzsteuerfunktion und regulärem Archiv-/Versandpfad |

## Ausnahmen und Grenzfälle

Negative Einkommen nach § 24 Abs. 1 Nr. 3 und Gewerbeerträge nach Nr. 5 führen
zum gesetzlichen Mindestwert. Bei Nr. 4 wird der absolute Betrag des
Mindeststeuergewinns/-verlusts vor der 1-%-Umrechnung verwendet; andere
Wertgrundlagen werden nicht automatisch als absoluter Betrag behandelt.

Die Tabellen unterscheiden Zehntel und Zwanzigstel. D a und D b werden bei
einschlägigen Landwirtschaftsfällen addiert; bei § 39 Abs. 3 wird der
100.000-Euro-Mehrbetrag vor dem Tabellenzugriff halbiert.
§ 36 Abs. 2 Nr. 1 benötigt Wert- und Zeitgebühr. Eine unaufgelöste Überlappung der
§-35-Ausnahmen darf der optionale Hilfsrechner nicht eigenständig entscheiden.
§§ 10, 12, 19 und 20 erfordern daneben ausdrücklich dokumentierte Einzelfallprüfung.

## Beispiele

### Normalfall

Eine Einkommensteuererklärung wird mit positiven Einkünften, gewähltem
Zehntelsatz und dokumentierter Rahmenbegründung berechnet. Die Ausgabe zeigt
Mindestwert, Tabellengebühr, Satz, Netto, USt und Rechtsstand.

### Grenzfall

Eine USt-Voranmeldung wird neben abgeltender Buchführung für dieselbe Angelegenheit
eingegeben. Die Berechnung wird zurückgewiesen. Ein alter gespeicherter Nachweis
wird durch eine neue Tabelle nicht verändert.

## Umsetzung in TaxTronik

Reine Rechenfunktionen im Tax-Paket, vollständiger UI-Katalog, serverseitige
Validierung, append-only Quotes, expliziter JSON-Nachweis und idempotente
DRAFT-Übernahme. Aus Tabellen-HTML importierte Zahlen enthalten Quellenhashes.
USt-Gruppierung und Nummernkreis werden aus dem bestehenden Rechnungsmodul genutzt.
Neue Berechnungen berühren keine festgeschriebenen Rechnungen.
Die Übernahme setzt `format = XRECHNUNG`. `PDF` ist ausschließlich der
Uploadpfad für externe Belege und würde ohne Dokument weder eine
Kontrollvorschau noch die spätere Festschreibung ermöglichen. Beim Versand
entstehen nach `INV-ARCHIVE-EINVOICE-001` die kanonische XML und Hybrid-PDF.
Beim erneuten Übernehmen wird ausschließlich ein bereits verknüpfter alter
`PDF`-Entwurf ohne Versandzeitpunkt und ohne PDF-/XML-Dokumentzeiger auf
`XRECHNUNG` korrigiert. Archiv-Lock und bedingtes Update schützen den Ablauf
gegen parallelen Versand/Storno; die Formatkorrektur wird auditiert. Nummer,
Beträge und gespeicherte Kalkulation bleiben erhalten. Ausgestellte Belege
oder Entwürfe mit Archivzeigern werden nicht verändert.
Bei dieser Entwurfsreparatur werden auch frühere generierte Pfeil-Rechenspuren
ersetzt, jedoch ausschließlich bei vollständiger Übereinstimmung des alten
Positionstexts mit dem gespeicherten Kalkulationsnachweis. Manuell veränderte
Beschreibungen bleiben erhalten. Die Anzahl der reparierten Texte wird auditiert.
Generierte Pfeile in Rechenspuren werden im Rechnungstext als „ergibt“
ausgeschrieben, ohne den gespeicherten Nachweis zu ändern. Lange Beschreibungen
einschließlich Quellenadressen werden im PDF ohne Kürzung in der
Beschreibungsspalte umgebrochen.
Zusätzliche restriktive INSERT-Regeln prüfen INVOICE_MANAGE auch in der Datenbank
gegen die aktuell aktive Identität und aktuelle Berechtigungen.

## Bekannte Abweichungen und Grenzen

Vollständiger Katalog, aber keine vollständige Anspruchsprüfung. Historische
Rechtsstände, voller RVG-/GKG-Rechner, Erfolgshonorar- und Vereinbarungsprüfung
sind nicht enthalten. Automatisch berechneter RVG-Verweis ausschließlich VV 7000.
Berechnungsgrundlagen und Anspruch auf Auslagen bleiben dokumentierte Eingaben.
Aufbewahrung/Löschung zusätzlicher Kalkulationsnachweise ist vor produktiver
Aktivierung zu regeln; der bestehende automatische Löschlauf wurde nicht erweitert.

## Fachliche Prüffragen

Sind alle Eingabehinweise und Rundungsregeln fachlich freigabefähig?
Sind Abgeltung, Anrechnung, Teilwerte und Sonderfälle ausreichend dokumentiert?
Welche Rechtsstände und RVG-Verfahren sollen später selbst berechnet werden?
Welche organisatorischen Prüfungen müssen vor Rechnungsversand nachgewiesen sein?

## Technische Nachweise

Tests durchlaufen jeden Katalogeintrag, alle importierten Tabellenstufen und
unabhängige Kontrollwerte der Fortschreibung sowie Gebühren-/Anrechnungs-,
Auslagen- und Umsatzsteuergrenzen. Die Modulbeschreibung legt manuelle Grenzen
und die versionierte Quellenpflege offen.
Der idempotente Rechnungsexport wird auf XRECHNUNG-/DRAFT-Anlage und Wiederverwendung geprüft;
ein Schnittstellentest führt die tatsächliche Gebührenübernahme anschließend
durch den Archivservice bis zur PDF-/XML-Verknüpfung. Datenbank, Object-Store
und PDF-Rendering sind dabei Testdoubles; ein vollständiger produktionsnaher
Versandnachweis wird damit nicht behauptet.
Ein zusätzlicher Test führt eine Zeitgebühr über die tatsächliche
Rechnungsübernahme, CII-Erzeugung und PDF-Erzeugung bis zur Textextraktion;
31 Minuten zu 20 Euro je angefangener Viertelstunde ergeben unabhängig
kontrollierte 60 Euro netto. Reparaturtests prüfen die Status-/Dokument-
Vorbedingungen und dass keine zweite Nummer vergeben wird.
Der echte PDF-Test umfasst auch die Reparatur eines alten Zeitgebühren-
Entwurfs mit ursprünglich nicht darstellbarem Pfeil im generierten Text.
ein echter PostgreSQL-Test führt den Produktions-Lock mit dem Prisma-Adapter aus,
ohne den PostgreSQL-Rückgabewert `void` zu deserialisieren.
