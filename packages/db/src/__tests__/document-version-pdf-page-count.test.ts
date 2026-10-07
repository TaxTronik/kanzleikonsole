// Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001
// Fachkatalog: GWG-SELF-ONBOARDING-001
// P-13: Die Seitenzahl einer PDF-Ausweisquelle wird beim Upload an der
// Dokumentversion gespeichert. Die App-Rolle schreibt sie beim Anlegen unter
// RLS; negative Werte weist die Datenbank ab; ist der Beleg einer GwG-Prüfung
// zugeordnet, bleibt der gespeicherte Wert wie die übrige Version unveränderlich.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('PDF-Seitenzahl-Test braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});

let tenantId = '';
let staffId = '';
let clientId = '';
let checkId = '';

function inTenant<T>(client: typeof app, fn: (tx: TxClient) => Promise<T>): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenantId},true), set_config('app.current_actor_id',${staffId},true), set_config('app.current_actor_type','STAFF',true)`;
    return fn(tx);
  });
}

function evidenceWithVersion(pdfPageCount: number | null) {
  return inTenant(app, async (tx) => {
    const document = await tx.document.create({
      data: {
        tenantId,
        clientId,
        title: `Ausweis ${randomUUID().slice(0, 8)}.pdf`,
        classification: 'GWG_EVIDENCE',
        mimeType: 'application/pdf',
      },
    });
    const version = await tx.documentVersion.create({
      data: {
        documentId: document.id,
        versionNo: 1,
        storageBucket: 'taxtronik-gwg',
        storageKey: `tenants/${tenantId}/gwg/${randomUUID()}.bin`,
        storageVersionId: 'storage-version-1',
        sha256: new Uint8Array(32),
        sizeBytes: 1024n,
        // Ohne Object-Lock-Flag, damit afterAll den Tenant samt Versionen löschen kann.
        immutable: false,
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
        pdfPageCount,
        createdById: staffId,
      },
    });
    return { documentId: document.id, versionId: version.id };
  });
}

describeWithDatabase('document_version.pdf_page_count (P-13)', () => {
  beforeAll(async () => {
    const suffix = randomUUID();
    tenantId = (
      await owner.tenant.create({
        data: { slug: `pdf-page-count-${suffix}`, name: 'Synthetic page count tenant' },
      })
    ).id;
    staffId = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `${suffix}@example.test`,
          fullName: 'Synthetic staff',
          passwordHash: 'x',
          roles: { create: { role: 'ADMIN' } },
        },
      })
    ).id;
    clientId = (
      await owner.client.create({ data: { tenantId, name: 'Onboarding offen', kind: 'NATPERS' } })
    ).id;
    // Offene Staff-Prüfung: erlaubt GWG_EVIDENCE vor der Aktivierung (DB-Schranke).
    checkId = (
      await owner.gwgCheck.create({
        data: {
          tenantId,
          clientId,
          status: 'DRAFT',
          legalForm: null,
          representativeNames: [],
        },
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    try {
      if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
    } finally {
      await Promise.all([owner.$disconnect(), app.$disconnect()]);
    }
  });

  it('speichert die beim Upload ermittelte Seitenzahl unter der App-Rolle', async () => {
    const { versionId } = await evidenceWithVersion(2);
    const stored = await inTenant(app, (tx) =>
      tx.documentVersion.findUnique({ where: { id: versionId }, select: { pdfPageCount: true } }),
    );
    expect(stored?.pdfPageCount).toBe(2);
    const legacy = await evidenceWithVersion(null);
    const unknown = await inTenant(app, (tx) =>
      tx.documentVersion.findUnique({
        where: { id: legacy.versionId },
        select: { pdfPageCount: true },
      }),
    );
    expect(unknown?.pdfPageCount).toBeNull();
  });

  it('weist eine negative Seitenzahl ab', async () => {
    await expect(evidenceWithVersion(-1)).rejects.toThrow(
      /document_version_pdf_page_count_check|check constraint/i,
    );
  });

  it('hält die Seitenzahl eines zugeordneten GwG-Belegs unveränderlich', async () => {
    const { documentId, versionId } = await evidenceWithVersion(1);
    await owner.gwgIdDocument.create({
      data: { gwgCheckId: checkId, type: 'PERSONALAUSWEIS', ownerName: 'Test', documentId },
    });
    await expect(
      inTenant(app, (tx) =>
        tx.documentVersion.update({ where: { id: versionId }, data: { pdfPageCount: 5 } }),
      ),
    ).rejects.toThrow(/unveraenderlich/);
    const stored = await owner.documentVersion.findUnique({
      where: { id: versionId },
      select: { pdfPageCount: true },
    });
    expect(stored?.pdfPageCount).toBe(1);
  });

  // Migration 20261007160000: Der Nachtrag (Worker-Job pdf-page-count-backfill)
  // schreibt Seitenzahl und Prüfmarke unter der App-Rolle im System-Kontext.
  it('lässt den Nachtrag Seitenzahl und Prüfmarke einer nicht zugeordneten Version setzen', async () => {
    const legacy = await evidenceWithVersion(null);
    const unreadable = await evidenceWithVersion(null);
    const checkedAt = new Date('2026-10-07T04:30:00.000Z');
    const asSystem = <T>(fn: (tx: TxClient) => Promise<T>) =>
      app.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenantId},true), set_config('app.current_actor_id','',true), set_config('app.current_actor_type','SYSTEM',true)`;
        return fn(tx);
      });
    await asSystem((tx) =>
      tx.documentVersion.update({
        where: { id: legacy.versionId },
        data: { pdfPageCount: 3, pdfPageCountCheckedAt: checkedAt },
      }),
    );
    // Nicht lesbar: nur die Prüfmarke, die Seitenzahl bleibt NULL.
    await asSystem((tx) =>
      tx.documentVersion.update({
        where: { id: unreadable.versionId },
        data: { pdfPageCountCheckedAt: checkedAt },
      }),
    );
    const stored = await owner.documentVersion.findMany({
      where: { id: { in: [legacy.versionId, unreadable.versionId] } },
      select: { id: true, pdfPageCount: true, pdfPageCountCheckedAt: true },
    });
    expect(Object.fromEntries(stored.map((row) => [row.id, row]))).toEqual({
      [legacy.versionId]: {
        id: legacy.versionId,
        pdfPageCount: 3,
        pdfPageCountCheckedAt: checkedAt,
      },
      [unreadable.versionId]: {
        id: unreadable.versionId,
        pdfPageCount: null,
        pdfPageCountCheckedAt: checkedAt,
      },
    });
  });
});
