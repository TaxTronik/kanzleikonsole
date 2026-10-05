// Fachkatalog: GWG-RETENTION-DESTRUCTION-001
// P-21: Die Admin-Kachel zählt löschreife GwG-Belege per COUNT
// (dueGwgDeletionDocsWhere). Der Filter muss für jeden Fristzweig genau die
// Belege treffen, die findDueGwgDeletionDocs (JS-Fristlogik) liefert; geprüft
// unter der App-Rolle (RLS) zu mehreren Stichtagen.
import { randomUUID } from 'node:crypto';
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
};
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
    const path = new URL('../../../../apps/web/src/server/gwg/retention.ts', import.meta.url).href;
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
  }, 60_000);

  afterAll(async () => {
    try {
      if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
    } finally {
      await Promise.all([owner.$disconnect(), app.$disconnect()]);
    }
  });

  it.each([
    '2026-10-05T12:00:00Z',
    '2031-12-31T23:59:59Z',
    '2032-01-01T00:00:00Z',
    '2037-06-01T00:00:00Z',
    '2045-01-01T00:00:00Z',
  ])('zählt zum Stichtag %s genau die Belege der Review-Queue', async (iso) => {
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
});
