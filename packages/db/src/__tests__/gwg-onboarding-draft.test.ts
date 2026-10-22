// Fachkatalog: GWG-SELF-ONBOARDING-001
// Zwischenstand der Online-Einreichung: Mandantentrennung, Grenzen des Inhalts
// und Löschen, sobald die Einladung widerrufen, abgelöst oder die Prüfung
// vernichtet wird. Eine abgelaufene, nie eingereichte Einladung behält ihn.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import { dbAbgewiesen } from '../testing/db-fehler';

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});
let tenantId: string;
let clientId: string;
let staffId: string;

type AppTx = Parameters<Parameters<typeof app.$transaction>[0]>[0];

/** Wie withSystemContext: App-Rolle mit gesetztem Tenant. */
function asTenant<T>(tenant: string, run: (tx: AppTx) => Promise<T>): Promise<T> {
  return app.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('app.current_tenant_id', ${tenant}, true),
             set_config('app.current_actor_id', '', true),
             set_config('app.current_actor_type', 'SYSTEM', true)
    `;
    return run(tx);
  });
}

beforeAll(async () => {
  const stamp = Date.now();
  tenantId = (
    await owner.tenant.create({
      data: { slug: `gwg-draft-${stamp}`, name: 'GwG Zwischenstand Test' },
    })
  ).id;
  staffId = (
    await owner.staffUser.create({
      data: {
        tenantId,
        email: `gwg-draft-${stamp}@example.test`,
        fullName: 'GwG Zwischenstand Test',
        passwordHash: 'x',
      },
    })
  ).id;
  clientId = (
    await owner.client.create({
      data: { tenantId, kind: 'JURPERS', name: 'Zwischenstand GmbH', allowActive: false },
    })
  ).id;
});

afterAll(async () => {
  if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

/** Offene Einladung mit Zwischenstand, angelegt über die App-Rolle. */
async function inviteWithDraft() {
  const invite = await owner.gwgOnboardingInvite.create({
    data: {
      tenantId,
      clientId,
      inviteEmail: `draft-${randomUUID()}@example.test`,
      inviteName: 'Erika Muster',
      tokenHash: `token-${randomUUID()}`,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      status: 'STARTED',
      boundClientRevision: 'revision',
      createdByStaff: staffId,
      uploadedDocumentIds: [],
    },
  });
  await asTenant(tenantId, (tx) =>
    tx.gwgOnboardingDraft.create({
      data: { inviteId: invite.id, tenantId, payload: { version: 1, step: 1 } },
    }),
  );
  return invite.id;
}

const draftCount = (inviteId: string) => owner.gwgOnboardingDraft.count({ where: { inviteId } });

describe('gwg_onboarding_draft', () => {
  it('ist nur im eigenen Mandanten sichtbar', async () => {
    const inviteId = await inviteWithDraft();
    expect(
      await asTenant(tenantId, (tx) => tx.gwgOnboardingDraft.count({ where: { inviteId } })),
    ).toBe(1);
    expect(
      await asTenant(randomUUID(), (tx) => tx.gwgOnboardingDraft.count({ where: { inviteId } })),
    ).toBe(0);
  });

  it('nimmt nur ein JSON-Objekt mit positiver Revision an', async () => {
    const inviteId = await inviteWithDraft();
    const payloadCheck = { sqlState: '23514', meldung: /gwg_onboarding_draft_payload_check/ };
    await dbAbgewiesen(
      asTenant(tenantId, (tx) =>
        tx.gwgOnboardingDraft.update({ where: { inviteId }, data: { payload: [1, 2] } }),
      ),
      payloadCheck,
    );
    await dbAbgewiesen(
      asTenant(tenantId, (tx) =>
        tx.gwgOnboardingDraft.update({ where: { inviteId }, data: { revision: 0 } }),
      ),
      { sqlState: '23514', meldung: /gwg_onboarding_draft_revision_check/ },
    );
    await dbAbgewiesen(
      asTenant(tenantId, (tx) =>
        tx.gwgOnboardingDraft.update({
          where: { inviteId },
          data: { payload: { text: 'x'.repeat(140_000) } },
        }),
      ),
      payloadCheck,
    );
  });

  it('löscht den Zwischenstand, wenn die Kanzlei die Einladung zurückzieht oder ablöst', async () => {
    const inviteId = await inviteWithDraft();
    await asTenant(tenantId, (tx) =>
      tx.gwgOnboardingInvite.updateMany({
        where: { id: inviteId, status: { in: ['PENDING', 'STARTED'] } },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledByStaff: staffId,
          tokenHash: '',
        },
      }),
    );
    expect(await draftCount(inviteId)).toBe(0);
  });

  it('löscht den Zwischenstand bei der Vernichtung der Prüfung', async () => {
    const inviteId = await inviteWithDraft();
    await asTenant(tenantId, (tx) =>
      tx.gwgOnboardingInvite.update({
        where: { id: inviteId },
        data: { tokenHash: `vernichtet-${inviteId}` },
      }),
    );
    expect(await draftCount(inviteId)).toBe(0);
  });

  it('behält den Zwischenstand einer abgelaufenen, nie eingereichten Einladung', async () => {
    const inviteId = await inviteWithDraft();
    await asTenant(tenantId, (tx) =>
      tx.gwgOnboardingInvite.update({ where: { id: inviteId }, data: { status: 'EXPIRED' } }),
    );
    expect(await draftCount(inviteId)).toBe(1);
  });

  it('löscht den Zwischenstand mit der Einladung', async () => {
    const inviteId = await inviteWithDraft();
    await owner.gwgOnboardingInvite.delete({ where: { id: inviteId } });
    expect(await draftCount(inviteId)).toBe(0);
  });
});
