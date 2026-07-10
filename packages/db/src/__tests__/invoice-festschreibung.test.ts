// =============================================================================
// Festschreibung Fakturierung (DB-Invariante, iter85) — Pflicht in CI
//
// GoB-Kern: Nach Verlassen von DRAFT sind die geschäftlichen Felder einer
// Rechnung und ihre Positionen unveränderlich, Statusübergänge folgen einer
// festen Vorwärts-Matrix, Löschen ist nur für Entwürfe möglich. Durchgesetzt
// von den Triggern invoice_protect_update/_delete + invoice_position_protect
// (Migration iter85) — unabhängig vom App-Guard, auch für den BYPASSRLS-Owner
// (Muster: gwg-allow-active.test.ts / protect_immutable_document_version).
//
// Cleanup: SENT-Rechnungen sind absichtlich unlöschbar — der afterAll
// deaktiviert GEZIELT die drei Festschreibungs-Trigger in EINER Transaktion
// (nicht session_replication_role=replica, das auch FK-Cascade abschaltete)
// und räumt dann den Test-Tenant ab. Die DDL ist transaktional: bricht das
// DELETE ab, rollt auch das DISABLE TRIGGER zurück — die Trigger bleiben nie
// global deaktiviert. Legt der Test künftig immutable document_version-Zeilen
// an, muss deren Schutz-Trigger hier ebenfalls in die Disable-Liste.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';

const hasDatabase = Boolean(process.env['DATABASE_URL']);

if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Festschreibungs-Test braucht DATABASE_URL in CI (Owner-URL fürs Setup).');
}

const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

let tenantId: string;
let clientId: string;
let staffId: string;

const FUTURE = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  const tenant = await owner.tenant.create({
    data: { slug: `test-inv-gob-${Date.now()}`, name: 'Festschreibung Test' },
  });
  tenantId = tenant.id;

  const staff = await owner.staffUser.create({
    data: {
      tenantId,
      email: `inv-gob-${Date.now()}@test.local`,
      fullName: 'Test Staff',
      passwordHash: 'x',
    },
  });
  staffId = staff.id;

  // GwG-Schranke: Rechnungen brauchen einen AKTIVEN Mandanten (eigener Trigger).
  const client = await owner.client.create({
    data: { tenantId, kind: 'JURPERS', name: 'Festschreibungs-Mandant', allowActive: false },
  });
  clientId = client.id;
  await owner.gwgCheck.create({
    data: { tenantId, clientId, status: 'VERIFIED', validUntil: FUTURE },
  });
  await owner.client.update({ where: { id: clientId }, data: { allowActive: true } });
});

afterAll(async () => {
  // Cleanup: die Festschreibungs-Trigger blockieren sonst das Löschen
  // versendeter Rechnungen. BEWUSST gezielt deaktiviert statt
  // session_replication_role=replica — Letzteres schaltet auch die
  // FK-Cascade-Trigger ab, sodass tenant.deleteMany verwaiste Kinder
  // hinterließe. In EINER Transaktion, damit DISABLE und DELETE garantiert
  // auf DERSELBEN Pool-Connection laufen (sonst greift das DISABLE evtl.
  // nicht für das DELETE). DISABLE TRIGGER wirkt auch für Cascade-Deletes.
  await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`ALTER TABLE "invoice" DISABLE TRIGGER invoice_protect_delete`);
    await tx.$executeRawUnsafe(`ALTER TABLE "invoice" DISABLE TRIGGER invoice_protect_update`);
    await tx.$executeRawUnsafe(`ALTER TABLE "invoice_position" DISABLE TRIGGER invoice_position_protect`);
    await tx.tenant.deleteMany({ where: { id: tenantId } });
    await tx.$executeRawUnsafe(`ALTER TABLE "invoice" ENABLE TRIGGER invoice_protect_delete`);
    await tx.$executeRawUnsafe(`ALTER TABLE "invoice" ENABLE TRIGGER invoice_protect_update`);
    await tx.$executeRawUnsafe(`ALTER TABLE "invoice_position" ENABLE TRIGGER invoice_position_protect`);
  });
  await owner.$disconnect();
});

let counter = 0;

async function makeInvoice(): Promise<string> {
  counter += 1;
  const inv = await owner.invoice.create({
    data: {
      tenantId,
      clientId,
      number: `TEST-${Date.now()}-${counter}`,
      subject: 'Beratung',
      issueDate: new Date('2026-06-01'),
      dueDate: new Date('2026-07-01'),
      status: 'DRAFT',
      format: 'XRECHNUNG',
      netAmount: 100,
      vatAmount: 19,
      totalAmount: 119,
      vatRate: 19,
      createdByStaff: staffId,
      positions: {
        create: [{ position: 1, description: 'Stunde', quantity: 1, unit: 'Stunde', unitPrice: 100, netAmount: 100, vatRate: 19 }],
      },
    },
  });
  return inv.id;
}

async function setStatus(id: string, status: 'SENT' | 'PAID' | 'OVERDUE' | 'CANCELLED'): Promise<unknown> {
  return owner.invoice.update({ where: { id }, data: { status } });
}

describeWithDatabase('Festschreibung: Rechnung nach Versand unveränderlich (iter85-Trigger)', () => {
  it('DRAFT bleibt voll änderbar (inkl. Betrag und Positionen)', async () => {
    const id = await makeInvoice();
    await expect(
      owner.invoice.update({ where: { id }, data: { subject: 'Geändert', totalAmount: 200 } }),
    ).resolves.toBeTruthy();
    const pos = await owner.invoicePosition.findFirstOrThrow({ where: { invoiceId: id } });
    await expect(
      owner.invoicePosition.update({ where: { id: pos.id }, data: { netAmount: 200 } }),
    ).resolves.toBeTruthy();
  });

  it('nach SENT: geschäftliche Felder sind blockiert (Betrag, Nummer, Datum)', async () => {
    const id = await makeInvoice();
    await setStatus(id, 'SENT');
    await expect(
      owner.invoice.update({ where: { id }, data: { totalAmount: 999 } }),
    ).rejects.toThrow(/Festschreibung/);
    await expect(
      owner.invoice.update({ where: { id }, data: { number: 'MANIPULIERT' } }),
    ).rejects.toThrow(/Festschreibung/);
    await expect(
      owner.invoice.update({ where: { id }, data: { issueDate: new Date('2025-01-01') } }),
    ).rejects.toThrow(/Festschreibung/);
  });

  it('nach SENT: iter102/107-Felder eingefroren (Leistungszeitraum, USt-Grund, Storno-Bezug, Reverse-Charge)', async () => {
    const id = await makeInvoice();
    await setStatus(id, 'SENT');
    await expect(
      owner.invoice.update({ where: { id }, data: { reverseCharge: true } }),
    ).rejects.toThrow(/Festschreibung/);
    await expect(
      owner.invoice.update({ where: { id }, data: { servicePeriodStart: new Date('2026-05-01') } }),
    ).rejects.toThrow(/Festschreibung/);
    await expect(
      owner.invoice.update({ where: { id }, data: { servicePeriodEnd: new Date('2026-05-31') } }),
    ).rejects.toThrow(/Festschreibung/);
    await expect(
      owner.invoice.update({ where: { id }, data: { vatExemptionReason: 'Kleinunternehmer § 19 UStG' } }),
    ).rejects.toThrow(/Festschreibung/);
    await expect(
      owner.invoice.update({ where: { id }, data: { stornoOfId: id } }),
    ).rejects.toThrow(/Festschreibung/);
  });

  it('nach SENT: Positionen sind weder änder- noch lösch- noch erweiterbar', async () => {
    const id = await makeInvoice();
    await setStatus(id, 'SENT');
    const pos = await owner.invoicePosition.findFirstOrThrow({ where: { invoiceId: id } });
    await expect(
      owner.invoicePosition.update({ where: { id: pos.id }, data: { netAmount: 1 } }),
    ).rejects.toThrow(/Festschreibung/);
    await expect(owner.invoicePosition.delete({ where: { id: pos.id } })).rejects.toThrow(/Festschreibung/);
    await expect(
      owner.invoicePosition.create({
        data: { invoiceId: id, position: 2, description: 'Nachschub', quantity: 1, unit: 'Stück', unitPrice: 1, netAmount: 1, vatRate: 19 },
      }),
    ).rejects.toThrow(/Festschreibung/);
  });

  it('nach SENT: Lebenszyklus-Felder bleiben setzbar (sentAt/paidAt)', async () => {
    const id = await makeInvoice();
    await setStatus(id, 'SENT');
    await expect(
      owner.invoice.update({ where: { id }, data: { sentAt: new Date() } }),
    ).resolves.toBeTruthy();
  });

  it('Status-Matrix: Vorwärts-Übergänge + PAID→CANCELLED (QW10), CANCELLED terminal', async () => {
    const ok = await makeInvoice();
    await expect(setStatus(ok, 'SENT')).resolves.toBeTruthy();
    await expect(setStatus(ok, 'OVERDUE')).resolves.toBeTruthy();
    await expect(setStatus(ok, 'PAID')).resolves.toBeTruthy();
    // QW10: bezahlte Rechnung ist stornierbar (§ 14c/§ 17 UStG).
    await expect(setStatus(ok, 'CANCELLED')).resolves.toBeTruthy();
    // … danach ist CANCELLED terminal.
    await expect(setStatus(ok, 'SENT')).rejects.toThrow(/Festschreibung/);

    const skip = await makeInvoice();
    await expect(setStatus(skip, 'PAID')).rejects.toThrow(/Festschreibung/); // DRAFT → PAID verboten

    const storno = await makeInvoice();
    await expect(setStatus(storno, 'CANCELLED')).resolves.toBeTruthy(); // DRAFT-Storno ok
    await expect(setStatus(storno, 'SENT')).rejects.toThrow(/Festschreibung/); // CANCELLED terminal
  });

  it('DELETE: Entwurf löschbar (inkl. Positions-Cascade), versendete Rechnung nicht', async () => {
    const draft = await makeInvoice();
    await expect(owner.invoice.delete({ where: { id: draft } })).resolves.toBeTruthy();

    const sent = await makeInvoice();
    await setStatus(sent, 'SENT');
    await expect(owner.invoice.delete({ where: { id: sent } })).rejects.toThrow(/Festschreibung/);
  });
});
