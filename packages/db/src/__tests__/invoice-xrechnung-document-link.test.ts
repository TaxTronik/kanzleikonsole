import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';

const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260823190000_invoice_xrechnung_document_link/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('Invoice → kanonisches XRechnung-Dokument', () => {
  it('modelliert einen nullable 1:1-FK und macht keinen titelbasierten Legacy-Backfill', () => {
    expect(schema).toContain('xrechnungDocumentId String?');
    expect(schema).toContain('@relation("InvoiceXrechnungDocument"');
    expect(migration).toContain('ADD COLUMN "xrechnung_document_id" UUID');
    expect(migration).toContain('ON DELETE SET NULL ON UPDATE NO ACTION');
    expect(migration).toContain('CREATE UNIQUE INDEX "invoice_xrechnung_document_unique"');
    expect(migration).not.toMatch(/UPDATE\s+"invoice"[\s\S]*title/iu);
  });

  it('sichert Link und referenziertes Dokument reziprok und RLS-unabhängig ab', () => {
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('FOR SHARE');
    expect(migration).toContain('CREATE TRIGGER "invoice_xrechnung_document_scope"');
    expect(migration).toContain('CREATE TRIGGER "xrechnung_document_invoice_scope"');
    expect(migration).toContain('BEFORE UPDATE OF');
    expect(migration).toContain('REVOKE ALL ON FUNCTION');
    expect(migration).toContain('OWNER TO CURRENT_USER');
  });
});

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
const describeWithDatabase = hasDatabase ? describe : describe.skip;

describeWithDatabase('XRechnung-FK unter echter Owner- und App-Rolle', () => {
  const owner = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
  });
  const app = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
  });

  const tenantIds: string[] = [];
  let tenantId: string;
  let staffId: string;
  let invoiceId: string;
  let canonicalDocumentId: string;
  let raceDocumentId: string;
  let otherClientDocumentId: string;
  let foreignTenantDocumentId: string;

  async function createActiveClient(input: {
    tenantId: string;
    staffId: string;
    suffix: string;
    name: string;
  }) {
    const client = await owner.client.create({
      data: { tenantId: input.tenantId, kind: 'JURPERS', name: input.name, allowActive: false },
    });
    await createVerifiedLegalEntityGwgFixture(owner, {
      tenantId: input.tenantId,
      clientId: client.id,
      verifiedBy: input.staffId,
      registerNumber: `HRB-XR-${input.suffix}`,
    });
    await owner.client.update({ where: { id: client.id }, data: { allowActive: true } });
    return client;
  }

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tenant = await owner.tenant.create({
      data: { slug: `xrechnung-link-${suffix}`, name: 'XRechnung Link Test' },
    });
    tenantId = tenant.id;
    tenantIds.push(tenant.id);
    const staff = await owner.staffUser.create({
      data: {
        tenantId,
        email: `xrechnung-${suffix}@example.test`,
        fullName: 'XRechnung Test',
        passwordHash: 'x',
      },
    });
    staffId = staff.id;
    const client = await createActiveClient({
      tenantId,
      staffId,
      suffix: `${suffix}-own`,
      name: 'Eigener Mandant',
    });
    const otherClient = await createActiveClient({
      tenantId,
      staffId,
      suffix: `${suffix}-other`,
      name: 'Anderer Mandant',
    });

    const foreignTenant = await owner.tenant.create({
      data: { slug: `xrechnung-foreign-${suffix}`, name: 'Fremder Tenant' },
    });
    tenantIds.push(foreignTenant.id);
    const foreignStaff = await owner.staffUser.create({
      data: {
        tenantId: foreignTenant.id,
        email: `xrechnung-foreign-${suffix}@example.test`,
        fullName: 'Fremder XRechnung Test',
        passwordHash: 'x',
      },
    });
    const foreignClient = await createActiveClient({
      tenantId: foreignTenant.id,
      staffId: foreignStaff.id,
      suffix: `${suffix}-foreign`,
      name: 'Fremder Tenant-Mandant',
    });

    canonicalDocumentId = (
      await owner.document.create({
        data: {
          tenantId,
          clientId: client.id,
          title: 'Kanonische XRechnung',
          classification: 'GOBD_INVOICE',
          mimeType: 'application/xml',
        },
      })
    ).id;
    raceDocumentId = (
      await owner.document.create({
        data: {
          tenantId,
          clientId: client.id,
          title: 'Parallel mutierte XRechnung',
          classification: 'GOBD_INVOICE',
          mimeType: 'application/xml',
        },
      })
    ).id;
    otherClientDocumentId = (
      await owner.document.create({
        data: {
          tenantId,
          clientId: otherClient.id,
          title: 'Gleichnamige fremde XRechnung',
          classification: 'GOBD_INVOICE',
          mimeType: 'application/xml',
        },
      })
    ).id;
    foreignTenantDocumentId = (
      await owner.document.create({
        data: {
          tenantId: foreignTenant.id,
          clientId: foreignClient.id,
          title: 'Tenant-fremde XRechnung',
          classification: 'GOBD_INVOICE',
          mimeType: 'application/xml',
        },
      })
    ).id;
    invoiceId = (
      await owner.invoice.create({
        data: {
          tenantId,
          clientId: client.id,
          number: `XR-${suffix}`,
          issueDate: new Date('2026-08-23T00:00:00.000Z'),
          dueDate: new Date('2026-09-06T00:00:00.000Z'),
          format: 'XRECHNUNG',
          subject: 'XRechnung-Test',
          netAmount: '100.00',
          vatAmount: '19.00',
          totalAmount: '119.00',
          vatRate: '19.00',
          createdByStaff: staffId,
        },
      })
    ).id;
  });

  afterAll(async () => {
    for (const id of tenantIds.reverse()) {
      await owner.tenant.delete({ where: { id } }).catch(() => undefined);
    }
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  });

  async function asStaff<T>(run: (tx: Prisma.TransactionClient) => Promise<T>) {
    return app.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('app.current_tenant_id', ${tenantId}, true),
               set_config('app.current_actor_id', ${staffId}, true),
               set_config('app.current_actor_type', ${'STAFF'}, true)
      `;
      return run(tx);
    });
  }

  it('akzeptiert nur das exakt passende Dokument und blockiert spätere Scope-Mutationen', async () => {
    await expect(
      asStaff((tx) =>
        tx.invoice.update({
          where: { id: invoiceId },
          data: { xrechnungDocumentId: otherClientDocumentId },
        }),
      ),
    ).rejects.toThrow(/Foreign key constraint|Archivgrenze/);

    await expect(
      asStaff((tx) =>
        tx.invoice.update({
          where: { id: invoiceId },
          data: { xrechnungDocumentId: foreignTenantDocumentId },
        }),
      ),
    ).rejects.toThrow(/Foreign key constraint|Archivgrenze/);

    let releaseMutation!: () => void;
    let mutationHasRowLock!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      mutationHasRowLock = resolve;
    });
    const mutate = owner.$transaction(async (tx) => {
      await tx.document.update({
        where: { id: raceDocumentId },
        data: { mimeType: 'text/xml' },
      });
      mutationHasRowLock();
      await release;
    });
    await locked;

    const concurrentLink = asStaff((tx) =>
      tx.invoice.update({
        where: { id: invoiceId },
        data: { xrechnungDocumentId: raceDocumentId },
      }),
    );
    const earlyState = await Promise.race([
      concurrentLink.then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
    ]);
    expect(earlyState).toBe('blocked');
    releaseMutation();
    await mutate;
    await expect(concurrentLink).rejects.toThrow(/Foreign key constraint|Archivgrenze/);

    await asStaff((tx) =>
      tx.invoice.update({
        where: { id: invoiceId },
        data: { xrechnungDocumentId: canonicalDocumentId },
      }),
    );

    await expect(
      asStaff((tx) =>
        tx.document.update({
          where: { id: canonicalDocumentId },
          data: { mimeType: 'text/xml' },
        }),
      ),
    ).rejects.toThrow(/Foreign key constraint|Archivgrenze/);
    await expect(
      owner.document.update({
        where: { id: canonicalDocumentId },
        data: { deletedAt: new Date() },
      }),
    ).rejects.toThrow(/Foreign key constraint|Archivgrenze/);

    // Detach-vor-Softdelete ist der absichtlich erlaubte Cleanup-Pfad.
    await asStaff(async (tx) => {
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { xrechnungDocumentId: null },
      });
      await tx.document.update({
        where: { id: canonicalDocumentId },
        data: { deletedAt: new Date() },
      });
    });
  });

  it('führt beide Trigger als Tabellen-Owner aus und gewährt keinen Direktaufruf', async () => {
    const functions = await owner.$queryRaw<
      Array<{ name: string; securityDefiner: boolean; functionOwner: string; tableOwner: string }>
    >`
      SELECT p.proname AS "name",
             p.prosecdef AS "securityDefiner",
             pg_get_userbyid(p.proowner) AS "functionOwner",
             t.tableowner AS "tableOwner"
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN pg_tables t
       WHERE n.nspname = 'app'
         AND p.proname IN (
           'enforce_invoice_xrechnung_document_scope',
           'enforce_xrechnung_document_invoice_scope'
         )
         AND t.schemaname = 'public'
         AND t.tablename = 'invoice'
       ORDER BY p.proname
    `;
    expect(functions).toHaveLength(2);
    for (const fn of functions) {
      expect(fn.securityDefiner).toBe(true);
      expect(fn.functionOwner).toBe(fn.tableOwner);
    }

    const privileges = await owner.$queryRaw<Array<{ callable: boolean }>>`
      SELECT has_function_privilege(
        'taxtronik_app',
        'app.enforce_invoice_xrechnung_document_scope()',
        'EXECUTE'
      ) OR has_function_privilege(
        'taxtronik_app',
        'app.enforce_xrechnung_document_invoice_scope()',
        'EXECUTE'
      ) AS "callable"
    `;
    expect(privileges).toEqual([{ callable: false }]);
  });
});
