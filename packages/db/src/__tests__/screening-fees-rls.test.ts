// Fachkatalog: GWG-SCREENING-001
// Fachkatalog: STBVV-CALCULATION-001
// Fachkatalog: ACCESS-STAFF-PERMISSION-001
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import type { Prisma } from '@prisma/client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
});
let tenantId: string,
  otherTenantId: string,
  staffId: string,
  deniedId: string,
  clientId: string,
  otherClientId: string,
  runId: string,
  quoteId: string;
async function actor<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  id = staffId,
  tenant = tenantId,
  type = 'STAFF',
) {
  return app.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenant},true),set_config('app.current_actor_id',${id},true),set_config('app.current_actor_type',${type},true)`;
    return fn(tx);
  });
}
const quoteData = (createdBy = staffId) => ({
  tenantId,
  clientId,
  title: 'Synthetic quote',
  lawVersion: 'synthetic-test',
  inputs: {},
  result: {},
  createdBy,
});
describe('screening and fee evidence real database boundaries', () => {
  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    tenantId = (
      await owner.tenant.create({
        data: { name: 'Screening fee RLS', slug: `screening-fees-${suffix}` },
      })
    ).id;
    otherTenantId = (
      await owner.tenant.create({
        data: { name: 'Other screening fee RLS', slug: `screening-fees-other-${suffix}` },
      })
    ).id;
    for (const name of ['allowed', 'denied']) {
      const s = await owner.staffUser.create({
        data: {
          tenantId,
          email: `${name}-${suffix}@example.test`,
          fullName: name,
          passwordHash: 'synthetic',
          roles: { create: { role: 'EMPLOYEE' } },
        },
      });
      if (name === 'allowed') staffId = s.id;
      else deniedId = s.id;
    }
    await owner.staffPermission.create({
      data: { staffUserId: staffId, permission: 'INVOICE_MANAGE', grantedBy: staffId },
    });
    clientId = (
      await owner.client.create({ data: { tenantId, name: 'Synthetic client', kind: 'NATPERS' } })
    ).id;
    otherClientId = (
      await owner.client.create({
        data: { tenantId, name: 'Other synthetic client', kind: 'NATPERS' },
      })
    ).id;
    runId = (
      await actor((tx) =>
        tx.screeningRun.create({
          data: {
            tenantId,
            clientId,
            kind: 'PEP',
            subject: { name: 'Synthetic subject' },
            result: { method: 'MANUAL_RESEARCH' },
            createdBy: staffId,
          },
        }),
      )
    ).id;
    quoteId = (await actor((tx) => tx.stbvvQuote.create({ data: quoteData() }))).id;
  });
  // The isolated integration database owns these immutable fixtures. Do not bypass evidence triggers to clean them up.
  afterAll(async () => {
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  });
  it('denies portal, foreign-tenant and subsequently restricted-client reads', async () => {
    expect(
      await actor(
        (tx) => tx.screeningRun.findUnique({ where: { id: runId } }),
        staffId,
        tenantId,
        'CLIENT_CONTACT',
      ),
    ).toBeNull();
    expect(
      await actor(
        (tx) => tx.stbvvQuote.findUnique({ where: { id: quoteId } }),
        staffId,
        otherTenantId,
      ),
    ).toBeNull();
    await owner.client.update({ where: { id: clientId }, data: { vertraulich: true } });
    try {
      expect(await actor((tx) => tx.screeningRun.findUnique({ where: { id: runId } }))).toBeNull();
      expect(await actor((tx) => tx.stbvvQuote.findUnique({ where: { id: quoteId } }))).toBeNull();
    } finally {
      await owner.client.update({ where: { id: clientId }, data: { vertraulich: false } });
    }
  });
  it('requires the current invoice grant at the SQL insert boundary', async () => {
    await expect(
      actor((tx) => tx.stbvvQuote.create({ data: quoteData(deniedId) }), deniedId),
    ).rejects.toThrow();
    await owner.staffPermission.delete({
      where: { staffUserId_permission: { staffUserId: staffId, permission: 'INVOICE_MANAGE' } },
    });
    try {
      await expect(actor((tx) => tx.stbvvQuote.create({ data: quoteData() }))).rejects.toThrow();
    } finally {
      await owner.staffPermission.create({
        data: { staffUserId: staffId, permission: 'INVOICE_MANAGE' },
      });
    }
  });
  it('rejects impersonated authors and a review linked to another client', async () => {
    await expect(
      actor((tx) => tx.stbvvQuote.create({ data: quoteData(deniedId) })),
    ).rejects.toThrow();
    await expect(
      actor((tx) =>
        tx.screeningReview.create({
          data: {
            tenantId,
            clientId: otherClientId,
            runId,
            outcome: 'PEP_NOT_FOUND',
            note: 'Synthetic documented research.',
            sources: ['https://example.test/source'],
            createdBy: staffId,
          },
        }),
      ),
    ).rejects.toThrow();
  });
  it('keeps snapshots immutable and does not grant truncate as an RLS bypass', async () => {
    await expect(
      actor((tx) =>
        tx.screeningRun.update({ where: { id: runId }, data: { subject: { name: 'Changed' } } }),
      ),
    ).rejects.toThrow();
    await expect(
      owner.stbvvQuote.update({ where: { id: quoteId }, data: { result: { changed: true } } }),
    ).rejects.toThrow('Immutable snapshot');
    const rows = await actor(
      (tx) =>
        tx.$queryRaw<
          Array<{ allowed: boolean }>
        >`SELECT has_table_privilege(current_user,'screening_run','TRUNCATE') OR has_table_privilege(current_user,'stbvv_quote','TRUNCATE') AS allowed`,
    );
    expect(rows[0]?.allowed).toBe(false);
  });
  it('does not let ordinary staff replace the official source state', async () => {
    await expect(
      actor((tx) => tx.sanctionsSourceState.create({ data: { tenantId, checkedAt: new Date() } })),
    ).rejects.toThrow();
  });
  it('runs the actual fee export advisory lock through Prisma without deserializing PostgreSQL void', async () => {
    // Dynamic path preserves the db package rootDir while testing the production helper.
    const helperPath = new URL('../../../../apps/web/src/server/stbvv/lock.ts', import.meta.url)
      .href;
    const { lockFeeQuoteExportTx } = await import(helperPath);
    await actor(async (tx) => {
      await lockFeeQuoteExportTx(tx, quoteId);
      await lockFeeQuoteExportTx(tx, quoteId);
      expect(await tx.stbvvQuote.findUnique({ where: { id: quoteId } })).not.toBeNull();
    });
  });
  it('stores official-source snapshots and idempotent follow-ups through all real Prisma locks', async () => {
    const helperPath = new URL('../../../tax/src/screening/persistence.ts', import.meta.url).href;
    const { storeSanctionsSnapshot, followupSanctions } = await import(helperPath);
    const entries = [
      {
        id: 'synthetic-1',
        euReference: 'synthetic-EU-1',
        type: 'person',
        names: [{ name: 'Synthetic subject', strong: true }],
        birthDates: [],
        countries: [],
        regulations: [],
      },
    ];
    const source = {
      sha256: 'a'.repeat(64),
      sourceUrl: 'https://example.test/synthetic-source',
      sourceVersion: 'synthetic-1',
      publishedAt: new Date('2026-08-05'),
      entries,
    };
    const first = await actor<{ snapshot: { id: string } }>(
      (tx) => storeSanctionsSnapshot(tx, tenantId, source),
      staffId,
      tenantId,
      'SYSTEM',
    );
    const original = await actor((tx) =>
      tx.screeningRun.create({
        data: {
          tenantId,
          clientId,
          kind: 'EU',
          snapshotId: first.snapshot.id,
          createdBy: staffId,
          subject: { name: 'Synthetic subject', role: 'Mandant' },
          result: { status: 'CANDIDATES' },
        },
      }),
    );
    const updated = await actor<{ snapshot: { id: string } }>(
      (tx) =>
        storeSanctionsSnapshot(tx, tenantId, {
          ...source,
          sha256: 'b'.repeat(64),
          sourceVersion: 'synthetic-2',
          publishedAt: new Date('2026-08-06'),
        }),
      staffId,
      tenantId,
      'SYSTEM',
    );
    const firstBatch = await actor<{ created: Array<{ candidates: boolean }> }>(
      (tx) => followupSanctions(tx, tenantId, updated.snapshot.id, entries),
      staffId,
      tenantId,
      'SYSTEM',
    );
    const repeated = await actor<{ created: Array<{ candidates: boolean }> }>(
      (tx) => followupSanctions(tx, tenantId, updated.snapshot.id, entries),
      staffId,
      tenantId,
      'SYSTEM',
    );
    expect(firstBatch.created).toHaveLength(1);
    expect(firstBatch.created[0]?.candidates).toBe(true);
    expect(repeated.created).toEqual([]);
    expect(await actor((tx) => tx.screeningRun.findUnique({ where: { id: original.id } }))).toEqual(
      expect.objectContaining({ snapshotId: first.snapshot.id, previousRunId: null }),
    );
  });
});
