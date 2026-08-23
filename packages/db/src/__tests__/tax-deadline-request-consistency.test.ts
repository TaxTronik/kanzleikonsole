import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';
import { withTenantContext } from '../tenant-context';
import { prisma as appPrisma } from '../client';

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

let tenantId: string;
let clientId: string;
let staffId: string;
let deadlineId: string;
let requestId: string;
let internalCommentId: string;

beforeAll(async () => {
  const stamp = Date.now();
  const tenant = await owner.tenant.create({
    data: { slug: `tax-request-link-${stamp}`, name: 'Tax Request Link Test' },
  });
  tenantId = tenant.id;
  const staff = await owner.staffUser.create({
    data: {
      tenantId,
      email: `tax-request-link-${stamp}@test.local`,
      fullName: 'Tax Link Test',
      passwordHash: 'x',
    },
  });
  staffId = staff.id;
  const client = await owner.client.create({
    data: { tenantId, kind: 'JURPERS', name: 'Tax Link Mandant', allowActive: false },
  });
  clientId = client.id;
  await createVerifiedLegalEntityGwgFixture(owner, {
    tenantId,
    clientId,
    verifiedBy: staffId,
    validUntil: new Date('2099-12-31T00:00:00.000Z'),
    registerNumber: `HRB TAX LINK ${stamp}`,
  });
  await owner.client.update({ where: { id: clientId }, data: { allowActive: true } });

  const deadline = await owner.taxDeadline.create({
    data: {
      tenantId,
      clientId,
      kind: 'USTA_MONATLICH',
      period: `test-${stamp}`,
      dueDate: new Date('2099-12-31T00:00:00.000Z'),
    },
  });
  deadlineId = deadline.id;
  const request = await owner.request.create({
    data: {
      tenantId,
      clientId,
      title: 'Automatische Steuer-Anforderung',
      description: 'Konsistenztest',
      createdByStaff: staffId,
    },
  });
  requestId = request.id;
  const internalComment = await owner.requestInternalComment.create({
    data: {
      requestId,
      authorStaffId: staffId,
      authorName: 'Tax Link Test',
      body: 'Nur intern sichtbar',
    },
  });
  internalCommentId = internalComment.id;

  await owner.$transaction(async (tx) => {
    await tx.request.update({
      where: { id: requestId },
      data: { taxDeadlineId: deadlineId },
    });
    await tx.taxDeadline.update({
      where: { id: deadlineId },
      data: { requestId },
    });
  });
});

afterAll(async () => {
  if (tenantId) await owner.tenant.deleteMany({ where: { id: tenantId } });
  await owner.$disconnect();
  await appPrisma.$disconnect();
});

describe('TaxDeadline/Request-Pointer-Invariante', () => {
  it('verwirft das einseitige Clear auf der Request-Seite am Transaktionscommit', async () => {
    await expect(
      owner.$transaction((tx) =>
        tx.request.update({ where: { id: requestId }, data: { taxDeadlineId: null } }),
      ),
    ).rejects.toThrow(/pointer mismatch/i);

    await expect(owner.request.findUnique({ where: { id: requestId } })).resolves.toMatchObject({
      taxDeadlineId: deadlineId,
    });
  });

  it('verwirft das einseitige Clear auf der Deadline-Seite am Transaktionscommit', async () => {
    await expect(
      owner.$transaction((tx) =>
        tx.taxDeadline.update({ where: { id: deadlineId }, data: { requestId: null } }),
      ),
    ).rejects.toThrow(/pointer mismatch/i);

    await expect(
      owner.taxDeadline.findUnique({ where: { id: deadlineId } }),
    ).resolves.toMatchObject({ requestId });
  });

  it('erlaubt das atomare Clear beider Pointer', async () => {
    await expect(
      owner.$transaction(async (tx) => {
        await tx.request.update({ where: { id: requestId }, data: { taxDeadlineId: null } });
        await tx.taxDeadline.update({ where: { id: deadlineId }, data: { requestId: null } });
      }),
    ).resolves.toBeUndefined();

    await expect(owner.request.findUnique({ where: { id: requestId } })).resolves.toMatchObject({
      taxDeadlineId: null,
    });
    await expect(
      owner.taxDeadline.findUnique({ where: { id: deadlineId } }),
    ).resolves.toMatchObject({ requestId: null });
  });

  it('liefert interne Kommentare für STAFF, aber niemals für CLIENT_CONTACT', async () => {
    const staffRows = await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      (tx) => tx.requestInternalComment.findMany({ where: { id: internalCommentId } }),
    );
    const portalRows = await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'CLIENT_CONTACT' },
      (tx) => tx.requestInternalComment.findMany({ where: { id: internalCommentId } }),
    );

    expect(staffRows).toHaveLength(1);
    expect(portalRows).toEqual([]);
  });
});
