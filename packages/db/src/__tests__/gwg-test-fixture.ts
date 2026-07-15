import type { PrismaClient } from '@prisma/client';

type VerifiedLegalEntityFixtureInput = {
  tenantId: string;
  clientId: string;
  verifiedBy: string;
  legalForm?: string;
  registerNumber?: string;
  registerAuthority?: string;
  representativeNames?: string[];
  ownershipStructureNotes?: string;
  validUntil?: Date | null;
};

/**
 * Builds a legal-entity GwG fixture through the same fail-closed sequence as
 * production: DRAFT -> stable representative -> evidence -> confirmed 1:1
 * assignment -> VERIFIED. Tests must not create post-cutover VERIFIED rows
 * directly, because doing so would hide regressions in the DB gate.
 */
export async function createVerifiedLegalEntityGwgFixture(
  prisma: PrismaClient,
  input: VerifiedLegalEntityFixtureInput,
) {
  const confirmedAt = new Date();
  const representativeNames = input.representativeNames ?? ['Test-Vertretung'];

  return prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      "SELECT set_config('app.current_tenant_id', $1, true)",
      input.tenantId,
    );
    await tx.$queryRawUnsafe("SELECT set_config('app.current_actor_type', 'STAFF', true)");
    await tx.$queryRawUnsafe(
      "SELECT set_config('app.current_actor_id', $1, true)",
      input.verifiedBy,
    );
    const check = await tx.gwgCheck.create({
      data: {
        tenantId: input.tenantId,
        clientId: input.clientId,
        status: 'DRAFT',
        validUntil: input.validUntil ?? null,
        legalForm: input.legalForm ?? 'GmbH',
        registerNumber: input.registerNumber ?? 'HRB TEST',
        registerAuthority: input.registerAuthority ?? 'Amtsgericht Teststadt',
        representativeNames,
        ownershipStructureNotes: input.ownershipStructureNotes ?? 'Vollstaendiger Test-Snapshot.',
      },
    });

    let identifiedRepresentative: { id: string; fullName: string } | null = null;
    for (const [position, fullName] of representativeNames.entries()) {
      const representative = await tx.gwgRepresentative.create({
        data: { gwgCheckId: check.id, fullName, position },
        select: { id: true, fullName: true },
      });
      identifiedRepresentative ??= representative;
    }
    if (!identifiedRepresentative) {
      throw new Error('GwG-Testfixture braucht mindestens eine vertretungsberechtigte Person.');
    }

    const evidence = await tx.document.create({
      data: {
        tenantId: input.tenantId,
        clientId: input.clientId,
        title: `Identitaetsnachweis ${check.id}`,
        classification: 'GWG_EVIDENCE',
        mimeType: 'image/jpeg',
      },
    });
    await tx.documentVersion.create({
      data: {
        documentId: evidence.id,
        versionNo: 1,
        storageBucket: 'gwg-test',
        storageKey: `gwg-test/${evidence.id}/v1`,
        sha256: Buffer.alloc(32, 0x7a),
        sizeBytes: 1n,
        immutable: false,
        scanStatus: 'CLEAN',
        scanCompletedAt: confirmedAt,
        createdById: input.verifiedBy,
      },
    });
    await tx.gwgIdDocument.create({
      data: {
        gwgCheckId: check.id,
        type: 'PERSONALAUSWEIS',
        ownerName: identifiedRepresentative.fullName,
        documentId: evidence.id,
        representativeSubjectId: identifiedRepresentative.id,
        identityAssignmentConfirmedAt: confirmedAt,
        identityAssignmentConfirmedBy: input.verifiedBy,
        number: `TEST-${check.id}`,
        issuedBy: 'Testbehoerde',
        issueDate: new Date('2020-01-01T00:00:00.000Z'),
        expiryDate: new Date('2099-12-31T00:00:00.000Z'),
        verifiedAt: confirmedAt,
      },
    });

    return tx.gwgCheck.update({
      where: { id: check.id },
      data: {
        status: 'VERIFIED',
        verifiedAt: confirmedAt,
        verifiedBy: input.verifiedBy,
      },
    });
  });
}
