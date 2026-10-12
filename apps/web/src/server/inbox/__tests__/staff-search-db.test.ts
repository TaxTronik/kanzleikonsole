// Fachkatalog: ACCESS-SEARCH-SCOPE-001, ACCESS-TENANT-RLS-001, ACCESS-STAFF-PERMISSION-001
//
// Review-Finding P-10, Folgepunkt Welle 15: Die Staff-Suche im Posteingang lief
// mit mehr als 10.000 Treffern in den Timeout. Ab dieser Grenze entfiel die
// Vorauswahl über den Trigram-Index, und Zählung und Seite prüften jede
// Thread-Zeile des Tenants unter RLS (rund 0,5 ms je Zeile; 100.000 Threads:
// 114 s). Diese Suite legt über 12.000 passende Threads an und verlangt eine
// begrenzte, schnelle Antwort: die jüngsten 500 sichtbaren Treffer, Hinweis auf
// weitere, Keyset-Blättern ohne Lücken und Doppelte, nie vertrauliche oder
// fremde Threads. Echtes PostgreSQL über die App-Rolle (RLS).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@taxtronik/db/prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '@taxtronik/db/prisma-adapter';
import type { TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../packages/db/src/__tests__/gwg-test-fixture';

vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { listStaffInboxThreadsTx, type InboxListResult } from '../queries';
import { STAFF_INBOX_SEARCH_CANDIDATE_LIMIT } from '../search';
import { INBOX_STAFF_PAGE_SIZE } from '../constants';

// B-02: lokal per STAFF_INBOX_SEARCH_DB_TEST=1, im db-CI-Job per DB_TESTS=1.
const enabled = process.env.STAFF_INBOX_SEARCH_DB_TEST === '1' || process.env.DB_TESTS === '1';
if (!enabled && process.env.CI === 'true') {
  throw new Error(
    'STAFF_INBOX_SEARCH_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}

/** Threads im Tenant; jeder fünfte passt nicht, 12.000 passen (über der früheren Grenze 10.000). */
const TOTAL = 15_000;
/** Zeitgrenze je Suchaufruf; vorher dauerte derselbe Aufruf über 15 s. */
const MAX_MS = 3_000;

(enabled ? describe : describe.skip)('P-10: Staff-Posteingangssuche mit vielen Treffern', () => {
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
  let confidentialClientId = '';
  let foreignThreadId = '';

  beforeAll(async () => {
    const seed = randomUUID();
    tenantId = (
      await owner.tenant.create({ data: { slug: `p10-inbox-${seed}`, name: 'P-10 Posteingang' } })
    ).id;
    foreignTenantId = (
      await owner.tenant.create({ data: { slug: `p10-inbox-f-${seed}`, name: 'P-10 fremd' } })
    ).id;
    for (const tenant of [tenantId, foreignTenantId]) {
      await owner.tenantSetting.create({
        data: { tenantId: tenant, key: 'portal.features', value: { clientInbox: true } },
      });
    }
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
    await owner.staffPermission.create({
      data: { staffUserId: employeeId, permission: 'PORTAL_INBOX_MANAGE' },
    });
    const foreignAdmin = await person(foreignTenantId, 'ADMIN');

    const mandant = async (tenant: string, name: string, vertraulich: boolean, by: string) => {
      const client = await owner.client.create({
        data: { tenantId: tenant, kind: 'JURPERS', name, vertraulich },
      });
      await createVerifiedLegalEntityGwgFixture(owner, {
        tenantId: tenant,
        clientId: client.id,
        verifiedBy: by,
        registerNumber: `HRB-${randomUUID().slice(0, 8)}`,
      });
      await owner.client.update({ where: { id: client.id }, data: { allowActive: true } });
      const contact = await owner.clientContact.create({
        data: {
          tenantId: tenant,
          clientId: client.id,
          email: `k-${client.id}@example.test`,
          fullName: 'Kontakt',
        },
      });
      return { clientId: client.id, contactId: contact.id };
    };
    const offen = [
      await mandant(tenantId, 'Nord GmbH', false, adminId),
      await mandant(tenantId, 'Süd GmbH', false, adminId),
      await mandant(tenantId, 'West GmbH', false, adminId),
    ];
    const vertraulich = await mandant(tenantId, 'Vertraulich GmbH', true, adminId);
    confidentialClientId = vertraulich.clientId;
    const mandanten = [...offen, vertraulich];
    const fremd = await mandant(foreignTenantId, 'Fremd GmbH', false, foreignAdmin);

    // 12.000 passende und 3.000 andere Threads, reihum über die vier Mandanten
    // (jeder vierte beim vertraulichen) und abwechselnd beim Mitarbeiter oder
    // im Teamkorb; je Minute eine neue letzte Aktivität.
    for (const [index, entry] of mandanten.entries()) {
      await owner.$executeRaw`
        INSERT INTO public.portal_inbox_thread
          (tenant_id, client_id, subject, created_by_contact_id, assigned_staff_id,
           created_at, last_message_at)
        SELECT ${tenantId}::uuid, ${entry.clientId}::uuid,
               CASE WHEN g % 5 = 0 THEN 'Rückfrage Lohn ' || g ELSE 'Belege Fahrtenbuch ' || g END,
               ${entry.contactId}::uuid,
               CASE WHEN g % 2 = 0 THEN ${employeeId}::uuid END,
               timestamptz '2026-01-01', timestamptz '2026-01-01' + g * interval '1 minute'
          FROM generate_series(1, ${TOTAL}::int) AS g
         WHERE g % 4 = ${index}
      `;
    }
    foreignThreadId = (
      await owner.portalInboxThread.create({
        data: {
          tenantId: foreignTenantId,
          clientId: fremd.clientId,
          subject: 'Belege Fahrtenbuch fremd',
          createdByContactId: fremd.contactId,
          lastMessageAt: new Date(Date.UTC(2027, 0, 1)),
        },
      })
    ).id;
    await owner.$executeRawUnsafe('ANALYZE public.portal_inbox_thread');
  }, 600_000);

  afterAll(async () => {
    try {
      for (const tenant of [tenantId, foreignTenantId]) {
        if (!tenant) continue;
        await owner.portalInboxThread.deleteMany({ where: { tenantId: tenant } });
        await owner.tenant.delete({ where: { id: tenant } });
      }
    } finally {
      await Promise.all([owner.$disconnect(), app.$disconnect()]);
    }
  });

  function session(staffId: string, role: 'ADMIN' | 'EMPLOYEE'): StaffSession {
    return { user: { tenantId, staffId, roles: [role], permissions: [] } } as never;
  }

  async function search(
    staffId: string,
    role: 'ADMIN' | 'EMPLOYEE',
    filters: { query: string; scope: 'mine' | 'team' | 'all'; cursor?: string },
  ): Promise<{ result: InboxListResult; ms: number }> {
    const start = performance.now();
    const result = await app.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true),
          set_config('app.current_actor_id', ${staffId}, true),
          set_config('app.current_actor_type', 'STAFF', true)`;
        return listStaffInboxThreadsTx(tx as TxClient, session(staffId, role), filters);
      },
      // Großzügig, damit der alte Pfad an der Zeitgrenze statt am Abbruch scheitert.
      { timeout: 300_000, maxWait: 10_000 },
    );
    return { result, ms: performance.now() - start };
  }

  /** Erwartete Trefferreihenfolge über die Owner-Verbindung (Fixture-Wissen: nur `vertraulich` ist für den Mitarbeiter gesperrt). */
  async function expectedIds(options: { hideConfidential: boolean; mineOf?: string }) {
    const rows = await owner.portalInboxThread.findMany({
      where: {
        tenantId,
        subject: { contains: 'fahrtenbuch', mode: 'insensitive' },
        ...(options.hideConfidential ? { clientId: { not: confidentialClientId } } : {}),
        ...(options.mineOf ? { assignedStaffId: options.mineOf } : {}),
      },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  it(
    'antwortet bei über 10.000 Treffern begrenzt und schnell, mit Hinweis auf weitere',
    { timeout: 600_000 },
    async () => {
      for (const [staffId, role] of [
        [adminId, 'ADMIN'],
        [employeeId, 'EMPLOYEE'],
      ] as const) {
        const { result, ms } = await search(staffId, role, { query: 'fahrtenbuch', scope: 'all' });
        expect(ms, `${role}: ${Math.round(ms)} ms`).toBeLessThan(MAX_MS);
        const expected = await expectedIds({ hideConfidential: role === 'EMPLOYEE' });
        expect(expected.length).toBeGreaterThan(STAFF_INBOX_SEARCH_CANDIDATE_LIMIT);
        expect(result.search).toMatchObject({
          truncated: true,
          limit: STAFF_INBOX_SEARCH_CANDIDATE_LIMIT,
          cursor: null,
        });
        expect(result.total).toBe(STAFF_INBOX_SEARCH_CANDIDATE_LIMIT);
        expect(result.items.map((item) => item.id)).toEqual(
          expected.slice(0, INBOX_STAFF_PAGE_SIZE),
        );
      }
    },
  );

  it(
    'blättert per Keyset lückenlos durch die jüngsten Treffer und zeigt nur Sichtbares',
    { timeout: 600_000 },
    async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const { result, ms } = await search(employeeId, 'EMPLOYEE', {
          query: 'fahrtenbuch',
          scope: 'all',
          ...(cursor ? { cursor } : {}),
        });
        expect(ms).toBeLessThan(MAX_MS);
        for (const item of result.items) {
          expect(item.clientId).not.toBe(confidentialClientId);
          expect(item.id).not.toBe(foreignThreadId);
          seen.push(item.id);
        }
        cursor = result.search?.nextCursor ?? undefined;
        pages += 1;
      } while (cursor && pages < 20);
      expect(pages).toBe(STAFF_INBOX_SEARCH_CANDIDATE_LIMIT / INBOX_STAFF_PAGE_SIZE);
      expect(seen).toEqual(
        (await expectedIds({ hideConfidential: true })).slice(
          0,
          STAFF_INBOX_SEARCH_CANDIDATE_LIMIT,
        ),
      );
    },
  );

  it('wendet den Arbeitsbereich vor der Grenze an', { timeout: 600_000 }, async () => {
    const { result, ms } = await search(employeeId, 'EMPLOYEE', {
      query: 'fahrtenbuch',
      scope: 'mine',
    });
    expect(ms).toBeLessThan(MAX_MS);
    expect(result.search?.truncated).toBe(true);
    expect(result.items.map((item) => item.id)).toEqual(
      (await expectedIds({ hideConfidential: true, mineOf: employeeId })).slice(
        0,
        INBOX_STAFF_PAGE_SIZE,
      ),
    );
    // Selektiver Begriff: genaue Zählung ohne Hinweis.
    const selective = await search(adminId, 'ADMIN', { query: 'fahrtenbuch 1234', scope: 'all' });
    expect(selective.result.search).toMatchObject({ truncated: false, nextCursor: null });
    const exact = await owner.portalInboxThread.count({
      where: { tenantId, subject: { contains: 'fahrtenbuch 1234', mode: 'insensitive' } },
    });
    expect(exact).toBeGreaterThan(0);
    expect(selective.result.total).toBe(exact);
    expect(selective.result.items).toHaveLength(exact);
  });
});
