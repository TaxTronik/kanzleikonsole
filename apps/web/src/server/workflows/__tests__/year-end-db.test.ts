// Fachkatalog: YEAR-END-CAMPAIGN-001
// P-19 gegen echtes PostgreSQL mit der App-Rolle: gesammelter Rollout (createMany)
// besteht die Scope-/Schema-Trigger, bleibt idempotent und atomar; die
// Übersicht zählt per groupBy dieselben Phasen wie campaignSubmissionPhase.
// Opt-in (YEAR_END_DB_TEST=1) wie die übrigen Web-DB-Tests.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@taxtronik/db/prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '@taxtronik/db/prisma-adapter';
import type { TenantContext, TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';

const fx = vi.hoisted(() => ({
  session: null as StaffSession | null,
  run: async (
    _ctx: TenantContext,
    _run: (tx: TxClient) => unknown,
    _options?: object,
  ): Promise<unknown> => undefined,
}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => fx.session }));
vi.mock('@/server/db/prisma-owner', () => ({ prismaOwner: {} }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: (ctx: TenantContext, run: (tx: TxClient) => unknown, options?: object) =>
    fx.run(ctx, run, options),
}));
vi.mock('@taxtronik/db/tenant-context', () => ({
  withTenantContext: (ctx: TenantContext, run: (tx: TxClient) => unknown, options?: object) =>
    fx.run(ctx, run, options),
}));
// Die Audit-Kette ist nicht Gegenstand dieses Tests; ohne Audit-Zeilen lässt
// sich der synthetische Tenant am Ende vollständig entfernen.
vi.mock('@/server/container', () => ({ evidenceService: { record: async () => undefined } }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

import { rolloutCampaignAction } from '@/app/staff/(protected)/year-end/actions';
import { freezeFormSchema } from '@/server/forms/schema-snapshot';
import { campaignSubmissionPhase } from '../dashboard-policy';
import { ENTRIES_PER_PAGE, loadYearEndOverviewTx } from '../year-end-overview';

const enabled = process.env.YEAR_END_DB_TEST === '1';
if (enabled) {
  for (const name of ['DATABASE_URL', 'DATABASE_APP_URL']) {
    const url = new URL(process.env[name] ?? '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname.length < 2) {
      throw new Error(`YEAR_END_DB_TEST requires a loopback PostgreSQL ${name}.`);
    }
  }
}

const CLIENTS = ENTRIES_PER_PAGE + 5;

(enabled ? describe : describe.skip)('YEAR-END-CAMPAIGN-001 gegen PostgreSQL (P-19)', () => {
  const owner = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
  });
  const app = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
  });
  let tenantId = '';
  let staffId = '';
  let templateId = '';
  let blockedClientId = '';
  const clientIds: string[] = [];

  async function newCampaign() {
    const template = await owner.formTemplate.findUniqueOrThrow({
      where: { id: templateId },
      include: { fields: { orderBy: { position: 'asc' } } },
    });
    return owner.yearEndCampaign.create({
      data: {
        tenantId,
        name: `Jahreswechsel ${randomUUID().slice(0, 8)}`,
        year: 2026,
        templateId,
        schemaSnapshot: freezeFormSchema(template) as object,
        dueAt: new Date('2026-12-31T22:59:00Z'),
        createdByStaff: staffId,
      },
    });
  }

  function rollout(campaignId: string, ids: string[]) {
    const data = new FormData();
    data.set('campaignId', campaignId);
    for (const id of ids) data.append('clientId', id);
    return rolloutCampaignAction(data);
  }

  beforeAll(async () => {
    const { createVerifiedLegalEntityGwgFixture } =
      await import('../../../../../../packages/db/src/__tests__/gwg-test-fixture');
    const suffix = randomUUID();
    tenantId = (
      await owner.tenant.create({
        data: { slug: `year-end-db-${suffix}`, name: 'Synthetic year-end tenant' },
      })
    ).id;
    staffId = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `${suffix}@example.test`,
          fullName: 'Synthetic administrator',
          passwordHash: 'x',
          roles: { create: { role: 'ADMIN' } },
        },
      })
    ).id;
    await owner.tenantSetting.create({
      data: { tenantId, key: 'modules', value: { yearEndCampaigns: true, forms: true } },
    });
    templateId = (
      await owner.formTemplate.create({
        data: {
          tenantId,
          name: 'Checkliste',
          active: true,
          createdByStaff: staffId,
          fields: { create: [{ key: 'a', label: 'A', type: 'TEXT', required: true, position: 0 }] },
        },
      })
    ).id;
    for (let i = 0; i < CLIENTS; i++) {
      const id = (
        await owner.client.create({
          data: { tenantId, name: `Mandant ${String(i).padStart(3, '0')}`, kind: 'JURPERS' },
        })
      ).id;
      await createVerifiedLegalEntityGwgFixture(owner as never, {
        tenantId,
        clientId: id,
        verifiedBy: staffId,
      });
      await owner.client.update({ where: { id }, data: { allowActive: true } });
      clientIds.push(id);
    }
    blockedClientId = (
      await owner.client.create({ data: { tenantId, name: 'Ohne Freischaltung', kind: 'JURPERS' } })
    ).id;
    fx.session = {
      user: { tenantId, staffId, roles: ['ADMIN'], permissions: [] },
    } as unknown as StaffSession;
    fx.run = async (_ctx, run, options) =>
      app.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenantId},true), set_config('app.current_actor_id',${staffId},true), set_config('app.current_actor_type','STAFF',true)`;
          return run(tx);
        },
        { timeout: 15_000, maxWait: 5_000, ...options },
      );
  }, 120_000);

  afterAll(async () => {
    try {
      if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
    } finally {
      await Promise.all([owner.$disconnect(), app.$disconnect()]);
    }
  });

  it('legt verknüpfte Zeilen gesammelt an und überspringt bereits zugeordnete Mandanten', async () => {
    const campaign = await newCampaign();

    expect(await rollout(campaign.id, clientIds.slice(0, 10))).toEqual({ ok: true });
    expect(await rollout(campaign.id, clientIds)).toEqual({ ok: true });
    expect(await rollout(campaign.id, clientIds)).toEqual({ ok: true });

    const entries = await owner.yearEndCampaignEntry.findMany({
      where: { campaignId: campaign.id },
      include: { submission: true, request: true },
    });
    expect(entries).toHaveLength(CLIENTS);
    for (const entry of entries) {
      expect(entry.submission.requestId).toBe(entry.requestId);
      expect(entry.request.formSubmissionId).toBe(entry.submissionId);
      expect(entry.submission.schemaSnapshot).toEqual(campaign.schemaSnapshot);
      expect(entry.submission.status).toBe('PENDING');
      expect(entry.request).toMatchObject({
        clientId: entry.clientId,
        title: `${campaign.name} 2026`,
        status: 'OPEN',
        dueAt: campaign.dueAt,
      });
    }
  });

  it('rollt bei einem nicht freigeschalteten Mandanten den ganzen Lauf zurück', async () => {
    const campaign = await newCampaign();

    expect(await rollout(campaign.id, [clientIds[0]!, blockedClientId])).toEqual({
      ok: false,
      error: 'Mandant ohne freigeschaltetes Portal.',
    });
    expect(await owner.yearEndCampaignEntry.count({ where: { campaignId: campaign.id } })).toBe(0);
    expect(
      await owner.formSubmission.count({ where: { tenantId, name: `${campaign.name} 2026` } }),
    ).toBe(0);
  });

  it('zählt in der Übersicht per groupBy dieselben Phasen wie die Einzelanzeige', async () => {
    const campaign = await newCampaign();
    expect(await rollout(campaign.id, clientIds)).toEqual({ ok: true });
    const entries = await owner.yearEndCampaignEntry.findMany({
      where: { campaignId: campaign.id },
      orderBy: { client: { name: 'asc' } },
    });
    const submittedAt = new Date('2026-11-02T09:00:00Z');
    const setSubmission = (i: number, data: object) =>
      owner.formSubmission.update({ where: { id: entries[i]!.submissionId }, data });
    const setRequest = (i: number, status: 'CLOSED' | 'CANCELLED') =>
      owner.request.update({ where: { id: entries[i]!.requestId }, data: { status } });
    await setSubmission(0, { status: 'DRAFT' });
    await setSubmission(1, { status: 'DRAFT', submittedAt });
    await setSubmission(2, { status: 'SUBMITTED', submittedAt });
    await setSubmission(3, { status: 'REVIEWED', submittedAt });
    await setRequest(4, 'CLOSED');
    await setRequest(5, 'CANCELLED');
    await setSubmission(6, { status: 'SUBMITTED', submittedAt });
    await setRequest(6, 'CANCELLED');

    const overview = await fx.run(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      (tx) =>
        loadYearEndOverviewTx(tx, fx.session!, {
          page: 1,
          campaignId: campaign.id,
          entryPage: 2,
        }) as Promise<unknown>,
    );
    const data = overview as Awaited<ReturnType<typeof loadYearEndOverviewTx>>;

    const all = await owner.yearEndCampaignEntry.findMany({
      where: { campaignId: campaign.id },
      include: { submission: true, request: true },
    });
    const expected: Record<string, number> = {};
    for (const entry of all) {
      const phase = campaignSubmissionPhase(entry.submission, entry.request.status);
      expected[phase] = (expected[phase] ?? 0) + 1;
    }
    const counts = Object.fromEntries(
      Object.entries(data.phaseCounts.get(campaign.id)!).filter(([, n]) => n > 0),
    );
    expect(counts).toEqual(expected);
    expect(Object.keys(expected).sort()).toEqual(
      ['CANCELLED', 'CLOSED', 'IN_PROGRESS', 'PENDING', 'RETURNED', 'REVIEWED', 'SUBMITTED'].sort(),
    );
    // Zweite Eintragsseite dieser Kampagne: die restlichen Mandanten nach Namen.
    expect(data.entryPages.get(campaign.id)).toBe(2);
    expect(data.entriesByCampaign.get(campaign.id)!.map((entry) => entry.client.name)).toEqual(
      clientIds
        .slice(ENTRIES_PER_PAGE)
        .map((_, i) => `Mandant ${String(ENTRIES_PER_PAGE + i).padStart(3, '0')}`),
    );
  });
});
