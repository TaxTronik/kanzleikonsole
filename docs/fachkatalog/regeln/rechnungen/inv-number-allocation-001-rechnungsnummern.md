---
id: INV-NUMBER-ALLOCATION-001
title: In-App-Rechnungsnummern atomar und ohne Wiederverwendung vergeben
domain: rechnungen
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Rechnungswesen
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: In-App-Rechnungen erhalten unter Tenant-Jahres-Lock eine fortlaufende Nummer in derselben Transaktion wie der Entwurf; vorher prüft jeder Anlagepfad Rechnungsjahr (laufendes Jahr ± 1) und Fälligkeit nicht vor dem Rechnungsdatum. Externe Nummernkreise bleiben fremdgeführt.
sources:
  - kind: official_law
    citation: § 14 Abs. 4 Nr. 4 UStG, fortlaufende und einmalig vergebene Rechnungsnummer
    url: https://www.gesetze-im-internet.de/ustg_1980/__14.html
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: Technische Modulbeschreibung Fakturierung, Belegnummern und Nummernkreis
    path: docs/development/module/fakturierung.md
    checked_at: '2026-08-24'
    primary: true
code_refs:
  - apps/web/src/server/invoicing/number.ts
  - packages/db/prisma/schema.prisma
  - apps/web/src/server/invoicing/create-draft.ts
  - apps/web/src/app/staff/(protected)/invoices/actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/billing/actions.ts
  - apps/web/src/app/staff/(protected)/stbvv/actions.ts
test_refs:
  - apps/web/src/server/invoicing/__tests__/number.test.ts
  - packages/db/src/__tests__/invoice-festschreibung.test.ts
  - apps/web/src/server/invoicing/__tests__/create-draft.test.ts
  - apps/web/src/server/invoicing/__tests__/invoice-actions.test.ts
  - apps/web/src/app/staff/(protected)/stbvv/__tests__/actions.test.ts
feature_refs:
  - docs/development/module/fakturierung.md
  - docs/anwenderdoku/rechnungen.md
related_rules:
  - INV-LIFECYCLE-FREEZE-001
  - INV-STORNO-REFERENCE-001
  - INV-TIME-ENTRY-CLAIM-001
tags:
  - rechnung
  - rechnungsnummer
  - nummernkreis
  - transaktion
---

# INV-NUMBER-ALLOCATION-001 — In-App-Rechnungsnummern atomar und ohne Wiederverwendung vergeben

## Kurzfassung

In-App-Rechnungen erhalten automatisch eine Nummer im Format `JJJJ-NNNN` aus
einem getrennten Zähler je Kanzlei-Tenant und Rechnungsjahr. Vergabe,
Zählererhöhung und Rechnungsanlage laufen in derselben Transaktion unter einem
Tenant-Jahres-Advisory-Lock. Ein Rollback verbraucht daher keinen
Zählerstand; stornierte Entwürfe und ausgestellte Rechnungen behalten ihre
Nummer.

## Wann gilt die Regel?

Die Regel gilt für Rechnungsentwürfe, die TaxTronik im Modus `IN_APP` anlegt,
einschließlich Entwürfen aus Zeiteinträgen und Korrekturbelegen. Im Modus
`EXTERNAL` übernimmt TaxTronik die Nummer des führenden Fremdsystems und nutzt
den internen Zähler nicht.

## Benötigte Angaben

- ID des Kanzlei-Tenants (`tenantId`), nicht die ID des Rechnungsempfängers
- Rechnungsdatum und daraus abgeleitetes UTC-Kalenderjahr
- Fälligkeitsdatum
- letzter Zählerstand des Tenant-Jahres
- bereits vorhandene interne Nummern dieses Jahres bei Erstinitialisierung
- Betriebsmodus `IN_APP` oder `EXTERNAL`
- gemeinsame Datenbanktransaktion für Zähler und Rechnungs-Insert

## Entscheidungslogik

| Ausgangslage                                                           | Ergebnis                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| erste In-App-Anlage eines Tenant-Jahres                                | Zähler unter Lock aus dem höchsten passenden Bestand initialisieren |
| Zähler existiert                                                       | `last_no` atomar erhöhen und `JJJJ-NNNN` formatieren                |
| Rechnungs-Insert oder späterer Schritt derselben Transaktion scheitert | Zählererhöhung mit zurückrollen                                     |
| Entwurf wird storniert                                                 | Nummer am stornierten Beleg erhalten, nicht erneut vergeben         |
| Korrekturbeleg wird erstellt                                           | neue Nummer aus dem aktuellen internen Tenant-Jahr vergeben         |
| externe Rechnung wird hochgeladen                                      | Fremdnummer verwenden; reserviertes internes Muster ablehnen        |
| Tenant und Nummer existieren bereits                                   | Unique-Verstoß melden statt Nummer wiederzuverwenden                |
| Rechnungsdatum außerhalb des laufenden Jahres ± 1 (In-App)             | vor der Nummernvergabe ablehnen                                     |
| Fälligkeit vor dem Rechnungsdatum (jeder Anlagepfad)                   | vor Nummernvergabe bzw. Fremd-PDF-Ablage ablehnen                   |

## Ausnahmen und Grenzfälle

Der Zähler wächst über vier Stellen hinaus, ohne eine Nummer abzuschneiden.
Die Erstinitialisierung berücksichtigt nur bestehende Nummern, die dem
Jahresmuster entsprechen. Das Rechnungsdatum bestimmt den Jahreskreis. Zulässig
ist ein Rechnungsdatum im laufenden Jahr ± 1 (Rück- und Vordatierungsfenster);
der Product Owner hat dieses Fenster am 2026-10-07 als Produktentscheidung
bestätigt. Das ist keine fachliche Freigabe durch einen Berufsträger; der
organisatorische Jahresabschluss bleibt eine davon getrennte Fachentscheidung.

Die Fälligkeit darf nicht vor dem Rechnungsdatum liegen; eine Fälligkeit am
Rechnungsdatum ist zulässig (Produktentscheidung vom 2026-10-07, zuvor nur bei
der StBVV-Übernahme geprüft). Eine aktive Mandatsbeziehung verlangt weiterhin
nur die StBVV-Übernahme, damit Schlussrechnungen nach Mandatsende möglich
bleiben.

## Beispiele

### Normalfall

Der erste erfolgreiche In-App-Entwurf eines Kanzlei-Tenants im Jahr 2026
erhält `2026-0001`. Ein paralleler zweiter Entwurf desselben Kanzlei-Tenants
wartet auf denselben Tenant-Jahres-Lock und erhält nach erfolgreichem Insert
`2026-0002`.

### Grenzfall

Eine Stundenabrechnung reserviert rechnerisch die nächste Nummer, verliert aber
anschließend den atomaren Claim auf einen Zeiteintrag. Die gesamte Transaktion
rollt zurück; der nächste erfolgreiche Entwurf darf denselben noch nicht
verwendeten Zählerwert erhalten.

## Umsetzung in TaxTronik

`allocateInvoiceNumber()` sperrt den Schlüssel aus Kanzlei-Tenant und Jahr,
initialisiert `invoice_number_seq` gegebenenfalls aus dem Bestand, erhöht den
Zähler und formatiert die Nummer. Das Prisma-Schema erzwingt einen Zähler je
Tenant/Jahr sowie die Eindeutigkeit der Rechnungsnummer je Tenant. Alle
In-App-Anlagepfade rufen die Vergabe innerhalb ihrer Rechnungs-Transaktion auf.

Vor der Vergabe prüft `checkDraftInvoice` im gemeinsamen Anlageservice für
manuelle Rechnungen, Stundenabrechnungen und StBVV-Übernahmen das
Rechnungsjahr (laufendes Jahr ± 1) und mit `dueDateError` die Fälligkeit; die
Actions wiederholen die Fälligkeitsprüfung vor dem Öffnen der Transaktion. Der
EXTERNAL-Upload prüft die Fälligkeit vor der Object-Lock-Ablage der Fremd-PDF.
Alle Pfade lehnen mit derselben Meldung ab wie bisher die StBVV-Übernahme:
„Rechnungsdatum und Fälligkeit sind ungültig.“ Ein Korrekturbeleg trägt
Rechnungs- und Fälligkeitsdatum desselben Tages. Bewusst gibt es keinen
Datenbank-CHECK: Altbestand mit früherer Fälligkeit würde sonst spätere
Status- oder Archivänderungen blockieren.

## Bekannte Abweichungen und Grenzen

Die technische Vergabe ist umgesetzt, aber ihre fachliche Ausgestaltung ist
nicht abschließend geklärt. Die Fälligkeitsprüfung wirkt nur in der Anwendung;
Direkt-DB-Pfade und Altbestand können eine Fälligkeit vor dem Rechnungsdatum
enthalten. Nummernkreise jenseits eines einzigen Tenant-Jahres, Jahreswechsel,
Migration aus Fremdsystemen, abgebrochene Geschäftsvorfälle und eine mögliche
organisatorische Begründung von Lücken brauchen eine Berufsträgerregel. Die vorhandenen automatischen Tests prüfen
Format, Status-Festschreibung und DB-Eindeutigkeit, aber keinen vollständigen
DB-Regressionstest für parallele Vergabe und Rollback des Zählers.

## Fachliche Prüffragen

- Ist ein gemeinsamer Nummernkreis je Kanzlei-Tenant und Rechnungsjahr für alle
  Rechnungsempfänger und Kanzleifälle richtig?
- Wie sind Jahreswechsel, Datenmigration und externe Nummernkreise zu
  dokumentieren?
- Dürfen Entwürfe bereits eine endgültige Nummer erhalten, und wie werden
  abgebrochene Entwürfe fachlich erklärt?
- Trägt das vom Product Owner bestätigte Rückdatierungsfenster (laufendes Jahr
  ± 1) auch fachlich, etwa für Rechnungen über länger zurückliegende Leistungen?
- Welche Direkt-DB- oder Administrationspfade müssen zusätzlich gegen Löschen
  und Wiederverwendung geschützt werden?

## Technische Nachweise

Der Unit-Test prüft Formatierung und Wachstum der Nummer. Die Tests des
Anlageservice und der Actions prüfen je Pfad (manuell, Stundenabrechnung,
StBVV-Service und -Action, EXTERNAL-Upload), dass eine Fälligkeit vor dem
Rechnungsdatum vor Nummernvergabe, Zeiteintrags-Claim oder Object-Lock-Ablage
mit derselben Meldung abgelehnt und eine Fälligkeit am Rechnungsdatum
angenommen wird. Der Festschreibungs-Integrationstest belegt, dass ausgestellte
Nummern nicht geändert und versendete Belege nicht gelöscht werden können;
Unique-Constraints und das Zählermodell stehen im Prisma-Schema. Ein direkter Concurrency- und
Rollback-Test der Vergabefunktion bleibt als Nachweislücke benannt.
