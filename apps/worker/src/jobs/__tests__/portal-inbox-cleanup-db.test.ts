// Fachkatalog: DSGVO-OPERATIONAL-RETENTION-001, DOC-UPLOAD-JOURNAL-001, ACCESS-TENANT-RLS-001
// =============================================================================
// S-01 (Folgearbeit): portal-inbox-cleanup über die App-Rolle.
//
// Ablauf offener Upload-Batches, Kandidatensuche und das Orphan-Journal laufen
// im SYSTEM-Kontext des Tenants über taxtronik_app (RLS; die SYSTEM-Policies
// des Posteingangs und von storage_orphan lassen den Job zu). Beim
// Owner-Client bleibt nur die Tenant-Liste; sie ist hier auf die Fixture-
// Tenants begrenzt. Belegt: der abgelaufene Entwurf wird EXPIRED und sein
// Staging-Objekt journalisiert wie zuvor, und die Batches eines fremden
// Tenants bleiben im Kontext von Tenant A unsichtbar.
//
// Die Entwürfe legt der Kontakt selbst über die App-Rolle an (wie im Portal).
// Nur mit ausdrücklichem Opt-in im db-Job (WORKER_DB_TEST=1); Tenants mit
// Posteingangszeilen bleiben in der Wegwerf-Datenbank (keine Löschkaskade).
// =============================================================================

import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertAppRoleConnection,
  assertLoopbackDatabases,
  createActiveClientFixture,
  createStaffFixture,
  createTenantFixture,
  ownerAccess,
  resetOwnerAccess,
  type Owner,
} from '../../__tests__/app-role-db';

const enabled = process.env['WORKER_DB_TEST'] === '1';
if (enabled) assertLoopbackDatabases('WORKER_DB_TEST');

const scope = vi.hoisted(() => ({ tenants: [] as string[] }));

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@taxtronik/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taxtronik/db')>();
  const { guardOwnerClient } = await import('../../__tests__/app-role-db');
  return {
    ...actual,
    prismaOwner: guardOwnerClient(actual.prismaOwner, ['tenant.findMany'], {
      'tenant.findMany': async () => scope.tenants.map((id) => ({ id })),
    }),
  };
});

import { prisma, withSystemContext, withTenantContext } from '@taxtronik/db';
import { runPortalInboxCleanup } from '../portal-inbox-cleanup';

const describeDb = enabled ? describe : describe.skip;
const DAY_MS = 24 * 60 * 60 * 1000;

describeDb('S-01 portal-inbox-cleanup via the app role', () => {
  let owner: Owner;
  const a = { tenant: '', client: '', contact: '', batch: '', attachment: '' };
  const b = { tenant: '', client: '', contact: '', batch: '', attachment: '' };

  /** Entwurf wie im Portal: der Kontakt legt Batch und gescannten Anhang an. */
  async function draft(fixture: typeof a, label: string) {
    fixture.tenant = await createTenantFixture(owner, label);
    const verifier = await createStaffFixture(owner, fixture.tenant, { name: `${label}-gwg` });
    // Der Posteingang verlangt einen aktiven Mandanten (allow_active).
    fixture.client = await createActiveClientFixture(owner, fixture.tenant, verifier, label);
    fixture.contact = (
      await owner.clientContact.create({
        data: {
          tenantId: fixture.tenant,
          clientId: fixture.client,
          email: `inbox-${label}-${fixture.client}@example.test`,
          fullName: 'Synthetic inbox contact',
        },
        select: { id: true },
      })
    ).id;
    await owner.tenantSetting.create({
      data: { tenantId: fixture.tenant, key: 'portal.features', value: { clientInbox: true } },
    });
    const created = await withTenantContext(
      { tenantId: fixture.tenant, actorId: fixture.contact, actorType: 'CLIENT_CONTACT' },
      async (tx) => {
        const batch = await tx.portalInboxUploadBatch.create({
          data: {
            tenantId: fixture.tenant,
            clientId: fixture.client,
            createdByContactId: fixture.contact,
            purpose: 'NEW_THREAD',
          },
        });
        const attachment = await tx.portalInboxAttachment.create({
          data: {
            tenantId: fixture.tenant,
            clientId: fixture.client,
            batchId: batch.id,
            originalName: 'beleg.pdf',
            mimeType: 'application/pdf',
            storageBucket: 'portal-inbox-staging',
            storageKey: `tenants/${fixture.tenant}/portal-inbox/${batch.id}/0`,
            sha256: Buffer.alloc(32, 0x51),
            sizeBytes: 1234n,
            position: 0,
          },
        });
        await tx.portalInboxAttachment.update({
          where: { id: attachment.id },
          data: { storageVersionId: `staging-${attachment.id}`, scanStatus: 'CLEAN' },
        });
        return { batch: batch.id, attachment: attachment.id };
      },
    );
    fixture.batch = created.batch;
    fixture.attachment = created.attachment;
  }

  beforeAll(async () => {
    owner = (await vi.importActual<typeof import('@taxtronik/db')>('@taxtronik/db')).prismaOwner;
    expect(await assertAppRoleConnection(prisma)).toBe('taxtronik_app');
    await draft(a, 'inbox-cleanup-a');
    await draft(b, 'inbox-cleanup-b');
    scope.tenants = [a.tenant];
  });

  it('lässt den Entwurf ablaufen und journalisiert das Staging-Objekt wie bisher', async () => {
    resetOwnerAccess();
    // Drei Tage später: Entwurfsfrist (24 h) und Batch-Ablauf sind überschritten.
    const result = await runPortalInboxCleanup(new Date(Date.now() + 3 * DAY_MS));

    expect(result).toEqual({
      expiredBatches: 1,
      queuedObjects: 1,
      pendingWithoutObject: 0,
      removedMissingIntents: 0,
      failed: 0,
    });
    expect(
      await owner.portalInboxUploadBatch.findUniqueOrThrow({
        where: { id: a.batch },
        select: { status: true },
      }),
    ).toEqual({ status: 'EXPIRED' });
    expect(
      await owner.storageOrphan.findMany({
        where: { tenantId: a.tenant },
        select: { source: true, storageKey: true, storageVersionId: true, failure: true },
      }),
    ).toEqual([
      {
        source: 'portal-inbox-draft-expired',
        storageKey: `tenants/${a.tenant}/portal-inbox/${a.batch}/0`,
        storageVersionId: `staging-${a.attachment}`,
        failure: 'PORTAL_INBOX_STAGING_CLEANUP_DUE',
      },
    ]);
    // Ein zweiter Lauf findet nichts Neues (das Journal ist der Abschlussbeleg).
    expect(await runPortalInboxCleanup(new Date(Date.now() + 3 * DAY_MS))).toMatchObject({
      expiredBatches: 0,
      queuedObjects: 0,
    });
    expect(ownerAccess.denied).toEqual([]);
  });

  it('zeigt im SYSTEM-Kontext von Tenant A keine Posteingangszeilen von Tenant B', async () => {
    const foreign = await withSystemContext(a.tenant, async (tx) => ({
      batches: await tx.portalInboxUploadBatch.findMany({ where: { id: b.batch } }),
      attachments: await tx.portalInboxAttachment.findMany({ where: { id: b.attachment } }),
    }));
    expect(foreign).toEqual({ batches: [], attachments: [] });
    expect(
      await owner.portalInboxUploadBatch.findUniqueOrThrow({
        where: { id: b.batch },
        select: { status: true },
      }),
    ).toEqual({ status: 'OPEN' });
  });
});
