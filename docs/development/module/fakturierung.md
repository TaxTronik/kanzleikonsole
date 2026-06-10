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
  Rundung je Satz-Gruppe (nicht je Position), EN-16931-Kategorie S/Z;
  `invoice.vatRate` ist nur noch informativ (einheitlicher Satz oder NULL
  bei Mischsätzen/EXTERNAL).

## Programminterne Kontrollen

| Kontrolle | Umsetzung |
|---|---|
| Eingabekontrollen | zod-Schemas je Action (`invoices/actions.ts`, `billing/actions.ts`): Pflichtfelder, Wertebereiche (USt 0–99, Positionsgrenzen), Datumsformate; Beträge werden serverseitig berechnet/gerundet, nie vom Client übernommen |
| Belegnummern | automatische, lückenlose Vergabe je Tenant+Jahr (`server/invoicing/number.ts`: Advisory-Lock + `invoice_number_seq` in der Anlage-Tx; Rollback erzeugt keine Lücke; Initialisierung aus Bestands-MAX); DB-Unique `(tenantId, number)`; EXTERNAL: Fremdnummer, nur Unique-Schutz |
| Festschreibung | DB-Trigger `invoice_protect_update/_delete`, `invoice_position_protect` (Migration iter85): nach DRAFT sind Geschäftsfelder/Positionen unveränderlich (auch Owner), DELETE nur für Entwürfe; Lebenszyklus-Felder (status, sentAt, paidAt, documentId) bleiben führbar |
| Ablaufsteuerung | Status-Matrix doppelt: App (`isValidInvoiceTransition`, klare Meldungen) + identische Trigger-Matrix als Backstop; PAID/CANCELLED terminal |
| GwG-Schranke | DB-Trigger blockt Rechnungsanlage für nicht-aktive Mandanten (init/iter5) |
| Archiv-Pflicht | `markSentAction`: GoBD-Archivkopie (s. u.) MUSS vor dem Statuswechsel existieren (außer PDF/EXTERNAL: not_applicable) |
| Zugriff | Staff-Session-Guard je Action; seit iter87 Einzelrechte: Anlegen/Bearbeiten/Zahlung/Storno nur mit `INVOICE_MANAGE`, Versand (= Festschreibung) und EXTERNAL-Upload nur mit `INVOICE_SEND` (ADMIN/PARTNER implizit, Vergabe auditiert); RESTRICTED-Mandanten in Liste/Detail/Downloads gefiltert; Portal sieht nur eigene, nicht-DRAFT-Rechnungen |
| Protokollierung | Audit-Events `invoice.create/.create.from_time/.send/.paid/.cancel/.upload/.overdue/.archive.zugferd`, `invoice.xrechnung.download`/`zugferd.download` (mit IP/UA), `invoices.export.csv` — alle in der Hash-Chain |

## Verarbeitung / Schnittstellen

- **E-Rechnung:** XRechnung (UN/CEFACT CII, Profil XRechnung 3.0,
  `server/invoicing/xrechnung.ts`) und ZUGFeRD (PDF mit eingebettetem
  Factur-X-XML, EN 16931, `zugferd.ts`); Steuerblock je Satz-Gruppe (BG-23),
  Käuferreferenz (BT-10), Verkäufer-Kontakt (BG-6), Leistungsdatum (BT-72,
  Konvention: = Rechnungsdatum); Pflichtfeld-Validierung vor Erzeugung —
  Verkäufer-Anschrift inkl. E-Mail + Telefon (BG-6-Pflicht), Käufer-Anschrift.
- **GoBD-Archiv:** `server/invoicing/archive.ts` — byte-stabile Ablage bei
  Versand (Object-Lock COMPLIANCE, 10 Jahre), idempotent, als geteiltes
  Mandanten-Dokument (Portal-Download); EXTERNAL-PDF analog beim Upload.
- **Worker:** `invoice-overdue-check` (täglich 06:15 UTC): SENT + überfällig
  → OVERDUE + Audit (SYSTEM) + interne Notification.
- **Zustellung:** EXTERNAL versendet E-Mail mit PDF-Anhang an aktive
  Kontakte mit Opt-in (Template je Rechnungstyp); n8n-Event `invoice.due`.

## Traceability (Anforderung → Implementierung → Test)

| Anforderung | Implementierung | Test |
|---|---|---|
| Lückenlose automatische Nummernvergabe | `number.ts` + `invoice_number_seq` | `invoicing/__tests__/number.test.ts` (Format); DB-Probe Rollback-Lückenlosigkeit (verifiziert 2026-06-10); Unique via P2002-Mapping |
| Unveränderlichkeit nach Versand | iter85-Trigger | `packages/db/src/__tests__/invoice-festschreibung.test.ts` (6 Fälle inkl. Owner-Pfad, Positionen, DELETE) |
| Status-Matrix nur vorwärts | `number.ts` + Trigger | `number.test.ts` (14 Matrix-Fälle) + Festschreibungs-Test |
| Archivkopie vor Festschreibung | `markSentAction` + `archive.ts` | `invoicing/__tests__/archive.test.ts` (Idempotenz, Race, Validierungscodes) |
| Überfälligkeit automatisch + auditiert | Worker | `apps/worker/.../invoice-overdue-check.test.ts` (5 Fälle) |
| Mandantentrennung | RLS + tenant-Filter | `rls-cross-tenant.test.ts` (Invoice-Fälle) |
| Auth auf jeder Action | staffActionGuard/withStaff | `server-action-authz.test.ts` (AST-Guard) |
| USt je Position, Rundung je Satz-Gruppe | `vat.ts` (iter86) | `invoicing/__tests__/vat.test.ts` (5 Fälle) |
| XRechnung-Konformität (Schema + BR-DE) | `xrechnung.ts` | `xrechnung.test.ts` (Struktur) + CI-Job `e-rechnung`: KoSIT-Validator gegen die geteilte Mischsätze-Fixture (`sample-fixture.ts`), Prüfbericht als Artefakt |

## Bekannte Grenzen (dokumentiert, bewusst)

- E-Rechnung kennt die USt-Kategorien S (Satz > 0) und Z (0 %) — befreite
  Umsätze mit Befreiungsgrund (Kategorie E, BT-121) sind nicht abgebildet;
  0-%-Positionen laufen als Z ohne Begründungstext.
- Storno ist ein Status, kein Stornobeleg (kein Dokumenttyp 381 / keine
  Gutschrift); EXTERNAL erfasst keinen USt-Split (Brutto=Netto in der DB,
  `vatRate` der Positionen/des Kopfes bleibt NULL).
- Leistungsdatum (BT-72) wird per Konvention mit dem Rechnungsdatum
  gleichgesetzt; ein eigenes Leistungsdatum-Feld gibt es nicht.

Seit iter86 entfallen: USt je Position (vorher nur Kopfsatz) und die
fehlende KoSIT-Prüfung — der CI-Job `e-rechnung` validiert jeden Lauf
gegen Schema + Schematron (inkl. BR-DE) der XRechnung 3.0.2.
