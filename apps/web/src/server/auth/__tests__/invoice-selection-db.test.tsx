// Fachkatalog: ACCESS-CLIENT-MODE-001, ACCESS-STAFF-PERMISSION-001
// Real page query and RBAC against PostgreSQL's app role; only request auth,
// module configuration and downstream editing forms are replaced.
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
vi.mock('@/server/auth/staff', () => ({ staffAuth: vi.fn() }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/server/settings/modules', () => ({
  readModules: async () => ({ invoiceMode: fixture.mode }),
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: (ctx: unknown, run: (tx: Prisma.TransactionClient) => unknown) =>
    fixture.run(ctx, run),
}));
vi.mock('@/app/staff/(protected)/invoices/new/form', () => ({
  NewInvoiceForm: ({ clients }: { clients: Array<{ name: string }> }) =>
    'Rechnungsformular: ' + clients.map((c) => c.name).join(', '),
}));
vi.mock('@/app/staff/(protected)/invoices/new/external-form', () => ({
  ExternalInvoiceForm: ({ clients }: { clients: Array<{ name: string }> }) =>
    'Uploadformular: ' + clients.map((c) => c.name).join(', '),
}));
import NewInvoicePage from '@/app/staff/(protected)/invoices/new/page';

const enabled = Boolean(process.env.DATABASE_URL && process.env.DATABASE_APP_URL);
if (process.env.CI === 'true' && !enabled)
  throw new Error('Invoice selection tests need both database URLs in CI.');

(enabled ? describe : describe.skip)(
  'ACCESS-CLIENT-MODE-001 invoice selection with real SQL',
  () => {
    const owner = new PrismaClient({
      adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
    });
    const app = new PrismaClient({
      adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
    });
    let tenantId: string, staffId: string, confidentialId: string;

    beforeAll(async () => {
      const suffix = randomUUID();
      tenantId = (
        await owner.tenant.create({
          data: { slug: 'invoice-selection-' + suffix, name: 'Synthetic invoice selection' },
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
      } finally {
        await Promise.all([owner.$disconnect(), app.$disconnect()]);
      }
    });

    it.each(['IN_APP', 'EXTERNAL'])(
      'reveals neither unassigned client in %s mode',
      async (mode) => {
        fixture.mode = mode;
        const html = renderToStaticMarkup(await NewInvoicePage());
        expect(html).toContain('Kein auswählbarer Mandant');
        expect(html).not.toContain('Public fixture');
        expect(html).not.toContain('Confidential fixture');
        expect(html).not.toContain('/staff/clients/onboarding/new');
      },
    );

    it('offers exactly the assigned confidential client in RESTRICTED mode', async () => {
      await owner.clientResponsibility.create({
        data: { tenantId, staffId, clientId: confidentialId, role: 'HAUPTBEARBEITER' },
      });
      const html = renderToStaticMarkup(await NewInvoicePage());
      expect(html).toContain('Confidential fixture');
      expect(html).not.toContain('Public fixture');
      expect(html).not.toContain('Kein auswählbarer Mandant');
    });

    it('offers public clients and conceals unassigned confidential clients in OPEN mode', async () => {
      await owner.tenantSetting.update({
        where: { tenantId_key: { tenantId, key: 'access' } },
        data: { value: { clientAccessMode: 'OPEN' } },
      });
      const html = renderToStaticMarkup(await NewInvoicePage());
      expect(html).toContain('Public fixture');
      expect(html).not.toContain('Confidential fixture');
    });

    it('preserves the administrator override', async () => {
      fixture.session.user.roles = ['ADMIN'];
      const html = renderToStaticMarkup(await NewInvoicePage());
      expect(html).toContain('Public fixture');
      expect(html).toContain('Confidential fixture');
    });
  },
);
