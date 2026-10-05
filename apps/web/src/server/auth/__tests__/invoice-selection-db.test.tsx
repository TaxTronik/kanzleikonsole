// Fachkatalog: ACCESS-CLIENT-MODE-001, ACCESS-STAFF-PERMISSION-001, ACCESS-SEARCH-SCOPE-001
// Real page query, client search route and RBAC against PostgreSQL's app role;
// only request auth, rate limiting, module configuration and downstream
// editing forms are replaced.
import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@taxtronik/db/prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '@taxtronik/db/prisma-adapter';
import type { Prisma } from '@prisma/client';
import type { StaffSession } from '@/server/auth/staff';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../packages/db/src/__tests__/gwg-test-fixture';

const fixture = vi.hoisted(() => ({
  session: {} as StaffSession,
  mode: 'IN_APP',
  run: async (_ctx: unknown, _run: (tx: Prisma.TransactionClient) => unknown): Promise<unknown> =>
    undefined,
}));
vi.mock('@/server/auth/staff-page', () => ({ requireStaffPage: async () => fixture.session }));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => fixture.session }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/server/rate-limit', () => ({
  checkStaffClientPickerLimit: async () => ({ ok: true, remaining: 1, retryAfter: 0 }),
}));
vi.mock('@/server/settings/modules', () => ({
  readModules: async () => ({ invoiceMode: fixture.mode }),
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: (ctx: unknown, run: (tx: Prisma.TransactionClient) => unknown) =>
    fixture.run(ctx, run),
}));
// Die Formulare suchen Mandanten selbst über GET /api/staff/clients/search.
vi.mock('@/app/staff/(protected)/invoices/new/form', () => ({
  NewInvoiceForm: () => 'Rechnungsformular',
}));
vi.mock('@/app/staff/(protected)/invoices/new/external-form', () => ({
  ExternalInvoiceForm: () => 'Uploadformular',
}));
import NewInvoicePage from '@/app/staff/(protected)/invoices/new/page';
import { GET as searchClients } from '@/app/api/staff/clients/search/route';

// Quality has URL placeholders but no database service. The required db-job
// step opts in explicitly; missing/invalid URLs must then fail, never skip.
const enabled = process.env.INVOICE_SELECTION_DB_TEST === '1';
if (enabled) {
  for (const name of ['DATABASE_URL', 'DATABASE_APP_URL']) {
    let url: URL;
    try {
      url = new URL(process.env[name] ?? '');
    } catch {
      throw new Error(`INVOICE_SELECTION_DB_TEST requires a valid ${name}.`);
    }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.pathname.length < 2) {
      throw new Error(`INVOICE_SELECTION_DB_TEST requires a PostgreSQL ${name} with a database.`);
    }
  }
}

async function searchNames(params: Record<string, string>): Promise<string[]> {
  const response = await searchClients({
    nextUrl: { searchParams: new URLSearchParams(params) },
  } as never);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { clients: Array<{ name: string }> };
  return body.clients.map((client) => client.name);
}

(enabled ? describe : describe.skip)(
  'ACCESS-CLIENT-MODE-001 invoice selection with real SQL',
  () => {
    const owner = new PrismaClient({
      adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
    });
    const app = new PrismaClient({
      adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
    });
    let tenantId: string, foreignTenantId: string, staffId: string, confidentialId: string;

    beforeAll(async () => {
      const suffix = randomUUID();
      tenantId = (
        await owner.tenant.create({
          data: { slug: 'invoice-selection-' + suffix, name: 'Synthetic invoice selection' },
        })
      ).id;
      foreignTenantId = (
        await owner.tenant.create({
          data: { slug: 'invoice-selection-foreign-' + suffix, name: 'Synthetic foreign tenant' },
        })
      ).id;
      staffId = (
        await owner.staffUser.create({
          data: {
            tenantId,
            email: suffix + '@example.test',
            fullName: 'Synthetic employee',
            passwordHash: 'x',
            roles: { create: { role: 'EMPLOYEE' } },
          },
        })
      ).id;
      for (const [name, vertraulich] of [
        ['Public fixture', false],
        ['Confidential fixture', true],
      ] as const) {
        const client = await owner.client.create({
          data: { tenantId, kind: 'JURPERS', name, vertraulich },
        });
        await createVerifiedLegalEntityGwgFixture(owner, {
          tenantId,
          clientId: client.id,
          verifiedBy: staffId,
          registerNumber: 'HRB-' + suffix,
        });
        await owner.client.update({ where: { id: client.id }, data: { allowActive: true } });
        if (vertraulich) confidentialId = client.id;
      }
      // Nicht freigegeben (GwG offen) und ein gleichnamiger fremder Tenant.
      await owner.client.create({ data: { tenantId, kind: 'NATPERS', name: 'Pending fixture' } });
      await owner.client.create({
        data: { tenantId: foreignTenantId, kind: 'NATPERS', name: 'Foreign fixture' },
      });
      fixture.run = async (_ctx, run) =>
        app.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenantId},true), set_config('app.current_actor_id',${staffId},true), set_config('app.current_actor_type','STAFF',true)`;
          return run(tx);
        });
    });

    beforeEach(async () => {
      fixture.mode = 'IN_APP';
      fixture.session = {
        user: {
          tenantId,
          staffId,
          roles: ['EMPLOYEE'],
          permissions: ['INVOICE_MANAGE', 'INVOICE_SEND'],
        },
      } as StaffSession;
      await owner.clientResponsibility.deleteMany({ where: { tenantId } });
      await owner.tenantSetting.upsert({
        where: { tenantId_key: { tenantId, key: 'access' } },
        create: { tenantId, key: 'access', value: { clientAccessMode: 'RESTRICTED' } },
        update: { value: { clientAccessMode: 'RESTRICTED' } },
      });
    });

    afterAll(async () => {
      try {
        if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
        if (foreignTenantId) await owner.tenant.delete({ where: { id: foreignTenantId } });
      } finally {
        await Promise.all([owner.$disconnect(), app.$disconnect()]);
      }
    });

    async function openMode() {
      await owner.tenantSetting.update({
        where: { tenantId_key: { tenantId, key: 'access' } },
        data: { value: { clientAccessMode: 'OPEN' } },
      });
    }

    it.each(['IN_APP', 'EXTERNAL'])(
      'reveals neither unassigned client in %s mode',
      async (mode) => {
        fixture.mode = mode;
        const html = renderToStaticMarkup(await NewInvoicePage());
        expect(html).toContain('Kein auswählbarer Mandant');
        expect(html).not.toContain('Public fixture');
        expect(html).not.toContain('Confidential fixture');
        expect(html).not.toContain('/staff/clients/onboarding/new');
        expect(await searchNames({ q: 'fixture', filter: 'active' })).toEqual([]);
      },
    );

    it('offers exactly the assigned confidential client in RESTRICTED mode', async () => {
      await owner.clientResponsibility.create({
        data: { tenantId, staffId, clientId: confidentialId, role: 'HAUPTBEARBEITER' },
      });
      const html = renderToStaticMarkup(await NewInvoicePage());
      expect(html).toContain('Rechnungsformular');
      expect(html).not.toContain('Kein auswählbarer Mandant');
      // Die Seite selbst liefert keinen Bestand mehr aus.
      expect(html).not.toContain('fixture');
      expect(await searchNames({ q: 'fixture', filter: 'active' })).toEqual([
        'Confidential fixture',
      ]);
      // Ohne Suchbegriff: die eigene Zuordnung.
      expect(await searchNames({ filter: 'active' })).toEqual(['Confidential fixture']);
    });

    it('does not find a confidential client for an unassigned employee in OPEN mode', async () => {
      await openMode();
      const html = renderToStaticMarkup(await NewInvoicePage());
      expect(html).toContain('Rechnungsformular');
      expect(await searchNames({ q: 'fixture', filter: 'active' })).toEqual(['Public fixture']);
      expect(await searchNames({ q: 'confidential' })).toEqual([]);
    });

    it('keeps the inclusion rule of each picker and never crosses tenants', async () => {
      await openMode();
      // Ohne Filter (z. B. Wiedervorlage): auch GwG-offene, freigegebene zuerst.
      expect(await searchNames({ q: 'fixture' })).toEqual(['Public fixture', 'Pending fixture']);
      expect(await searchNames({ q: 'fixture', filter: 'active' })).toEqual(['Public fixture']);
      fixture.session.user.roles = ['ADMIN'];
      expect(await searchNames({ q: 'fixture' })).toEqual([
        'Confidential fixture',
        'Public fixture',
        'Pending fixture',
      ]);
    });

    it('preserves the administrator override', async () => {
      fixture.session.user.roles = ['ADMIN'];
      const html = renderToStaticMarkup(await NewInvoicePage());
      expect(html).toContain('Rechnungsformular');
      expect(html).not.toContain('Kein auswählbarer Mandant');
      expect(await searchNames({ q: 'fixture', filter: 'active' })).toEqual([
        'Confidential fixture',
        'Public fixture',
      ]);
    });
  },
);
