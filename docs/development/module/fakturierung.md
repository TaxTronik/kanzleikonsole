# Technische Modulbeschreibung: Fakturierung

Aufbauprüfungs-Grundlage für das Scope-Modul Rechnungen (Aktualisierung bei
jeder funktionalen Änderung Pflicht).

## Zweck und Modi

Rechnungsstellung an Mandanten in zwei Betriebsmodi (Tenant-Einstellung
`invoiceMode`, serverseitig in jeder Action erzwungen): `IN_APP`
(Positionen, Beträge, E-Rechnung in TaxTronik) oder `EXTERNAL`
(PDF-Ablage + Mandanten-Zustellung für Fremdsystem-Rechnungen); `OFF`
deaktiviert das Modul.

## Datenmodell (packages/db/prisma/schema.prisma)

- `Invoice` — Kopf (number tenant-unique, Beträge als Decimal(12,2), Status
  DRAFT/SENT/PAID/OVERDUE/CANCELLED, Format PDF/XRECHNUNG/ZUGFERD,
  `documentId` → GoBD-Archivkopie); `InvoicePosition` (Cascade am Entwurf,
  trägt seit iter86 den USt-Satz je Position — § 14 Abs. 4 Nr. 8 UStG);
  `InvoiceCategory` (EXTERNAL: Mail-Template-Zuordnung);
  `InvoiceNumberSeq` (tenantId+year → lastNo, Nummernkreis).
- USt-Logik zentral in `server/invoicing/vat.ts`: Gruppierung je Satz,
  Rundung je Satz-Gruppe (nicht je Position), EN-16931-Kategorien S/Z/E/AE
  gemäß den unten dokumentierten Steuerregeln;
  `invoice.vatRate` ist nur noch informativ (einheitlicher Satz oder NULL
  bei Mischsätzen/EXTERNAL).

## Programminterne Kontrollen

| Kontrolle         | Umsetzung                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Eingabekontrollen | zod-Schemas je Action (`invoices/actions.ts`, `billing/actions.ts`): Pflichtfelder, Wertebereiche (USt 0–99, Positionsgrenzen), Datumsformate; Beträge werden serverseitig berechnet/gerundet, nie vom Client übernommen                                                                                                                          |
| Belegnummern      | automatische, lückenlose Vergabe je Tenant+Jahr (`server/invoicing/number.ts`: Advisory-Lock + `invoice_number_seq` in der Anlage-Tx; Rollback erzeugt keine Lücke; Initialisierung aus Bestands-MAX); DB-Unique `(tenantId, number)`; EXTERNAL: Fremdnummer, nur Unique-Schutz                                                                   |
| Festschreibung    | DB-Trigger `invoice_protect_update/_delete`, `invoice_position_protect` (Migration iter85): nach DRAFT sind Geschäftsfelder/Positionen unveränderlich (auch Owner), DELETE nur für Entwürfe; Lebenszyklus-Felder (status, sentAt, paidAt, documentId) bleiben führbar                                                                             |
| Ablaufsteuerung   | Status-Matrix doppelt: App (`isValidInvoiceTransition`, klare Meldungen) + identische Trigger-Matrix als Backstop; `PAID → CANCELLED` ist für einen ordnungsgemäßen Korrekturbeleg zulässig, `CANCELLED` ist terminal                                                                                                                             |
| GwG-Schranke      | DB-Trigger blockt Rechnungsanlage für nicht-aktive Mandanten (init/iter5)                                                                                                                                                                                                                                                                         |
| Archiv-Pflicht    | `markSentAction`: GoBD-Archivkopie (s. u.) MUSS vor dem Statuswechsel existieren (außer PDF/EXTERNAL: not_applicable)                                                                                                                                                                                                                             |
| Zugriff           | Staff-Session-Guard je Action; seit iter87 Einzelrechte: Anlegen/Bearbeiten/Zahlung/Storno nur mit `INVOICE_MANAGE`, Versand (= Festschreibung) und EXTERNAL-Upload nur mit `INVOICE_SEND` (ADMIN/PARTNER implizit, Vergabe auditiert); RESTRICTED-Mandanten in Liste/Detail/Downloads gefiltert; Portal sieht nur eigene, nicht-DRAFT-Rechnungen |
| Protokollierung   | Audit-Events `invoice.create/.create.from_time/.send/.paid/.cancel/.upload/.overdue/.archive.zugferd`, `invoice.xrechnung.download`/`zugferd.download` (mit IP/UA), `invoices.export.csv` — alle in der Hash-Chain                                                                                                                                |

## Verarbeitung / Schnittstellen

- **E-Rechnung:** XRechnung (UN/CEFACT CII, Profil XRechnung 3.0.2,
  `server/invoicing/xrechnung.ts`) und ZUGFeRD (PDF mit eingebettetem
  Factur-X-XML, EN 16931, `zugferd.ts`); Steuerblock je Satz-Gruppe (BG-23),
  Käuferreferenz (BT-10), Verkäufer-Kontakt (BG-6), optionaler
  Leistungszeitraum (BG-14/BT-73/BT-74; ohne Zeitraum gilt das
  Rechnungsdatum), Steuerbefreiung Kategorie E mit BT-120 und Reverse Charge
  Kategorie AE; Pflichtfeld-Validierung vor Erzeugung —
  Verkäufer-Anschrift inkl. E-Mail + Telefon (BG-6-Pflicht), Käufer-Anschrift.
- **GoBD-Archiv:** `server/invoicing/archive.ts` — byte-stabile Ablage bei
  Versand (Object-Lock COMPLIANCE, 8 Jahre ab dem einschlägigen Jahresende),
  idempotent, als geteiltes
  Mandanten-Dokument (Portal-Download); EXTERNAL-PDF analog beim Upload.
- **Worker:** `invoice-overdue-check` (täglich 06:15 UTC): SENT + überfällig
  → OVERDUE + Audit (SYSTEM) + interne Notification.
- **Zustellung:** EXTERNAL versendet E-Mail mit PDF-Anhang an aktive
  Kontakte mit Opt-in (Template je Rechnungstyp); n8n-Event `invoice.due`.

## Traceability (Anforderung → Implementierung → Test)

| Anforderung                             | Implementierung                            | Test                                                                                                                                                                                                               |
| --------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lückenlose automatische Nummernvergabe  | `number.ts` + `invoice_number_seq`         | `invoicing/__tests__/number.test.ts` (Format); DB-Probe Rollback-Lückenlosigkeit (verifiziert 2026-06-10); Unique via P2002-Mapping                                                                                |
| Unveränderlichkeit nach Versand         | iter85-Trigger                             | `packages/db/src/__tests__/invoice-festschreibung.test.ts` (6 Fälle inkl. Owner-Pfad, Positionen, DELETE)                                                                                                          |
| Status-Matrix nur vorwärts              | `number.ts` + Trigger                      | `number.test.ts` (14 Matrix-Fälle) + Festschreibungs-Test                                                                                                                                                          |
| Archivkopie vor Festschreibung          | `markSentAction` + `archive.ts`            | `invoicing/__tests__/archive.test.ts` (Idempotenz, Race, Validierungscodes)                                                                                                                                        |
| Überfälligkeit automatisch + auditiert  | Worker                                     | `apps/worker/.../invoice-overdue-check.test.ts` (5 Fälle)                                                                                                                                                          |
| Mandantentrennung                       | RLS + tenant-Filter                        | `rls-cross-tenant.test.ts` (Invoice-Fälle)                                                                                                                                                                         |
| Auth auf jeder Action                   | staffActionGuard/withStaff                 | `server-action-authz.test.ts` (AST-Guard)                                                                                                                                                                          |
| USt je Position, Rundung je Satz-Gruppe | `vat.ts` (iter86)                          | `invoicing/__tests__/vat.test.ts` (5 Fälle)                                                                                                                                                                        |
| XRechnung-Konformität (Schema + BR-DE)  | `xrechnung.ts`                             | `xrechnung.test.ts` (Struktur) + CI-Job `e-rechnung`: KoSIT-Validator gegen die geteilte Mischsätze-Fixture (`sample-fixture.ts`), Prüfbericht als Artefakt                                                        |
| Korrekturbeleg für In-App-Rechnung      | `cancelInvoiceAction` + `xrechnung.ts`     | `storno.test.ts` (negative Positionen) und `xrechnung.test.ts` (TypeCode 381/Vorgängerreferenz); ein direkter Action-Level-Test des Orchestrierungsflusses ist als offene Nachweislücke im Testkonzept ausgewiesen |
| Leistungszeitraum/Befreiung/§ 13b       | `actions.ts`, `xrechnung.ts`, `zugferd.ts` | `xrechnung.test.ts` für BG-14, Kategorie E/BT-120 und Kategorie AE; Action-Eingabevalidierung ist nicht als vollständig direkt abgedeckt auszuweisen                                                               |

## Bekannte Grenzen (dokumentiert, bewusst)

- `EXTERNAL` übernimmt die fachliche Rechnungserstellung nicht: TaxTronik
  archiviert und versendet das bereitgestellte PDF, erfasst aber keinen
  USt-Split und erzeugt keinen Korrekturbeleg. Korrekturen müssen zuerst im
  führenden Fremdsystem erstellt und anschließend dokumentiert werden.
- Für In-App-Rechnungen erzeugt Storno einen eigenen negativen
  Korrekturbeleg mit neuer Nummer, TypeCode 381 und Vorgängerreferenz. Eine
  tatsächliche Rückzahlung bereits bezahlter Rechnungen wird nicht automatisch
  ausgeführt; sie bleibt ein gesonderter Zahlungsvorgang.
- Ohne erfassten Leistungszeitraum verwendet die E-Rechnung das
  Rechnungsdatum als Leistungsdatum. Das ist eine bewusste Eingabekonvention,
  keine Behauptung, jeder reale Leistungszeitraum entspreche diesem Datum.

Seit iter86 entfallen: USt je Position (vorher nur Kopfsatz) und die
fehlende KoSIT-Prüfung — der CI-Job `e-rechnung` validiert jeden Lauf
gegen Schema + Schematron (inkl. BR-DE) der XRechnung 3.0.2.
