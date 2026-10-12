// Fachkatalog: ACCESS-TENANT-RLS-001, ACCESS-STAFF-PERMISSION-001
//
// Review-Finding P-10, Folgepunkt Welle 15: Die Titelsuche der Dokumentenseite
// (/staff/documents) lädt zweistufig (server/documents/title-search.ts). Diese
// Suite vergleicht sie gegen echtes PostgreSQL über die App-Rolle (RLS) mit der
// bisherigen einstufigen Abfrage der Seite (ILIKE unter RLS, neueste zuerst,
// Kappung mit Gesamtzahl): dieselben Dokumente samt DTO in derselben
// Reihenfolge und dieselbe Gesamtzahl je Ebene (Mandantenwurzel, Ordner,
// Kanzlei-intern, gelöscht), Begriff, Kappung und Betrachter (ADMIN,
// Mitarbeiter ohne Lohnrecht); fremde Tenants bleiben unsichtbar.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@taxtronik/db/prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '@taxtronik/db/prisma-adapter';
import type { TxClient } from '@taxtronik/db';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../packages/db/src/__tests__/gwg-test-fixture';

vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { MANAGED_DOC_SELECT } from '../managed-docs';
import { loadScopeDocumentsTx, type DocumentScope } from '../title-search';

// B-02: lokal per DOCUMENT_TITLE_SEARCH_DB_TEST=1, im db-CI-Job per DB_TESTS=1.
const enabled = process.env.DOCUMENT_TITLE_SEARCH_DB_TEST === '1' || process.env.DB_TESTS === '1';
if (!enabled && process.env.CI === 'true') {
  throw new Error(
    'DOCUMENT_TITLE_SEARCH_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}

(enabled ? describe : describe.skip)('P-10: Titelsuche der Dokumentenseite', () => {
  const owner = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
  });
  const app = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
  });
  let tenantId = '';
  let foreignTenantId = '';
  let adminId = '';
  let employeeId = '';
  let clientId = '';
  let folderId = '';
  let internalFolderId = '';

  beforeAll(async () => {
    const seed = randomUUID();
    tenantId = (
      await owner.tenant.create({ data: { slug: `p10-docs-${seed}`, name: 'P-10 Dokumente' } })
    ).id;
    foreignTenantId = (
      await owner.tenant.create({ data: { slug: `p10-docs-f-${seed}`, name: 'P-10 fremd' } })
    ).id;
    const person = async (tenant: string, role: 'ADMIN' | 'EMPLOYEE') =>
      (
        await owner.staffUser.create({
          data: {
            tenantId: tenant,
            email: `${role.toLowerCase()}-${randomUUID()}@example.test`,
            fullName: role,
            passwordHash: 'synthetic',
            roles: { create: { role } },
          },
        })
      ).id;
    adminId = await person(tenantId, 'ADMIN');
    employeeId = await person(tenantId, 'EMPLOYEE');
    clientId = (
      await owner.client.create({ data: { tenantId, kind: 'JURPERS', name: 'Akten GmbH' } })
    ).id;
    await createVerifiedLegalEntityGwgFixture(owner, {
      tenantId,
      clientId,
      verifiedBy: adminId,
      registerNumber: `HRB-${seed.slice(0, 8)}`,
    });
    await owner.client.update({ where: { id: clientId }, data: { allowActive: true } });
    folderId = (await owner.documentFolder.create({ data: { tenantId, clientId, name: 'Belege' } }))
      .id;
    internalFolderId = (
      await owner.documentFolder.create({ data: { tenantId, clientId: null, name: 'Intern' } })
    ).id;

    // Je Ebene gemischte Titel mit eindeutiger Erstellzeit; jedes 10. Dokument
    // gelöscht, jedes 7. nur mit Lohnrecht sichtbar.
    const titles = `(ARRAY['Rechnung', 'Kontoauszug', 'Lohnabrechnung', 'Vertrag kunde_1', 'Rabatt 50%'])[1 + g % 5] || ' ' || g`;
    await owner.$executeRawUnsafe(
      `INSERT INTO public.document
         (tenant_id, client_id, folder_id, title, classification, requires_payroll_access,
          mime_type, created_at, updated_at, deleted_at)
       SELECT $1::uuid, $2::uuid, CASE WHEN g % 3 = 0 THEN $3::uuid END, ${titles},
              (CASE WHEN g % 7 = 0 THEN 'PERSONNEL' ELSE 'GENERAL' END)::document_classification,
              g % 7 = 0, 'application/pdf',
              timestamp '2026-01-01' + g * interval '1 minute', now(),
              CASE WHEN g % 10 = 0 THEN now() END
         FROM generate_series(1, 600) AS g`,
      tenantId,
      clientId,
      folderId,
    );
    await owner.$executeRawUnsafe(
      `INSERT INTO public.document
         (tenant_id, client_id, folder_id, title, classification, mime_type, created_at,
          updated_at, deleted_at)
       SELECT $1::uuid, NULL, CASE WHEN g % 4 = 0 THEN $2::uuid END, ${titles}, 'GENERAL',
              'application/pdf', timestamp '2026-02-01' + g * interval '1 minute', now(),
              CASE WHEN g % 10 = 0 THEN now() END
         FROM generate_series(1, 400) AS g`,
      tenantId,
      internalFolderId,
    );
    await owner.$executeRawUnsafe(
      `INSERT INTO public.document (tenant_id, title, classification, mime_type, updated_at)
       SELECT $1::uuid, 'Rechnung fremd ' || g, 'GENERAL', 'application/pdf', now()
         FROM generate_series(1, 50) AS g`,
      foreignTenantId,
    );
  }, 600_000);

  afterAll(async () => {
    try {
      for (const tenant of [tenantId, foreignTenantId]) {
        if (tenant) await owner.tenant.delete({ where: { id: tenant } });
      }
    } finally {
      await Promise.all([owner.$disconnect(), app.$disconnect()]);
    }
  });

  function asStaff<T>(staffId: string, run: (tx: TxClient) => Promise<T>): Promise<T> {
    return app.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true),
          set_config('app.current_actor_id', ${staffId}, true),
          set_config('app.current_actor_type', 'STAFF', true)`;
        return run(tx as TxClient);
      },
      { timeout: 120_000 },
    );
  }

  /** Bisherige einstufige Abfrage der Seite (page.tsx vor Welle 15), wörtlich. */
  async function bisherigeSeite(tx: TxClient, scope: DocumentScope) {
    const docWhere = {
      tenantId: scope.tenantId,
      clientId: scope.clientId,
      folderId: scope.folderId,
      deletedAt: scope.deleted ? { not: null } : null,
      ...(scope.q ? { title: { contains: scope.q, mode: 'insensitive' as const } } : {}),
    };
    const docs = await tx.document.findMany({
      where: docWhere,
      orderBy: { createdAt: 'desc' },
      take: scope.cap,
      select: MANAGED_DOC_SELECT,
    });
    const docsTotal =
      docs.length === scope.cap ? await tx.document.count({ where: docWhere }) : docs.length;
    return { docs, docsTotal };
  }

  it(
    'liefert dieselben Dokumente, Reihenfolge und Gesamtzahl wie die bisherige Abfrage',
    { timeout: 600_000 },
    async () => {
      const ebenen = [
        { clientId, folderId: null },
        { clientId, folderId },
        { clientId: null, folderId: null },
        { clientId: null, folderId: internalFolderId },
      ];
      const begriffe = ['rechnung', 'LOHN', 'kunde_1', '50%', '12', '599', 'fremd', 'zzz', '%'];
      let verglichen = 0;
      let gekappt = 0;
      for (const staffId of [adminId, employeeId]) {
        await asStaff(staffId, async (tx) => {
          for (const ebene of ebenen) {
            for (const deleted of [false, true]) {
              for (const q of begriffe) {
                for (const cap of [1000, 25]) {
                  const scope: DocumentScope = { tenantId, ...ebene, deleted, q, cap };
                  const erwartet = await bisherigeSeite(tx, scope);
                  const neu = await loadScopeDocumentsTx(tx, scope);
                  expect(neu, JSON.stringify({ staffId, ...ebene, deleted, q, cap })).toEqual(
                    erwartet,
                  );
                  verglichen += 1;
                  if (erwartet.docsTotal > erwartet.docs.length) gekappt += 1;
                }
              }
            }
          }
        });
      }
      // Die Matrix enthält gekappte Ergebnisse (Gesamtzahl über der Kappung).
      expect(verglichen).toBe(2 * 4 * 2 * 9 * 2);
      expect(gekappt).toBeGreaterThan(10);
    },
  );

  it('blendet Lohndokumente ohne Recht und fremde Tenants aus', async () => {
    const scope: DocumentScope = {
      tenantId,
      clientId,
      folderId: null,
      deleted: false,
      q: 'lohnabrechnung',
      cap: 1000,
    };
    const admin = await asStaff(adminId, (tx) => loadScopeDocumentsTx(tx, scope));
    const employee = await asStaff(employeeId, (tx) => loadScopeDocumentsTx(tx, scope));
    expect(employee.docsTotal).toBeGreaterThan(0);
    expect(admin.docsTotal).toBeGreaterThan(employee.docsTotal);
    const lohn = await owner.document.findMany({
      where: { tenantId, requiresPayrollAccess: true },
      select: { id: true },
    });
    const gesperrt = new Set(lohn.map((row) => row.id));
    expect(employee.docs.some((doc) => gesperrt.has(doc.id))).toBe(false);
    const fremd = await asStaff(adminId, (tx) =>
      loadScopeDocumentsTx(tx, { ...scope, clientId: null, q: 'fremd' }),
    );
    expect(fremd).toEqual({ docs: [], docsTotal: 0 });
  });
});
