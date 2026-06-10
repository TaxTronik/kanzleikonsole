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
  `documentId` → GoBD-Archivkopie); `InvoicePosition` (Cascade am Entwurf);
  `InvoiceCategory` (EXTERNAL: Mail-Template-Zuordnung);
  `InvoiceNumberSeq` (tenantId+year → lastNo, Nummernkreis).

## Programminterne Kontrollen

| Kontrolle | Umsetzung |
|---|---|
| Eingabekontrollen | zod-Schemas je Action (`invoices/actions.ts`, `billing/actions.ts`): Pflichtfelder, Wertebereiche (USt 0–99, Positionsgrenzen), Datumsformate; Beträge werden serverseitig berechnet/gerundet, nie vom Client übernommen |
| Belegnummern | automatische, lückenlose Vergabe je Tenant+Jahr (`server/invoicing/number.ts`: Advisory-Lock + `invoice_number_seq` in der Anlage-Tx; Rollback erzeugt keine Lücke; Initialisierung aus Bestands-MAX); DB-Unique `(tenantId, number)`; EXTERNAL: Fremdnummer, nur Unique-Schutz |
| Festschreibung | DB-Trigger `invoice_protect_update/_delete`, `invoice_position_protect` (Migration iter85): nach DRAFT sind Geschäftsfelder/Positionen unveränderlich (auch Owner), DELETE nur für Entwürfe; Lebenszyklus-Felder (status, sentAt, paidAt, documentId) bleiben führbar |
| Ablaufsteuerung | Status-Matrix doppelt: App (`isValidInvoiceTransition`, klare Meldungen) + identische Trigger-Matrix als Backstop; PAID/CANCELLED terminal |
| GwG-Schranke | DB-Trigger blockt Rechnungsanlage für nicht-aktive Mandanten (init/iter5) |
| Archiv-Pflicht | `markSentAction`: GoBD-Archivkopie (s. u.) MUSS vor dem Statuswechsel existieren (außer PDF/EXTERNAL: not_applicable) |
| Zugriff | Staff-Session-Guard je Action; RESTRICTED-Mandanten in Liste/Detail/Downloads gefiltert; Portal sieht nur eigene, nicht-DRAFT-Rechnungen |
| Protokollierung | Audit-Events `invoice.create/.create.from_time/.send/.paid/.cancel/.upload/.overdue/.archive.zugferd`, `invoice.xrechnung.download`/`zugferd.download` (mit IP/UA), `invoices.export.csv` — alle in der Hash-Chain |

## Verarbeitung / Schnittstellen

- **E-Rechnung:** XRechnung (UN/CEFACT CII, Profil XRechnung 3.0,
  `server/invoicing/xrechnung.ts`) und ZUGFeRD (PDF mit eingebettetem
  Factur-X-XML, EN 16931, `zugferd.ts`); Pflichtfeld-Validierung
  (Verkäufer/Käufer-Anschrift) vor Erzeugung.
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

## Bekannte Grenzen (dokumentiert, bewusst)

- USt nur Kategorie „S" in der E-Rechnung — steuerfreie/0%-Fälle (Kategorie
  Z/E mit Befreiungsgrund) sind nicht abgebildet; fachliche Entscheidung
  offen (Gap-Analyse).
- Storno ist ein Status, kein Stornobeleg (kein Dokumenttyp 381 / keine
  Gutschrift); EXTERNAL erfasst keinen USt-Split (Brutto=Netto in der DB).
- XRechnung-/ZUGFeRD-Konformität ist konstruktiv umgesetzt, aber nicht
  gegen den KoSIT-Validator automatisiert geprüft.
