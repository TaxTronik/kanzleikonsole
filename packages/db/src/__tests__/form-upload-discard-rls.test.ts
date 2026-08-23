import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
const describeWithDatabase = hasDatabase ? describe : describe.skip;

describeWithDatabase('Formular-Upload-Journal ueber die echte App-Rolle', () => {
  const owner = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
  });
  const app = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
  });

  let tenantId: string;
  let contactId: string;
  let clientId: string;
  let foreignContactId: string;
  let submissionId: string;
  let requestId: string;
  let documentId: string;
  let storageKey: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tenant = await owner.tenant.create({
      data: { slug: `form-discard-${suffix}`, name: 'Form Upload Discard RLS' },
    });
    tenantId = tenant.id;
    const staff = await owner.staffUser.create({
      data: {
        tenantId,
        email: `staff-${suffix}@example.test`,
        fullName: 'Formular-Test',
        passwordHash: 'x',
      },
    });
    const client = await owner.client.create({
      data: { tenantId, kind: 'JURPERS', name: 'Formular GmbH', allowActive: false },
    });
    clientId = client.id;
    await createVerifiedLegalEntityGwgFixture(owner, {
      tenantId,
      clientId: client.id,
      verifiedBy: staff.id,
      registerNumber: `HRB-${suffix}`,
    });
    await owner.client.update({ where: { id: client.id }, data: { allowActive: true } });

    contactId = (
      await owner.clientContact.create({
        data: {
          tenantId,
          clientId: client.id,
          email: `portal-${suffix}@example.test`,
          fullName: 'Portal Kontakt',
        },
      })
    ).id;
    const foreignClient = await owner.client.create({
      data: { tenantId, kind: 'NATPERS', name: 'Fremder Mandant', allowActive: false },
    });
    foreignContactId = (
      await owner.clientContact.create({
        data: {
          tenantId,
          clientId: foreignClient.id,
          email: `fremd-${suffix}@example.test`,
          fullName: 'Fremder Portal Kontakt',
        },
      })
    ).id;

    const template = await owner.formTemplate.create({
      data: {
        tenantId,
        name: `Upload ${suffix}`,
        createdByStaff: staff.id,
        fields: {
          create: { position: 0, key: 'beleg', label: 'Beleg', type: 'FILE' },
        },
      },
    });
    const submission = await owner.formSubmission.create({
      data: {
        tenantId,
        templateId: template.id,
        clientId: client.id,
        name: 'Self-Onboarding',
        status: 'DRAFT',
        createdByStaff: staff.id,
      },
    });
    submissionId = submission.id;
    const request = await owner.request.create({
      data: {
        tenantId,
        clientId: client.id,
        title: 'Unterlagen einreichen',
        description: 'Bitte Beleg hochladen.',
        status: 'OPEN',
        createdByStaff: staff.id,
        formSubmissionId: submission.id,
      },
    });
    requestId = request.id;
    await owner.formSubmission.update({
      where: { id: submission.id },
      data: { requestId: request.id },
    });
    storageKey = `tenants/${tenantId}/none/2026/08/form-upload.bin`;
    documentId = (
      await owner.document.create({
        data: {
          tenantId,
          clientId: client.id,
          title: 'beleg.pdf',
          classification: 'GENERAL',
          mimeType: 'application/pdf',
          formSubmissionId: submission.id,
          formFieldKey: 'beleg',
          versions: {
            create: {
              versionNo: 1,
              storageBucket: 'taxtronik-general',
              storageKey,
              storageVersionId: 'version-form-upload',
              sha256: Buffer.alloc(32, 0x42),
              sizeBytes: 42n,
              immutable: false,
              scanStatus: 'CLEAN',
              scanCompletedAt: new Date(),
              createdById: contactId,
            },
          },
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (tenantId) {
      await owner.storageOrphan.deleteMany({ where: { tenantId } });
      await owner.tenant.delete({ where: { id: tenantId } });
    }
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  });

  async function journalAs(actorId: string, actorType = 'CLIENT_CONTACT') {
    return app.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('app.current_tenant_id', ${tenantId}, true),
               set_config('app.current_actor_id', ${actorId}, true),
               set_config('app.current_actor_type', ${actorType}, true)
      `;
      return tx.$queryRaw<Array<{ orphanId: string }>>(Prisma.sql`
        SELECT app.journal_open_form_upload_discard(
          ${submissionId}::uuid,
          ${'beleg'}::text,
          ${documentId}::uuid
        ) AS "orphanId"
      `);
    });
  }

  it('journalisiert den eigenen offenen Upload trotz STAFF/SYSTEM-only Tabellen-RLS', async () => {
    const result = await journalAs(contactId);
    expect(result).toHaveLength(1);

    const orphan = await owner.storageOrphan.findUniqueOrThrow({
      where: {
        storageBucket_storageKey_storageVersionId: {
          storageBucket: 'taxtronik-general',
          storageKey,
          storageVersionId: 'version-form-upload',
        },
      },
    });
    expect(orphan).toMatchObject({
      tenantId,
      source: 'portal.form.file.discard',
      failure: 'FORM_UPLOAD_DISCARD_INTENT',
      immutable: false,
    });
  });

  it('verweigert einem Kontakt desselben Tenants den Upload eines anderen Mandanten', async () => {
    await expect(journalAs(foreignContactId)).rejects.toThrow(/nicht mehr verwerfbar/);
  });

  it('verweigert den Definer-Pfad ausserhalb eines CLIENT_CONTACT-Kontexts', async () => {
    await expect(journalAs(contactId, 'STAFF')).rejects.toThrow(/Mandantenkontext/);
  });

  it('erzwingt DB-seitig höchstens einen lebenden Upload je Submission und Feld', async () => {
    await expect(
      owner.document.create({
        data: {
          tenantId,
          clientId,
          title: 'zweiter-beleg.pdf',
          classification: 'GENERAL',
          mimeType: 'application/pdf',
          formSubmissionId: submissionId,
          formFieldKey: 'beleg',
        },
      }),
    ).rejects.toThrow(/Unique constraint/);
  });

  it('wartet auf einen parallelen Request-Close und verwirft danach fail-closed', async () => {
    let releaseClose!: () => void;
    let closeHasRowLock!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      closeHasRowLock = resolve;
    });

    const close = owner.$transaction(async (tx) => {
      await tx.request.update({
        where: { id: requestId },
        data: { status: 'CLOSED', closedAt: new Date() },
      });
      closeHasRowLock();
      await release;
    });
    await locked;

    const discard = journalAs(contactId);
    const earlyState = await Promise.race([
      discard.then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
    ]);
    expect(earlyState).toBe('blocked');

    releaseClose();
    await close;
    await expect(discard).rejects.toThrow(/nicht mehr verwerfbar/);
  });
});
