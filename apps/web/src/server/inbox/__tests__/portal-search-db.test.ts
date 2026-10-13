// Fachkatalog: ACCESS-SEARCH-SCOPE-001, ACCESS-TENANT-RLS-001, PORTAL-INBOX-SUBMISSION-001
//
// Review-Finding P-10, Folgepunkt Welle 15: Die Suche im Posteingang des
// Mandantenportals filterte per ILIKE unter RLS. Jede Thread-Zeile des
// Mandanten durchlief zuerst die Kontakt-Policy; bei einem Mandanten mit
// 30.000 Threads dauerte eine Suche über 2 s. Diese Suite verlangt eine
// begrenzte, schnelle Antwort, dieselben Treffer wie die bisherige Abfrage,
// den Hinweis bei mehr als 500 Treffern und dass ein Portalnutzer nie
// Nachrichten anderer Mandanten oder Tenants erhält. Echtes PostgreSQL über die
// App-Rolle (RLS).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@taxtronik/db/prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '@taxtronik/db/prisma-adapter';
import type { TxClient } from '@taxtronik/db';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../packages/db/src/__tests__/gwg-test-fixture';

vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { listPortalInboxThreadsTx, type InboxListResult } from '../queries';
import { INBOX_PAGE_SIZE } from '../constants';

// B-02: lokal per PORTAL_INBOX_SEARCH_DB_TEST=1, im db-CI-Job per DB_TESTS=1.
const enabled = process.env.PORTAL_INBOX_SEARCH_DB_TEST === '1' || process.env.DB_TESTS === '1';
if (!enabled && process.env.CI === 'true') {
  throw new Error(
    'PORTAL_INBOX_SEARCH_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}

/** Threads des großen Mandanten; vorher kostete jede Zeile die Kontakt-Policy. */
const LARGE = 30_000;
/** Zeitgrenze je Suchaufruf; vorher dauerte derselbe Aufruf über 2 s. */
const MAX_MS = 1_000;

(enabled ? describe : describe.skip)('P-10: Suche im Mandantenportal-Posteingang', () => {
  const owner = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
  });
  const app = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
  });
  let tenantId = '';
  let foreignTenantId = '';
  const gross = { clientId: '', contactId: '' };
  const klein = { clientId: '', contactId: '' };
  const fremd = { clientId: '', contactId: '' };

  beforeAll(async () => {
    const seed = randomUUID();
    tenantId = (
      await owner.tenant.create({ data: { slug: `p10-portal-${seed}`, name: 'P-10 Portal' } })
    ).id;
    foreignTenantId = (
      await owner.tenant.create({ data: { slug: `p10-portal-f-${seed}`, name: 'P-10 fremd' } })
    ).id;
    const admins: Record<string, string> = {};
    for (const tenant of [tenantId, foreignTenantId]) {
      await owner.tenantSetting.create({
        data: { tenantId: tenant, key: 'portal.features', value: { clientInbox: true } },
      });
      admins[tenant] = (
        await owner.staffUser.create({
          data: {
            tenantId: tenant,
            email: `admin-${randomUUID()}@example.test`,
            fullName: 'Admin',
            passwordHash: 'synthetic',
            roles: { create: { role: 'ADMIN' } },
          },
        })
      ).id;
    }
    const mandant = async (tenant: string, name: string) => {
      const client = await owner.client.create({
        data: { tenantId: tenant, kind: 'JURPERS', name },
      });
      await createVerifiedLegalEntityGwgFixture(owner, {
        tenantId: tenant,
        clientId: client.id,
        verifiedBy: admins[tenant]!,
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
    Object.assign(gross, await mandant(tenantId, 'Groß GmbH'));
    Object.assign(klein, await mandant(tenantId, 'Klein GmbH'));
    Object.assign(fremd, await mandant(foreignTenantId, 'Fremd GmbH'));

    const threads = async (
      tenant: string,
      who: { clientId: string; contactId: string },
      count: number,
      start: string,
    ) =>
      owner.$executeRaw`
        INSERT INTO public.portal_inbox_thread
          (tenant_id, client_id, subject, created_by_contact_id, created_at, last_message_at)
        SELECT ${tenant}::uuid, ${who.clientId}::uuid,
               CASE WHEN g % 5 = 0 THEN 'Termin Jahresabschluss ' || g
                    WHEN g IN (7, 77, 777) THEN 'Zylinderkopf Reparatur ' || g
                    ELSE 'Belege Quartal ' || g END,
               ${who.contactId}::uuid, ${start}::timestamptz,
               ${start}::timestamptz + g * interval '1 minute'
          FROM generate_series(1, ${count}::int) AS g
      `;
    await threads(tenantId, gross, LARGE, '2026-01-01');
    // Dieselben Betreffe beim zweiten Mandanten und im fremden Tenant, jünger
    // als alle Threads des großen Mandanten.
    await threads(tenantId, klein, 60, '2027-01-01');
    await threads(foreignTenantId, fremd, 60, '2027-01-01');
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

  async function search(
    who: { clientId: string; contactId: string },
    filters: { query: string; page?: number },
    tenant = tenantId,
  ): Promise<{ result: InboxListResult; ms: number }> {
    const start = performance.now();
    const result = await app.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenant}, true),
          set_config('app.current_actor_id', ${who.contactId}, true),
          set_config('app.current_actor_type', 'CLIENT_CONTACT', true)`;
        return listPortalInboxThreadsTx(
          tx as TxClient,
          { tenantId: tenant, clientId: who.clientId, contactId: who.contactId },
          filters,
        );
      },
      // Großzügig, damit der alte Pfad an der Zeitgrenze statt am Abbruch scheitert.
      { timeout: 300_000, maxWait: 10_000 },
    );
    return { result, ms: performance.now() - start };
  }

  /** Erwartete Reihenfolge über die Owner-Verbindung (nur Threads des Mandanten). */
  async function expectedIds(clientId: string, term: string) {
    const rows = await owner.portalInboxThread.findMany({
      where: { tenantId, clientId, subject: { contains: term, mode: 'insensitive' } },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  it('antwortet beim großen Mandanten schnell und begrenzt', { timeout: 600_000 }, async () => {
    const selten = await search(gross, { query: 'zylinderkopf' });
    expect(selten.ms, `selten: ${Math.round(selten.ms)} ms`).toBeLessThan(MAX_MS);
    expect(selten.result.items.map((item) => item.id)).toEqual(
      await expectedIds(gross.clientId, 'zylinderkopf'),
    );
    expect(selten.result.portalSearch).toEqual({ truncated: false, limit: 500 });

    const haeufig = await search(gross, { query: 'belege' });
    expect(haeufig.ms, `häufig: ${Math.round(haeufig.ms)} ms`).toBeLessThan(MAX_MS);
    expect(haeufig.result.portalSearch).toEqual({ truncated: true, limit: 500 });
    expect(haeufig.result.total).toBe(500);
    expect(haeufig.result.totalPages).toBe(500 / INBOX_PAGE_SIZE);
    const erwartet = await expectedIds(gross.clientId, 'belege');
    expect(haeufig.result.items.map((item) => item.id)).toEqual(erwartet.slice(0, INBOX_PAGE_SIZE));
    // Letzte Seite innerhalb der Grenze; eine Seite dahinter fällt auf sie zurück.
    const letzte = await search(gross, { query: 'belege', page: 999 });
    expect(letzte.ms).toBeLessThan(MAX_MS);
    expect(letzte.result.page).toBe(500 / INBOX_PAGE_SIZE);
    expect(letzte.result.items.map((item) => item.id)).toEqual(
      erwartet.slice(500 - INBOX_PAGE_SIZE, 500),
    );
  });

  it('liefert nie Nachrichten anderer Mandanten oder Tenants und blättert wie bisher', async () => {
    // Der kleine Mandant hat dieselben Betreffe: genau seine Treffer, alle Seiten.
    const erwartet = await expectedIds(klein.clientId, 'belege');
    expect(erwartet.length).toBeGreaterThan(INBOX_PAGE_SIZE);
    const seen: string[] = [];
    for (let page = 1; page <= Math.ceil(erwartet.length / INBOX_PAGE_SIZE); page++) {
      const { result } = await search(klein, { query: 'belege', page });
      expect(result.total).toBe(erwartet.length);
      expect(result.portalSearch?.truncated).toBe(false);
      for (const item of result.items) expect(item.clientId).toBe(klein.clientId);
      seen.push(...result.items.map((item) => item.id));
    }
    expect(seen).toEqual(erwartet);

    // Großer Mandant: die jüngeren gleichnamigen Threads des kleinen Mandanten
    // und des fremden Tenants erscheinen nie.
    const { result } = await search(gross, { query: 'belege quartal 1' });
    for (const item of result.items) expect(item.clientId).toBe(gross.clientId);
    const fremde = await search(fremd, { query: 'belege' }, foreignTenantId);
    for (const item of fremde.result.items) expect(item.clientId).toBe(fremd.clientId);
    expect(fremde.result.total).toBe(47);
  });
});
