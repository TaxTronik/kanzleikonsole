// Fachkatalog: YEAR-END-CAMPAIGN-001
// P-19 gegen echtes PostgreSQL mit der App-Rolle: gesammelter Rollout (createMany)
// besteht die Scope-/Schema-Trigger, bleibt idempotent und atomar; die
// Übersicht zählt per groupBy dieselben Phasen wie campaignSubmissionPhase.
// Der Bearbeitungsfortschritt wird beim Speichern im selben Update persistiert
// (auch bei parallelen Speicherungen konsistent), ein Trigger verwirft ihn bei
// Antwortänderungen ohne Neuberechnung, und der Backfill der Migration
// entspricht formAnswerProgress.
// Opt-in (YEAR_END_DB_TEST=1) wie die übrigen Web-DB-Tests.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@taxtronik/db/prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '@taxtronik/db/prisma-adapter';
import type { TenantContext, TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';

const fx = vi.hoisted(() => ({
  session: null as StaffSession | null,
  portalSession: null as unknown,
  run: async (
    _ctx: TenantContext,
    _run: (tx: TxClient) => unknown,
    _options?: object,
  ): Promise<unknown> => undefined,
}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => fx.session }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => fx.portalSession }));
vi.mock('@/server/rate-limit', () => ({
  checkRateLimit: async () => ({ ok: true }),
  checkPortalWriteLimit: async () => ({ ok: true }),
}));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: async () => undefined }));
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
import { saveSubmissionDraftAction } from '@/app/portal/(protected)/forms/[id]/actions';
import { answerProgressColumns, storedAnswerProgress } from '@/server/forms/answer-progress';
import { freezeFormSchema } from '@/server/forms/schema-snapshot';
import { campaignSubmissionPhase, formAnswerProgress } from '../dashboard-policy';
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

/** Backfill-Anweisung genau so, wie die Migration sie ausführt. */
function migrationBackfill(): string {
  const migration = readFileSync(
    new URL(
      '../../../../../../packages/db/prisma/migrations/20261007160100_form_submission_answer_progress/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const start = migration.indexOf('-- P-19 Backfill (Anfang)');
  const end = migration.indexOf('-- P-19 Backfill (Ende).');
  if (start < 0 || end < start) throw new Error('Backfill-Abschnitt der Migration fehlt.');
  return migration.slice(start, end).trim().replace(/;$/, '');
}

const FIELD_DEFAULTS = {
  options: null,
  helpText: null,
  defaultValue: null,
  minValue: null,
  maxValue: null,
};
type FieldType = Parameters<typeof freezeFormSchema>[0]['fields'][number]['type'];
function frozen(fields: Array<[key: string, type: FieldType, required: boolean]>) {
  return freezeFormSchema({
    name: 'Checkliste',
    description: null,
    introMd: null,
    fields: fields.map(([key, type, required]) => ({
      ...FIELD_DEFAULTS,
      id: randomUUID(),
      key,
      label: key.toUpperCase(),
      type,
      required,
    })),
  }) as object;
}
/** Eingabefelder: a (Pflicht), b (Zahl), c (Pflicht-Checkbox), dazu ein INFO_TEXT. */
const PROGRESS_SNAPSHOT = frozen([
  ['a', 'TEXT', true],
  ['hinweis', 'INFO_TEXT', false],
  ['b', 'NUMBER', false],
  ['c', 'CHECKBOX', true],
]);

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
  let contactId = '';
  const clientIds: string[] = [];

  /** Kampagne mit dem eingefrorenen Vorlagenstand oder einem vorgegebenen Snapshot. */
  async function newCampaign(schemaSnapshot?: object) {
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
        schemaSnapshot: schemaSnapshot ?? (freezeFormSchema(template) as object),
        dueAt: new Date('2026-12-31T22:59:00Z'),
        createdByStaff: staffId,
      },
    });
  }

  async function rolledOutSubmission(schemaSnapshot: object, clientId: string) {
    const campaign = await newCampaign(schemaSnapshot);
    expect(await rollout(campaign.id, [clientId])).toEqual({ ok: true });
    const entry = await owner.yearEndCampaignEntry.findFirstOrThrow({
      where: { campaignId: campaign.id },
    });
    return { campaign, submissionId: entry.submissionId };
  }

  function loadSubmission(id: string) {
    return owner.formSubmission.findUniqueOrThrow({ where: { id } });
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
    contactId = (
      await owner.clientContact.create({
        data: {
          tenantId,
          clientId: clientIds[1]!,
          email: `kontakt-${suffix}@example.test`,
          fullName: 'Synthetic contact',
        },
      })
    ).id;
    fx.session = {
      user: { tenantId, staffId, roles: ['ADMIN'], permissions: [] },
    } as unknown as StaffSession;
    fx.portalSession = { user: { tenantId, contactId, clientId: clientIds[1]! } };
    // Akteur aus dem Kontext: Staff-Actions als STAFF, Portal-Actions als CLIENT_CONTACT.
    fx.run = async (ctx, run, options) =>
      app.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenantId},true), set_config('app.current_actor_id',${ctx.actorId ?? ''},true), set_config('app.current_actor_type',${ctx.actorType},true)`;
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
      // P-19: Startfortschritt (0 von 1 Pflichtfeld) mit dem Rollout gespeichert.
      expect(storedAnswerProgress(entry.submission)).toEqual(
        formAnswerProgress(campaign.schemaSnapshot, {}),
      );
      expect(storedAnswerProgress(entry.submission)).toMatchObject({ filled: 0, total: 1 });
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

  it('speichert den Fortschritt bei parallelen Portal-Speicherungen passend zu den Antworten', async () => {
    const { campaign, submissionId } = await rolledOutSubmission(PROGRESS_SNAPSHOT, clientIds[1]!);
    const drafts: Array<Record<string, unknown>> = [
      { a: 'Mara' },
      { a: 'Mara', b: 0 },
      {},
      { a: 'Mara', b: 3, c: true },
      { b: 7, c: false },
      { a: '  ', c: true },
      { a: 'Mara', c: false },
      { b: 1 },
    ];
    // Je Runde laufen alle Entwürfe gleichzeitig; die Zeilensperre der Action
    // serialisiert sie, der zuletzt committete gewinnt Antworten UND Fortschritt.
    for (let round = 0; round < 3; round++) {
      const order = round % 2 === 0 ? drafts : [...drafts].reverse();
      const results = await Promise.all(
        order.map((answers) => saveSubmissionDraftAction({ submissionId, answers })),
      );
      expect(results).toEqual(order.map(() => ({ ok: true })));
      const row = await loadSubmission(submissionId);
      expect(drafts).toContainEqual(row.answers);
      expect(row.status).toBe('DRAFT');
      expect(row.answerProgressAt).not.toBeNull();
      expect(storedAnswerProgress(row)).toEqual(
        formAnswerProgress(row.schemaSnapshot, row.answers),
      );
    }

    // Die Übersicht liest den gespeicherten Wert.
    const overview = (await fx.run(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      (tx) =>
        loadYearEndOverviewTx(tx, fx.session!, {
          page: 1,
          campaignId: campaign.id,
          entryPage: 1,
        }) as Promise<unknown>,
    )) as Awaited<ReturnType<typeof loadYearEndOverviewTx>>;
    const row = await loadSubmission(submissionId);
    expect(overview.progress.get(submissionId)).toEqual(storedAnswerProgress(row));
  });

  it('verwirft gespeicherten Fortschritt, wenn ein Schreibpfad Antworten ohne Neuberechnung ändert', async () => {
    const { campaign, submissionId } = await rolledOutSubmission(PROGRESS_SNAPSHOT, clientIds[1]!);
    const writers = [
      ...[{ a: 'Mara' }, { a: 'Mara', b: 2, c: true }, { b: 4 }].map(
        (answers) => () => saveSubmissionDraftAction({ submissionId, answers }),
      ),
      // Wie die DSGVO-Anonymisierung: nur die Antworten, ohne Fortschritt.
      ...[{ anonymized: true }, { a: 'Ohne Neuberechnung' }].map(
        (answers) => () =>
          owner.formSubmission.update({ where: { id: submissionId }, data: { answers } }),
      ),
    ];
    for (let round = 0; round < 3; round++) {
      await Promise.all((round % 2 === 0 ? writers : [...writers].reverse()).map((w) => w()));
      const row = await loadSubmission(submissionId);
      const stored = storedAnswerProgress(row);
      // Entweder kein gespeicherter Wert oder genau der der aktuellen Antworten.
      if (stored !== undefined) {
        expect(stored).toEqual(formAnswerProgress(row.schemaSnapshot, row.answers));
      }
    }

    await owner.formSubmission.update({
      where: { id: submissionId },
      data: { answers: { a: 'Ohne Neuberechnung' } },
    });
    expect(storedAnswerProgress(await loadSubmission(submissionId))).toBeUndefined();
    // Statusänderung ohne Antwortänderung behält den Wert; Neuberechnung im selben Update auch.
    const answers = { a: 'Mara', c: true };
    await owner.formSubmission.update({
      where: { id: submissionId },
      data: { answers, ...answerProgressColumns(await loadSubmission(submissionId), answers) },
    });
    await owner.formSubmission.update({ where: { id: submissionId }, data: { status: 'DRAFT' } });
    const kept = await loadSubmission(submissionId);
    expect(storedAnswerProgress(kept)).toEqual(formAnswerProgress(PROGRESS_SNAPSHOT, answers));
    // Ohne gespeicherten Wert rechnet die Übersicht selbst, mit demselben Ergebnis.
    await owner.formSubmission.update({
      where: { id: submissionId },
      data: { answers: { a: 'Mara', b: 5 } },
    });
    const overview = (await fx.run(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      (tx) =>
        loadYearEndOverviewTx(tx, fx.session!, {
          page: 1,
          campaignId: campaign.id,
          entryPage: 1,
        }) as Promise<unknown>,
    )) as Awaited<ReturnType<typeof loadYearEndOverviewTx>>;
    expect(overview.progress.get(submissionId)).toEqual(
      formAnswerProgress(PROGRESS_SNAPSHOT, { a: 'Mara', b: 5 }),
    );
    // Die Datenbank lehnt widersprüchliche Zahlen ab.
    await expect(
      owner.formSubmission.update({
        where: { id: submissionId },
        data: {
          ...answerProgressColumns(await loadSubmission(submissionId), {}),
          answerProgressFilled: 4,
        },
      }),
    ).rejects.toThrow(/form_submission_answer_progress_check/);
  });

  it('trägt per Migration genau dort nach, wo formAnswerProgress ohne Feldvalidierung feststeht', async () => {
    const valid = frozen([
      ['a', 'TEXT', true],
      ['hinweis', 'INFO_TEXT', false],
      ['b', 'NUMBER', false],
      ['c', 'CHECKBOX', true],
    ]) as { fields: Array<Record<string, unknown>> } & Record<string, unknown>;
    const field = valid.fields[0]!;
    const { helpText: _helpText, ...withoutHelpText } = field;
    const { description: _description, ...withoutDescription } = valid;
    const variants: Record<string, { snapshot: object; backfilled: boolean; answers?: object }> = {
      gültig: { snapshot: valid, backfilled: true },
      ohneFelder: { snapshot: { ...valid, fields: [] }, backfilled: true },
      mitAntworten: { snapshot: valid, backfilled: false, answers: { a: 'Mara' } },
      feldOhneHilfetext: { snapshot: { ...valid, fields: [withoutHelpText] }, backfilled: false },
      unbekannterTyp: {
        snapshot: { ...valid, fields: [{ ...field, type: 'SIGNATUR' }] },
        backfilled: false,
      },
      pflichtAlsText: {
        snapshot: { ...valid, fields: [{ ...field, required: 'true' }] },
        backfilled: false,
      },
      ohneBeschreibung: { snapshot: withoutDescription, backfilled: false },
      feldKeinObjekt: { snapshot: { ...valid, fields: ['a'] }, backfilled: false },
    };
    const ids: Record<string, string> = {};
    for (const [name, variant] of Object.entries(variants)) {
      ids[name] = (await rolledOutSubmission(variant.snapshot, clientIds[2]!)).submissionId;
      if (variant.answers) {
        await owner.formSubmission.update({
          where: { id: ids[name] },
          data: { answers: variant.answers },
        });
      }
    }
    const all = Object.values(ids);
    // Altbestand ohne gespeicherten Wert.
    await owner.$executeRaw`
      UPDATE form_submission
         SET answer_progress_at = NULL, answer_progress_filled = NULL, answer_progress_total = NULL,
             answer_progress_required_filled = NULL, answer_progress_required_total = NULL
       WHERE id = ANY(${all}::uuid[])`;
    const before = await owner.formSubmission.findMany({ where: { id: { in: all } } });

    // Backfill in einer zurückgerollten Transaktion: keine Wirkung über den Test hinaus.
    let after: typeof before = [];
    await expect(
      owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(migrationBackfill());
        after = await tx.formSubmission.findMany({ where: { id: { in: all } } });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    for (const [name, variant] of Object.entries(variants)) {
      const row = after.find((candidate) => candidate.id === ids[name])!;
      const previous = before.find((candidate) => candidate.id === ids[name])!;
      const expected = formAnswerProgress(row.schemaSnapshot, row.answers);
      if (variant.backfilled) {
        expect(expected, name).not.toBeNull();
        expect(storedAnswerProgress(row), name).toEqual(expected);
      } else {
        expect(row.answerProgressAt, name).toBeNull();
        // Übersprungen nur, wo Antworten vorliegen oder das Schema nicht lesbar ist.
        expect(variant.answers !== undefined || expected === null, name).toBe(true);
      }
      expect(row.updatedAt, name).toEqual(previous.updatedAt);
      expect(row.answers, name).toEqual(previous.answers);
    }
    expect(
      (await owner.formSubmission.findMany({ where: { id: { in: all } } })).every(
        (row) => row.answerProgressAt === null,
      ),
    ).toBe(true);
  });
});
