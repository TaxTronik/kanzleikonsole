// Fachkatalog: GWG-RETENTION-DESTRUCTION-001
// P-21: Die Admin-Kachel zählt löschreife GwG-Belege per COUNT
// (dueGwgDeletionDocsWhere). Der Filter muss für jeden Fristzweig genau die
// Belege treffen, die findDueGwgDeletionDocs (JS-Fristlogik) liefert; geprüft
// unter der App-Rolle (RLS) zu mehreren Stichtagen.
// R-02/K-01: Der Worker (gwg-expiry-check) zählt mit denselben Filtern aus
// @taxtronik/gwg. Geprüft wird zusätzlich, dass der Prüfungsfilter
// dueGwgCheckDeletionsWhere genau die Review-Queue findDueGwgCheckDeletions
// trifft und die frühere Worker-Kopie des Belegfilters dasselbe zählte.
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('GwG-Retention-Zählung braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});

type Retention = {
  findDueGwgDeletionDocs: (tx: TxClient, now: Date) => Promise<Array<{ documentId: string }>>;
  countDueGwgDeletionDocs: (tx: TxClient, now: Date) => Promise<number>;
  findDueGwgCheckDeletions: (
    tx: TxClient,
    now: Date,
  ) => Promise<Array<{ checkId: string; clientName: string }>>;
  dueGwgDeletionDocsWhere: (now: Date) => Prisma.DocumentWhereInput;
  dueGwgCheckDeletionsWhere: (now: Date) => Prisma.GwgCheckWhereInput;
};

const STICHTAGE = [
  '2026-10-05T12:00:00Z',
  '2031-12-31T23:59:59Z',
  '2032-01-01T00:00:00Z',
  '2037-06-01T00:00:00Z',
  '2045-01-01T00:00:00Z',
];

const VERIFIED = { OR: [{ status: 'VERIFIED' as const }, { verifiedAt: { not: null } }] };

/** R-02: frühere Worker-Kopie des Belegfilters (gwg-expiry-check), eingefroren als Nachweis. */
function formerWorkerDocumentWhere(now: Date): Prisma.DocumentWhereInput {
  const gwgDeletionCutoff = new Date(Date.UTC(now.getUTCFullYear() - 5, 0, 1));
  return {
    classification: 'GWG_EVIDENCE',
    deletedAt: null,
    OR: [
      { client: { mandateEndedAt: { lt: gwgDeletionCutoff } } },
      {
        createdAt: { lt: gwgDeletionCutoff },
        client: { mandateEndedAt: null, allowActive: false, onboardingCompletedAt: null },
        NOT: [
          { gwgIdDocuments: { some: { check: VERIFIED } } },
          { gwgOnboardingInvite: { is: { gwgCheck: { is: VERIFIED } } } },
        ],
      },
    ],
  };
}
let retention: Retention;
let tenantId = '';
let staffId = '';

function inTenant<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
  return app.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenantId},true), set_config('app.current_actor_id',${staffId},true), set_config('app.current_actor_type','STAFF',true)`;
    return fn(tx);
  });
}

async function client(name: string, data: Record<string, unknown> = {}) {
  const id = (await owner.client.create({ data: { tenantId, name, kind: 'JURPERS', ...data } })).id;
  // Offene Staff-Prüfung: erlaubt GWG_EVIDENCE vor Aktivierung (DB-Schranke),
  // ist aber mit keinem Beleg verknüpft und damit für die Frist ohne Belang.
  await draftCheck(id);
  return id;
}

async function draftCheck(clientId: string) {
  return owner.gwgCheck.create({
    data: {
      tenantId,
      clientId,
      status: 'DRAFT',
      legalForm: 'GmbH',
      registerNumber: 'HRB 1',
      registerAuthority: 'AG Test',
      representativeNames: ['Test'],
    },
  });
}

async function evidence(clientId: string, extra: Record<string, unknown> = {}) {
  return owner.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenantId},true), set_config('app.current_actor_id',${staffId},true), set_config('app.current_actor_type','STAFF',true)`;
    const document = await tx.document.create({
      data: {
        tenantId,
        clientId,
        title: `Beleg ${randomUUID().slice(0, 8)}`,
        classification: 'GWG_EVIDENCE',
        mimeType: 'image/jpeg',
        ...extra,
      },
    });
    return document.id;
  });
}

describeWithDatabase('GwG-Löschreife: COUNT-Filter = Fristlogik (P-21)', () => {
  beforeAll(async () => {
    // K-01: Fristlogik, Filter und Review-Queue liegen in @taxtronik/gwg (die Web-App re-exportiert).
    const path = new URL('../../../gwg/src/index.ts', import.meta.url).href;
    retention = (await import(path)) as Retention;
    const suffix = randomUUID();
    tenantId = (
      await owner.tenant.create({
        data: { slug: `gwg-retention-count-${suffix}`, name: 'Synthetic retention tenant' },
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

    // Mandat beendet: Frist ab Mandatsende.
    const ended = await client('Beendet', { mandateEndedAt: new Date('2026-03-15T00:00:00Z') });
    await evidence(ended);
    // Nie zustande gekommene Beziehung: Frist ab Erfassung des Belegs.
    const open = await client('Onboarding offen');
    await evidence(open);
    await evidence(open, { deletedAt: new Date() });
    const draft = await draftCheck(open);
    const linkedToDraft = await evidence(open);
    await owner.gwgIdDocument.create({
      data: {
        gwgCheckId: draft.id,
        type: 'PERSONALAUSWEIS',
        ownerName: 'Test',
        documentId: linkedToDraft,
      },
    });
    // Zustande gekommene Beziehung ohne Ende: Frist läuft noch nicht.
    const established = await client('Onboarding abgeschlossen', {
      onboardingCompletedAt: new Date('2026-01-10T00:00:00Z'),
    });
    await evidence(established);
    // Mit einem verifizierten Check verknüpfter Beleg (Fixture): keine Frist.
    const verifiedClient = (
      await owner.client.create({ data: { tenantId, name: 'Verifiziert', kind: 'JURPERS' } })
    ).id;
    const verified = await createVerifiedLegalEntityGwgFixture(owner as never, {
      tenantId,
      clientId: verifiedClient,
      verifiedBy: staffId,
    });
    // Beleg einer Einladung, deren Check verifiziert ist: keine Frist.
    const invite = await owner.gwgOnboardingInvite.create({
      data: {
        tenantId,
        clientId: verifiedClient,
        inviteEmail: `${suffix}@mandant.example.test`,
        inviteName: 'Mandant',
        tokenHash: randomUUID(),
        expiresAt: new Date('2026-12-31T00:00:00Z'),
        status: 'SUBMITTED',
        gwgCheckId: verified.id,
        createdByStaff: staffId,
      },
    });
    await draftCheck(verifiedClient);
    await evidence(verifiedClient, { gwgOnboardingInviteId: invite.id });
    // Einladung ohne Check: Frist ab Erfassung (wie ohne Einladung).
    const pendingInvite = await owner.gwgOnboardingInvite.create({
      data: {
        tenantId,
        clientId: open,
        inviteEmail: `${suffix}@offen.example.test`,
        inviteName: 'Offen',
        tokenHash: randomUUID(),
        expiresAt: new Date('2026-12-31T00:00:00Z'),
        boundClientRevision: 'synthetic-client-revision',
        createdByStaff: staffId,
      },
    });
    await evidence(open, { gwgOnboardingInviteId: pendingInvite.id });

    // R-02: nie zustande gekommene Erstprüfung, festgestellt 2019 — ab 2026 löschreif …
    const backdate = new Date('2019-06-01T00:00:00Z');
    const stale = await draftCheck(await client('Alte Erstprüfung'));
    // … und eine ebenso alte, deren später erfasster wirtschaftlich Berechtigter
    // (heutige Feststellung) die Frist neu beginnen lässt.
    const refreshed = await draftCheck(await client('Erstprüfung mit neuer Feststellung'));
    await owner.gwgBeneficialOwner.create({
      data: { gwgCheckId: refreshed.id, fullName: 'Synthetische Person' },
    });
    for (const check of [stale, refreshed]) {
      await owner.$executeRaw`UPDATE "gwg_check" SET "updated_at" = ${backdate} WHERE "id" = ${check.id}::uuid`;
    }
  }, 60_000);

  afterAll(async () => {
    try {
      if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
    } finally {
      await Promise.all([owner.$disconnect(), app.$disconnect()]);
    }
  });

  it.each(STICHTAGE)('zählt zum Stichtag %s genau die Belege der Review-Queue', async (iso) => {
    const now = new Date(iso);
    const [due, count] = await inTenant(async (tx) => [
      await retention.findDueGwgDeletionDocs(tx, now),
      await retention.countDueGwgDeletionDocs(tx, now),
    ]);
    expect(count).toBe(due.length);
  });

  it('deckt beide Fristzweige ab (Mandatsende und nie zustande gekommene Beziehung)', async () => {
    const atRegularDeadline = await inTenant((tx) =>
      retention.countDueGwgDeletionDocs(tx, new Date('2032-01-01T00:00:00Z')),
    );
    const beforeDeadline = await inTenant((tx) =>
      retention.countDueGwgDeletionDocs(tx, new Date('2031-12-31T23:59:59Z')),
    );
    // Mandatsende-Beleg + drei offene Belege (ohne Check, DRAFT-Check, Einladung ohne Check).
    expect(atRegularDeadline).toBe(4);
    expect(beforeDeadline).toBe(0);
  });

  it.each(STICHTAGE)(
    'zählt zum Stichtag %s genau die GwG-Prüfungen der Review-Queue (R-02)',
    async (iso) => {
      const now = new Date(iso);
      const [due, count] = await inTenant(async (tx) => [
        await retention.findDueGwgCheckDeletions(tx, now),
        await tx.gwgCheck.count({ where: retention.dueGwgCheckDeletionsWhere(now) }),
      ]);
      expect(count).toBe(due.length);
    },
  );

  it('lässt eine spätere Feststellung die Frist einer alten Erstprüfung neu beginnen (R-02)', async () => {
    const now = new Date('2026-10-05T12:00:00Z');
    const [due, count] = await inTenant(async (tx) => [
      await retention.findDueGwgCheckDeletions(tx, now),
      await tx.gwgCheck.count({ where: retention.dueGwgCheckDeletionsWhere(now) }),
    ]);
    expect(due.map((item) => item.clientName)).toEqual(['Alte Erstprüfung']);
    expect(count).toBe(1);
  });

  it.each(STICHTAGE)(
    'zählt mit der früheren Worker-Kopie zum Stichtag %s dieselben Belege (R-02)',
    async (iso) => {
      const now = new Date(iso);
      const [shared, former] = await inTenant(async (tx) => [
        await tx.document.count({ where: retention.dueGwgDeletionDocsWhere(now) }),
        await tx.document.count({ where: formerWorkerDocumentWhere(now) }),
      ]);
      expect(former).toBe(shared);
    },
  );
});
