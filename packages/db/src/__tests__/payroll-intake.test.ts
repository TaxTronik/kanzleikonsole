// Fachkatalog: PAYROLL-INTAKE-001
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '../prisma-client';
import type { Prisma } from '@prisma/client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';
const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
});
describe('PAYROLL-INTAKE-001 live restricted app role and capability boundary', () => {
  let tenantId: string,
    clientId: string,
    staffId: string,
    employerId: string,
    otherId: string,
    intakeId: string,
    inviteId: string,
    attachmentId: string;
  const inviteHash = randomBytes(32).toString('hex'),
    sessionHash = randomBytes(32).toString('hex');
  const empty = '00000000-0000-0000-0000-000000000000';
  function context<T>(
    tenant: string,
    actorId: string | null,
    type: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return app.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenant},true),set_config('app.current_actor_id',${actorId ?? ''},true),set_config('app.current_actor_type',${type},true)`;
      return fn(tx);
    });
  }
  function guest<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return context(empty, null, 'STAFF', fn);
  }
  async function readGuest() {
    return guest(
      async (tx) =>
        (
          await tx.$queryRaw<
            Array<{ data: Record<string, unknown> | null }>
          >`SELECT app.payroll_guest_read(${sessionHash}) AS data`
        )[0]?.data,
    );
  }
  beforeAll(async () => {
    const suffix = Date.now() + '-' + randomBytes(4).toString('hex');
    tenantId = (
      await owner.tenant.create({
        data: { slug: 'payroll-test-' + suffix, name: 'Payroll isolation' },
      })
    ).id;
    staffId = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: 'payroll-' + suffix + '@example.test',
          fullName: 'Payroll Admin',
          passwordHash: 'x',
          roles: { create: { role: 'ADMIN' } },
        },
      })
    ).id;
    clientId = (
      await owner.client.create({ data: { tenantId, kind: 'JURPERS', name: 'Payroll fixture' } })
    ).id;
    await createVerifiedLegalEntityGwgFixture(owner, {
      tenantId,
      clientId,
      verifiedBy: staffId,
      registerNumber: 'HRB-' + suffix,
    });
    await owner.client.update({ where: { id: clientId }, data: { allowActive: true } });
    employerId = (
      await owner.clientContact.create({
        data: {
          tenantId,
          clientId,
          email: 'employer-' + suffix + '@example.test',
          fullName: 'Employer',
        },
      })
    ).id;
    otherId = (
      await owner.clientContact.create({
        data: { tenantId, clientId, email: 'other-' + suffix + '@example.test', fullName: 'Other' },
      })
    ).id;
    await owner.tenantSetting.create({
      data: { tenantId, key: 'modules', value: { payrollIntake: true } },
    });
    const expiresAt = new Date(Date.now() + 86400000);
    intakeId = (
      await owner.payrollIntake.create({
        data: {
          tenantId,
          clientId,
          employeeLabel: 'Protected employee',
          schemaSnapshot: {
            employee: [{ key: 'firstName', label: 'First name', required: true, type: 'text' }],
            employer: [],
          },
          employerAnswers: { grossPay: 'hidden-from-employee' },
          expiresAt,
          createdByStaff: staffId,
        },
      })
    ).id;
    await owner.payrollEmployeeData.create({
      data: { tenantId, intakeId, answers: { firstName: 'Private name' } },
    });
    await owner.payrollEmployerGrant.create({
      data: { tenantId, intakeId, contactId: employerId },
    });
    inviteId = (
      await owner.payrollEmployeeInvite.create({
        data: { tenantId, intakeId, tokenHash: inviteHash, expiresAt },
      })
    ).id;
    attachmentId = (
      await owner.payrollAttachment.create({
        data: {
          tenantId,
          intakeId,
          audience: 'EMPLOYEE',
          uploadedBy: staffId,
          revision: 0,
          filename: 'private.pdf',
          mimeType: 'application/pdf',
          storageBucket: 'test',
          storageKey: 'tenants/' + tenantId + '/none/test/private.bin',
          sha256: 'ab'.repeat(32),
          sizeBytes: 12n,
        },
      })
    ).id;
    await owner.payrollAttachment.update({
      where: { id: attachmentId },
      data: { status: 'COMPLETE', storageVersionId: 'private-version' },
    });
  });
  afterAll(async () => {
    if (tenantId) {
      await owner.payrollGuestSession.deleteMany({ where: { tenantId } });
      await owner.payrollEmployeeInvite.deleteMany({ where: { tenantId } });
      await owner.payrollEmployerGrant.deleteMany({ where: { tenantId } });
      await owner.payrollExport.deleteMany({ where: { tenantId } });
      await owner.payrollExternalTask.deleteMany({ where: { tenantId } });
      await owner.payrollAttachment.deleteMany({ where: { tenantId } });
      await owner.payrollRevision.deleteMany({ where: { tenantId } });
      await owner.payrollEmployeeData.deleteMany({ where: { tenantId } });
      await owner.payrollIntake.deleteMany({ where: { tenantId } });
      await owner.tenant.delete({ where: { id: tenantId } });
    }
    await app.$disconnect();
    await owner.$disconnect();
  });
  it('an employer grant never grants employee answers, revisions or personal attachments', async () => {
    const data = await context(tenantId, employerId, 'CLIENT_CONTACT', async (tx) => ({
      intakes: await tx.payrollIntake.findMany(),
      answers: await tx.payrollEmployeeData.findMany(),
      revisions: await tx.payrollRevision.findMany(),
      attachments: await tx.payrollAttachment.findMany(),
    }));
    expect(data.intakes.map((i) => i.id)).toContain(intakeId);
    expect(data.answers).toEqual([]);
    expect(data.revisions).toEqual([]);
    expect(data.attachments).toEqual([]);
    expect(
      await context(tenantId, otherId, 'CLIENT_CONTACT', (tx) => tx.payrollIntake.findMany()),
    ).toEqual([]);
  });
  it('exchanges an invite only once and gives the guest no general tenant context', async () => {
    const exchange = () =>
      guest(
        async (tx) =>
          (
            await tx.$queryRaw<
              Array<{ expiry: Date | null }>
            >`SELECT app.payroll_guest_exchange(${inviteHash},${sessionHash}) AS expiry`
          )[0]?.expiry,
      );
    expect(await exchange()).toBeInstanceOf(Date);
    expect(await exchange()).toBeNull();
    const view = await readGuest();
    expect(view?.answers).toEqual({ firstName: 'Private name' });
    expect(view).not.toHaveProperty('employerAnswers');
    expect(JSON.stringify(view)).not.toContain('hidden-from-employee');
    expect(await guest((tx) => tx.client.findMany())).toEqual([]);
    expect(await guest((tx) => tx.document.findMany())).toEqual([]);
    expect(await guest((tx) => tx.payrollIntake.findMany())).toEqual([]);
    await expect(
      guest(
        (tx) => tx.$queryRaw`SELECT app.payroll_capture_revision(${intakeId}::uuid,NULL,'STAFF')`,
      ),
    ).rejects.toThrow();
    await expect(
      context(
        tenantId,
        employerId,
        'CLIENT_CONTACT',
        (tx) => tx.$queryRaw`SELECT app.payroll_guest_read(${sessionHash})`,
      ),
    ).rejects.toThrow();
  });
  it('restricts capability writes to frozen employee fields and the expected revision', async () => {
    expect(
      await guest(
        async (tx) =>
          (
            await tx.$queryRaw<
              Array<{ saved: boolean }>
            >`SELECT app.payroll_guest_save(${sessionHash},999,'{"firstName":"x"}'::jsonb,false) AS saved`
          )[0]?.saved,
      ),
    ).toBe(false);
    await expect(
      guest(
        (tx) =>
          tx.$queryRaw`SELECT app.payroll_guest_save(${sessionHash},0,'{"grossPay":"99999"}'::jsonb,false)`,
      ),
    ).rejects.toThrow();
    expect(
      await guest(
        async (tx) =>
          (
            await tx.$queryRaw<
              Array<{ saved: boolean }>
            >`SELECT app.payroll_guest_save(${sessionHash},0,'{"firstName":"Submitted private name"}'::jsonb,true) AS saved`
          )[0]?.saved,
      ),
    ).toBe(true);
    expect(
      await guest(
        async (tx) =>
          (
            await tx.$queryRaw<
              Array<{ saved: boolean }>
            >`SELECT app.payroll_guest_save(${sessionHash},1,'{"firstName":"rewritten"}'::jsonb,false) AS saved`
          )[0]?.saved,
      ),
    ).toBe(false);
    const history = await owner.payrollRevision.findMany({ where: { intakeId } });
    expect(history).toHaveLength(1);
    expect(JSON.stringify(history[0]?.snapshot)).toContain('Submitted private name');
    await expect(
      context(tenantId, staffId, 'STAFF', (tx) =>
        tx.payrollRevision.deleteMany({ where: { intakeId } }),
      ),
    ).rejects.toThrow();
  });
  it('blocks invented successful DATEV exports at the database boundary', async () => {
    await expect(
      owner.payrollExport.create({
        data: {
          tenantId,
          intakeId,
          revision: 1,
          kind: 'DATEV_LUG',
          status: 'COMPLETE',
          explanation: 'Invented import',
          createdByStaff: staffId,
        },
      }),
    ).rejects.toThrow();
  });
  it('waits for a hidden staff source before final submission and captures private external evidence', async () => {
    const pending = await owner.payrollAttachment.create({
      data: {
        tenantId,
        intakeId,
        audience: 'STAFF',
        uploadedBy: staffId,
        revision: 1,
        filename: 'staff-source.pdf',
        mimeType: 'application/pdf',
        storageBucket: 'test',
        storageKey: 'tenants/' + tenantId + '/none/test/staff-source.bin',
        sha256: 'cd'.repeat(32),
        sizeBytes: 10n,
      },
    });
    const submitEmployer = () =>
      context(tenantId, employerId, 'CLIENT_CONTACT', async (tx) => {
        await tx.payrollIntake.update({
          where: { id: intakeId },
          data: { revision: 2, status: 'SUBMITTED', employerConfirmedAt: new Date() },
        });
        await tx.$executeRaw`SELECT app.payroll_capture_authorized_revision(${intakeId}::uuid)`;
      });
    // The employer cannot SELECT this staff source, but the final submission still waits for it.
    await expect(submitEmployer()).rejects.toThrow();
    await context(tenantId, staffId, 'STAFF', (tx) =>
      tx.payrollAttachment.update({
        where: { id: pending.id },
        data: { status: 'COMPLETE', storageVersionId: 'staff-source-version' },
      }),
    );
    await submitEmployer();
    await owner.payrollExternalTask.create({
      data: {
        tenantId,
        intakeId,
        kind: 'SOFORTMELDUNG',
        status: 'EVIDENCE_RECORDED',
        evidence: 'Private external reference A',
        recordedByStaff: staffId,
        recordedAt: new Date(),
      },
    });
    await context(tenantId, staffId, 'STAFF', async (tx) => {
      await tx.payrollIntake.update({
        where: { id: intakeId },
        data: { revision: 3, status: 'REVIEWED', reviewedByStaff: staffId, reviewedAt: new Date() },
      });
      await tx.$executeRaw`SELECT app.payroll_capture_authorized_revision(${intakeId}::uuid)`;
    });
    await context(tenantId, staffId, 'STAFF', async (tx) => {
      await tx.payrollExternalTask.update({
        where: { intakeId_kind: { intakeId, kind: 'SOFORTMELDUNG' } },
        data: { evidence: 'Corrected external reference B' },
      });
      await tx.payrollIntake.update({
        where: { id: intakeId },
        data: { revision: 4, status: 'SUBMITTED', reviewedAt: null, reviewedByStaff: null },
      });
      await tx.$executeRaw`SELECT app.payroll_capture_authorized_revision(${intakeId}::uuid)`;
    });
    const history = await owner.payrollRevision.findMany({
      where: { intakeId },
      orderBy: { revision: 'asc' },
    });
    expect(JSON.stringify(history.find((r) => r.revision === 3)?.snapshot)).toContain(
      'Private external reference A',
    );
    expect(JSON.stringify(history.find((r) => r.revision === 4)?.snapshot)).toContain(
      'Corrected external reference B',
    );
    expect(
      await context(tenantId, employerId, 'CLIENT_CONTACT', (tx) =>
        tx.payrollExternalTask.findMany(),
      ),
    ).toEqual([]);
    await expect(
      owner.payrollAttachment.create({
        data: {
          tenantId,
          intakeId,
          audience: 'STAFF',
          uploadedBy: staffId,
          revision: 4,
          filename: 'late.pdf',
          mimeType: 'application/pdf',
          storageBucket: 'test',
          storageKey: 'tenants/' + tenantId + '/none/test/late.bin',
          sha256: 'ef'.repeat(32),
          sizeBytes: 10n,
        },
      }),
    ).rejects.toThrow();
  });
  it('keeps the employer confirmation immutable even while waiting for employee submission', async () => {
    const draft = await owner.payrollIntake.create({
      data: {
        tenantId,
        clientId,
        employeeLabel: 'Separate confirmation',
        schemaSnapshot: { employer: [], employee: [] },
        employerAnswers: { pay: 'confirmed' },
        employerConfirmedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        createdByStaff: staffId,
      },
    });
    await owner.payrollEmployerGrant.create({
      data: { tenantId, intakeId: draft.id, contactId: employerId },
    });
    await expect(
      context(tenantId, employerId, 'CLIENT_CONTACT', (tx) =>
        tx.payrollIntake.update({
          where: { id: draft.id },
          data: { revision: 1, employerAnswers: { pay: 'changed' }, employerConfirmedAt: null },
        }),
      ),
    ).rejects.toThrow();
    await context(tenantId, staffId, 'STAFF', (tx) =>
      tx.payrollIntake.update({
        where: { id: draft.id },
        data: { revision: 1, status: 'RETURNED', employerConfirmedAt: null },
      }),
    );
    await context(tenantId, employerId, 'CLIENT_CONTACT', (tx) =>
      tx.payrollIntake.update({
        where: { id: draft.id },
        data: { revision: 2, status: 'DRAFT', employerAnswers: { pay: 'new draft' } },
      }),
    );
  });
  it('invalidates guest reads and attachment access on module, mandate and invite revocation', async () => {
    await owner.tenantSetting.update({
      where: { tenantId_key: { tenantId, key: 'modules' } },
      data: { value: { payrollIntake: false } },
    });
    expect(await readGuest()).toBeNull();
    await owner.tenantSetting.update({
      where: { tenantId_key: { tenantId, key: 'modules' } },
      data: { value: { payrollIntake: true } },
    });
    await owner.client.update({ where: { id: clientId }, data: { mandateEndedAt: new Date() } });
    expect(await readGuest()).toBeNull();
    await owner.client.update({ where: { id: clientId }, data: { mandateEndedAt: null } });
    expect(await readGuest()).not.toBeNull();
    const liveSession = await owner.payrollGuestSession.findUniqueOrThrow({
      where: { tokenHash: sessionHash },
    });
    await owner.payrollGuestSession.update({
      where: { id: liveSession.id },
      data: { expiresAt: new Date('2000-01-01') },
    });
    expect(await readGuest()).toBeNull();
    await owner.payrollGuestSession.update({
      where: { id: liveSession.id },
      data: { expiresAt: liveSession.expiresAt },
    });
    await guest((tx) => tx.$executeRaw`SELECT app.payroll_guest_logout(${sessionHash})`);
    expect(await readGuest()).toBeNull();
    await owner.payrollGuestSession.update({
      where: { id: liveSession.id },
      data: { revokedAt: null },
    });
    await owner.payrollEmployeeInvite.update({
      where: { id: inviteId },
      data: { revokedAt: new Date() },
    });
    expect(await readGuest()).toBeNull();
    expect(
      await guest(
        async (tx) =>
          (
            await tx.$queryRaw<
              Array<{ data: unknown }>
            >`SELECT app.payroll_guest_attachment(${sessionHash},${attachmentId}::uuid) AS data`
          )[0]?.data,
      ),
    ).toBeNull();
  });
});
