import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Fachkatalog: GWG-RETENTION-DESTRUCTION-001
import { Prisma } from '../prisma-client';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('GwG-Vernichtungs-Test braucht DATABASE_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const racer = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

let tenantId: string;
let staffId: string;
let clientId: string;
let documentId: string;
let nullRetentionDocumentId: string;
let futureRetentionDocumentId: string;
let versionId: string;
let checkId: string;
let linkedIdDocumentId: string;
let beneficialOwnerId: string;
let representativeId: string;
let inviteId: string;

beforeAll(async () => {
  const tenant = await owner.tenant.create({
    data: { slug: `test-gwg-destroy-${Date.now()}`, name: 'GwG Vernichtung Test' },
  });
  tenantId = tenant.id;
  const staff = await owner.staffUser.create({
    data: {
      tenantId,
      email: `gwg-destroy-${Date.now()}@example.com`,
      fullName: 'GwG Destroy Staff',
      passwordHash: 'x',
      active: true,
    },
  });
  staffId = staff.id;
  const client = await owner.client.create({
    data: { tenantId, kind: 'JURPERS', name: 'Destroy GmbH', allowActive: false },
  });
  clientId = client.id;
  const check = await owner.gwgCheck.create({
    data: {
      tenantId,
      clientId: client.id,
      status: 'IN_REVIEW',
      validUntil: null,
      legalForm: 'GmbH',
      registerNumber: 'HRB 12345',
      registerAuthority: 'Amtsgericht Berlin-Charlottenburg',
      representativeNames: ['Erika Muster'],
      ownershipStructureNotes: 'Erika Muster hält sämtliche Geschäftsanteile.',
    },
  });
  checkId = check.id;
  representativeId = (
    await owner.gwgRepresentative.create({
      data: { gwgCheckId: checkId, fullName: 'Erika Muster', position: 0 },
    })
  ).id;
  const [document, nullRetentionDocument, futureRetentionDocument] = await owner.$transaction(
    async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);
      await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_actor_type', 'STAFF', true)`);
      await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_actor_id', ${staffId}, true)`);
      return Promise.all([
        tx.document.create({
          data: {
            tenantId,
            clientId: client.id,
            title: 'Ausweis',
            classification: 'GWG_EVIDENCE',
            mimeType: 'application/pdf',
          },
        }),
        tx.document.create({
          data: {
            tenantId,
            clientId: client.id,
            title: 'Null Retention',
            classification: 'GWG_EVIDENCE',
            mimeType: 'application/pdf',
          },
        }),
        tx.document.create({
          data: {
            tenantId,
            clientId: client.id,
            title: 'Future Retention',
            classification: 'GWG_EVIDENCE',
            mimeType: 'application/pdf',
            retentionUntil: new Date('2099-01-01T00:00:00Z'),
          },
        }),
      ]);
    },
  );
  documentId = document.id;
  nullRetentionDocumentId = nullRetentionDocument.id;
  futureRetentionDocumentId = futureRetentionDocument.id;
  const version = await owner.documentVersion.create({
    data: {
      documentId,
      versionNo: 1,
      storageBucket: 'gwg-test',
      storageKey: `gwg-test/${documentId}`,
      storageVersionId: `version-${documentId}`,
      sha256: Buffer.alloc(32, 1),
      sizeBytes: 42n,
      immutable: true,
      scanStatus: 'CLEAN',
      scanCompletedAt: new Date(),
      createdById: staffId,
    },
  });
  versionId = version.id;
  linkedIdDocumentId = (
    await owner.gwgIdDocument.create({
      data: {
        gwgCheckId: checkId,
        type: 'PERSONALAUSWEIS',
        ownerName: 'Erika Muster',
        documentId,
        representativeSubjectId: representativeId,
        identityAssignmentConfirmedAt: new Date(),
        identityAssignmentConfirmedBy: staffId,
        number: 'DESTROY-ID-1',
        issuedBy: 'Berlin',
        issueDate: new Date('2020-01-01'),
        expiryDate: new Date('2099-12-31'),
        verifiedAt: new Date(),
      },
    })
  ).id;
  beneficialOwnerId = (
    await owner.gwgBeneficialOwner.create({
      data: {
        gwgCheckId: checkId,
        fullName: 'Erika Muster',
        residence: 'Berlin',
        ownershipPct: 100,
      },
    })
  ).id;
  inviteId = (
    await owner.gwgOnboardingInvite.create({
      data: {
        tenantId,
        clientId,
        inviteEmail: `destroy-invite-${Date.now()}@example.com`,
        inviteName: 'Destroy Invite',
        tokenHash: `destroy-invite-${Date.now()}`,
        expiresAt: new Date('2015-01-01T00:00:00.000Z'),
        status: 'EXPIRED',
        createdByStaff: staffId,
        gwgCheckId: checkId,
      },
    })
  ).id;
  await owner.gwgCheck.update({
    where: { id: checkId },
    data: { status: 'VERIFIED', verifiedAt: new Date() },
  });
  await owner.client.update({ where: { id: client.id }, data: { allowActive: true } });
});

afterAll(async () => {
  if (tenantId) await owner.tenant.deleteMany({ where: { id: tenantId } });
  await racer.$disconnect();
  await owner.$disconnect();
});

async function attachConfirmedNaturalIdentity(
  checkIdForIdentity: string,
  clientIdForIdentity: string,
  ownerName: string,
): Promise<void> {
  const document = await owner.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);
    await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_actor_type', 'STAFF', true)`);
    await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_actor_id', ${staffId}, true)`);
    const document = await tx.document.create({
      data: {
        tenantId,
        clientId: clientIdForIdentity,
        title: `Natural Identity ${checkIdForIdentity}`,
        classification: 'GWG_EVIDENCE',
        mimeType: 'image/jpeg',
      },
    });
    await tx.documentVersion.create({
      data: {
        documentId: document.id,
        versionNo: 1,
        storageBucket: 'gwg-destruction-test',
        storageKey: `gwg-destruction-test/${document.id}/v1`,
        sha256: Buffer.alloc(32, 0x44),
        sizeBytes: 1n,
        immutable: false,
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
        createdById: staffId,
      },
    });
    return document;
  });
  const confirmedAt = new Date();
  await owner.gwgIdDocument.create({
    data: {
      gwgCheckId: checkIdForIdentity,
      type: 'PERSONALAUSWEIS',
      ownerName,
      documentId: document.id,
      naturalClientSubjectId: clientIdForIdentity,
      identityAssignmentConfirmedAt: confirmedAt,
      identityAssignmentConfirmedBy: staffId,
      number: `NAT-${checkIdForIdentity}`,
      issuedBy: 'Berlin',
      issueDate: new Date('2020-01-01'),
      expiryDate: new Date('2099-12-31'),
      verifiedAt: confirmedAt,
    },
  });
}

describeWithDatabase('GwG-Vernichtung immutable DocumentVersion', () => {
  it('erzwingt für jede neue immutable Version eine konkrete Storage-VersionId', async () => {
    await expect(
      owner.documentVersion.create({
        data: {
          // Unverknuepfter Beleg: Hier soll gezielt der Storage-Version-Guard
          // und nicht die neue GwG-Snapshot-Sperre ausloesen.
          documentId: nullRetentionDocumentId,
          versionNo: 1,
          storageBucket: 'gwg-test',
          storageKey: `gwg-test/${nullRetentionDocumentId}/missing-storage-version`,
          sha256: Buffer.alloc(32, 4),
          sizeBytes: 42n,
          immutable: true,
          scanStatus: 'CLEAN',
          scanCompletedAt: new Date(),
          createdById: staffId,
        },
      }),
    ).rejects.toThrow(/document_version_locked_storage_version_check|check constraint/i);
  });

  it('erlaubt nur den engen immutable PENDING-zu-CLEAN-Abschluss und friert die VersionId ein', async () => {
    await expect(
      owner.$transaction(async (tx) => {
        const pending = await tx.documentVersion.create({
          data: {
            documentId: nullRetentionDocumentId,
            versionNo: 1,
            storageBucket: 'gwg-test',
            storageKey: `gwg-test/${nullRetentionDocumentId}/pending-intent`,
            storageVersionId: null,
            sha256: Buffer.alloc(32, 5),
            sizeBytes: 43n,
            immutable: true,
            scanStatus: 'PENDING',
            scanCompletedAt: null,
            createdById: staffId,
          },
        });

        const finalized = await tx.documentVersion.update({
          where: { id: pending.id },
          data: {
            storageVersionId: 'pending-intent-version-1',
            scanStatus: 'CLEAN',
            scanCompletedAt: new Date(),
          },
        });
        expect(finalized.storageVersionId).toBe('pending-intent-version-1');
        expect(finalized.scanStatus).toBe('CLEAN');

        // Der absichtlich letzte, verbotene Schreibversuch bricht die ganze
        // Testtransaktion ab. So bleibt keine immutable Testversion zurueck.
        await tx.documentVersion.update({
          where: { id: pending.id },
          data: { storageVersionId: 'pending-intent-version-2' },
        });
      }),
    ).rejects.toThrow(/immutable|restrict|dürfen nicht geändert/i);
  });

  it('blockiert direkte Löschung und Funktionsaufruf ohne protokollierte Absicht', async () => {
    await expect(owner.documentVersion.delete({ where: { id: versionId } })).rejects.toThrow();
    await expect(expectDestroyCheckFunction()).rejects.toThrow();

    await expect(
      owner.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`,
        );
        await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_actor_type', 'STAFF', true)`);
        await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_actor_id', ${staffId}, true)`);
        await tx.$queryRaw(
          Prisma.sql`SELECT app.destroy_gwg_document_versions(${documentId}::uuid)`,
        );
      }),
    ).rejects.toThrow();
  });

  it('blockiert tenantfremde Invite-Verknüpfungen auf DB-Ebene', async () => {
    const otherTenant = await owner.tenant.create({
      data: { slug: `test-gwg-other-${Date.now()}`, name: 'Andere Kanzlei' },
    });
    try {
      const otherStaff = await owner.staffUser.create({
        data: {
          tenantId: otherTenant.id,
          email: `gwg-other-${Date.now()}@example.com`,
          fullName: 'Other Staff',
          passwordHash: 'x',
          active: true,
        },
      });
      const otherClient = await owner.client.create({
        data: { tenantId: otherTenant.id, kind: 'JURPERS', name: 'Fremd GmbH' },
      });
      const otherInvite = await owner.gwgOnboardingInvite.create({
        data: {
          tenantId: otherTenant.id,
          clientId: otherClient.id,
          inviteEmail: `other-${Date.now()}@example.com`,
          inviteName: 'Fremd',
          tokenHash: `other-${Date.now()}`,
          expiresAt: new Date(Date.now() + 60_000),
          boundClientRevision: 'other-client-revision',
          createdByStaff: otherStaff.id,
        },
      });
      await expect(
        owner.document.update({
          where: { id: documentId },
          data: { gwgOnboardingInviteId: otherInvite.id },
        }),
      ).rejects.toThrow();
    } finally {
      await owner.tenant.delete({ where: { id: otherTenant.id } });
    }
  });

  it('friert Klassifikation und alle einmal verifizierten Snapshot-Teile DB-seitig ein', async () => {
    await expect(
      owner.document.update({ where: { id: documentId }, data: { classification: 'GENERAL' } }),
    ).rejects.toThrow();
    await expect(
      owner.gwgCheck.update({ where: { id: checkId }, data: { legalForm: 'AG' } }),
    ).rejects.toThrow();
    await expect(
      owner.gwgCheck.update({ where: { id: checkId }, data: { destroyedAt: new Date() } }),
    ).rejects.toThrow();
    await expect(
      owner.gwgBeneficialOwner.update({
        where: { id: beneficialOwnerId },
        data: { residence: 'Hamburg' },
      }),
    ).rejects.toThrow();
    await expect(
      owner.gwgBeneficialOwner.delete({ where: { id: beneficialOwnerId } }),
    ).rejects.toThrow();
    await expect(
      owner.gwgIdDocument.update({
        where: { id: linkedIdDocumentId },
        data: { ownerName: 'Manipuliert' },
      }),
    ).rejects.toThrow();
    await expect(owner.gwgCheck.delete({ where: { id: checkId } })).rejects.toThrow();

    await expect(
      owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'CREATE TEMP TABLE "gwg_check" (LIKE public."gwg_check" INCLUDING ALL) ON COMMIT DROP',
        );
        await tx.$executeRaw(
          Prisma.sql`UPDATE public."gwg_id_document"
                     SET "owner_name" = 'Temp-Shadow-Bypass'
                     WHERE "id" = ${linkedIdDocumentId}::uuid`,
        );
      }),
    ).rejects.toThrow(/unver(?:ä|ae)nderlich/);
  });

  it('bricht die Client-Check-Gegenlock-Race fail-fast statt per Deadlock ab', async () => {
    const dueClient = await owner.client.create({
      data: {
        tenantId,
        kind: 'NATPERS',
        name: 'Deadlock Regression',
        mandateEndedAt: new Date('2010-01-01T00:00:00.000Z'),
        allowActive: false,
      },
    });
    const dueCheck = await owner.gwgCheck.create({
      data: {
        tenantId,
        clientId: dueClient.id,
        status: 'DRAFT',
        validUntil: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
    await attachConfirmedNaturalIdentity(dueCheck.id, dueClient.id, dueClient.name);
    await owner.gwgCheck.update({
      where: { id: dueCheck.id },
      data: { status: 'VERIFIED', verifiedAt: new Date('2010-01-01T00:00:00.000Z') },
    });
    await owner.client.update({ where: { id: dueClient.id }, data: { allowActive: true } });

    let releaseBoth!: () => void;
    let clientLocked!: () => void;
    let checkLocked!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const clientReady = new Promise<void>((resolve) => {
      clientLocked = resolve;
    });
    const checkReady = new Promise<void>((resolve) => {
      checkLocked = resolve;
    });

    const destroy = owner.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '4s'");
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM public."client"
                       WHERE "id" = ${dueClient.id}::uuid FOR UPDATE`,
        );
        await tx.$queryRaw(
          Prisma.sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`,
        );
        await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_actor_type', 'STAFF', true)`);
        await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_actor_id', ${staffId}, true)`);
        clientLocked();
        await release;
        return tx.$queryRaw(Prisma.sql`SELECT app.destroy_gwg_check(${dueCheck.id}::uuid)`);
      },
      { timeout: 10_000 },
    );
    const expire = racer.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '4s'");
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM public."gwg_check"
                       WHERE "id" = ${dueCheck.id}::uuid FOR UPDATE`,
        );
        checkLocked();
        await release;
        return tx.gwgCheck.update({
          where: { id: dueCheck.id },
          data: { status: 'EXPIRED' },
        });
      },
      { timeout: 10_000 },
    );

    await Promise.all([clientReady, checkReady]);
    releaseBoth();
    const [destroyResult, expireResult] = await Promise.allSettled([destroy, expire]);
    expect(destroyResult.status).toBe('rejected');
    if (destroyResult.status === 'rejected') {
      expect(String(destroyResult.reason)).toMatch(/parallel bearbeitet.*erneut starten/i);
    }
    expect(expireResult.status).toBe('fulfilled');
    expect(
      (await owner.gwgCheck.findUnique({ where: { id: dueCheck.id }, select: { status: true } }))
        ?.status,
    ).toBe('EXPIRED');
    expect(
      (
        await owner.client.findUnique({
          where: { id: dueClient.id },
          select: { allowActive: true },
        })
      )?.allowActive,
    ).toBe(false);
  }, 15_000);

  it('lässt kein Check-Kind hinter einer laufenden Vernichtung nachrutschen', async () => {
    const dueClient = await owner.client.create({
      data: {
        tenantId,
        kind: 'NATPERS',
        name: 'Child-Race Regression',
        mandateEndedAt: new Date('2010-01-01T00:00:00.000Z'),
        allowActive: false,
      },
    });
    const dueCheck = await owner.gwgCheck.create({
      data: { tenantId, clientId: dueClient.id, status: 'REJECTED' },
    });

    let releaseDestroy!: () => void;
    let checkLocked!: () => void;
    let reportPid!: (pid: number) => void;
    const release = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      checkLocked = resolve;
    });
    const pidReady = new Promise<number>((resolve) => {
      reportPid = resolve;
    });

    const destroy = owner.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '4s'");
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM public."gwg_check"
                       WHERE "id" = ${dueCheck.id}::uuid FOR UPDATE`,
        );
        await tx.$queryRaw(
          Prisma.sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`,
        );
        await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_actor_type', 'STAFF', true)`);
        await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_actor_id', ${staffId}, true)`);
        checkLocked();
        await release;
        return tx.$queryRaw(Prisma.sql`SELECT app.destroy_gwg_check(${dueCheck.id}::uuid)`);
      },
      { timeout: 10_000 },
    );

    await locked;
    const insert = racer.$transaction(
      async (tx) => {
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>(
          Prisma.sql`SELECT pg_backend_pid()::integer AS pid`,
        );
        reportPid(backend!.pid);
        return tx.gwgBeneficialOwner.create({
          data: { gwgCheckId: dueCheck.id, fullName: 'Nachrutschender Berechtigter' },
        });
      },
      { timeout: 10_000 },
    );

    try {
      expect(await waitForBackendLock(await pidReady)).toBe(true);
    } finally {
      releaseDestroy();
    }

    await expect(destroy).resolves.toBeTruthy();
    await expect(insert).rejects.toThrow(/unver(?:ä|ae)nderlich/);
    expect(await owner.gwgBeneficialOwner.count({ where: { gwgCheckId: dueCheck.id } })).toBe(0);
  }, 15_000);

  it('blockiert jede direkte neue Zuordnung zu einem vernichteten Check', async () => {
    const dueClient = await owner.client.create({
      data: {
        tenantId,
        kind: 'NATPERS',
        name: 'Destroyed Parent Regression',
        mandateEndedAt: new Date('2010-01-01T00:00:00.000Z'),
        allowActive: false,
      },
    });
    const dueCheck = await owner.gwgCheck.create({
      data: { tenantId, clientId: dueClient.id, status: 'REJECTED' },
    });
    const unlinkedInvite = await owner.gwgOnboardingInvite.create({
      data: {
        tenantId,
        clientId: dueClient.id,
        inviteEmail: `unlinked-${Date.now()}@example.com`,
        inviteName: 'Noch nicht zugeordnet',
        tokenHash: `unlinked-${Date.now()}`,
        expiresAt: new Date('2015-01-01T00:00:00.000Z'),
        status: 'EXPIRED',
        createdByStaff: staffId,
      },
    });
    const linkedInvite = await owner.gwgOnboardingInvite.create({
      data: {
        tenantId,
        clientId: dueClient.id,
        inviteEmail: `linked-${Date.now()}@example.com`,
        inviteName: 'Zu vernichten',
        tokenHash: `linked-${Date.now()}`,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        status: 'PENDING',
        createdByStaff: staffId,
        gwgCheckId: dueCheck.id,
        boundCheckRevision: 'due-check-revision',
      },
    });

    await expectDestroyCheckFunction(dueCheck.id);

    await expect(
      owner.gwgBeneficialOwner.create({
        data: { gwgCheckId: dueCheck.id, fullName: 'Unzulässiger Berechtigter' },
      }),
    ).rejects.toThrow(/unver(?:ä|ae)nderlich/);
    await expect(
      owner.gwgIdDocument.create({
        data: { gwgCheckId: dueCheck.id, type: 'PERSONALAUSWEIS', ownerName: 'Unzulässig' },
      }),
    ).rejects.toThrow(/unver(?:ä|ae)nderlich/);
    await expect(
      owner.gwgOnboardingInvite.create({
        data: {
          tenantId,
          clientId: dueClient.id,
          inviteEmail: `after-destroy-${Date.now()}@example.com`,
          inviteName: 'Unzulässig',
          tokenHash: `after-destroy-${Date.now()}`,
          expiresAt: new Date('2099-01-01T00:00:00.000Z'),
          createdByStaff: staffId,
          gwgCheckId: dueCheck.id,
          boundCheckRevision: 'destroyed-check-revision',
        },
      }),
    ).rejects.toThrow(/vernichteten GwG-Check/);
    await expect(
      owner.gwgOnboardingInvite.update({
        where: { id: unlinkedInvite.id },
        data: { gwgCheckId: dueCheck.id },
      }),
    ).rejects.toThrow(/vernichteten GwG-Check/);

    expect(
      await owner.gwgOnboardingInvite.findUnique({
        where: { id: linkedInvite.id },
        select: {
          inviteEmail: true,
          inviteName: true,
          tokenHash: true,
          status: true,
          submittedIp: true,
          submittedUa: true,
          uploadedDocumentIds: true,
        },
      }),
    ).toMatchObject({
      inviteEmail: `vernichtet+${linkedInvite.id}@taxtronik.local`,
      inviteName: 'VERNICHTET',
      tokenHash: `vernichtet-${linkedInvite.id}`,
      status: 'EXPIRED',
      submittedIp: null,
      submittedUa: null,
      uploadedDocumentIds: [],
    });
  });

  it('lässt keine Dokumentversion hinter einem laufenden PENDING-Claim nachrutschen', async () => {
    const dueClient = await owner.client.create({
      data: {
        tenantId,
        kind: 'NATPERS',
        name: 'Version-Race Regression',
        mandateEndedAt: new Date('2010-01-01T00:00:00.000Z'),
        allowActive: false,
      },
    });
    await owner.gwgCheck.create({
      data: { tenantId, clientId: dueClient.id, status: 'DRAFT' },
    });
    const document = await owner.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);
      await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_actor_type', 'STAFF', true)`);
      await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_actor_id', ${staffId}, true)`);
      return tx.document.create({
        data: {
          tenantId,
          clientId: dueClient.id,
          title: 'Version Race',
          classification: 'GWG_EVIDENCE',
          mimeType: 'application/pdf',
          retentionUntil: new Date('2015-01-01T00:00:00.000Z'),
        },
      });
    });

    let releaseClaim!: () => void;
    let documentLocked!: () => void;
    let reportPid!: (pid: number) => void;
    const release = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      documentLocked = resolve;
    });
    const pidReady = new Promise<number>((resolve) => {
      reportPid = resolve;
    });

    const claim = owner.$transaction(
      async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM public."document"
                       WHERE "id" = ${document.id}::uuid FOR UPDATE`,
        );
        await tx.document.update({
          where: { id: document.id },
          data: { gwgDestructionRequestedAt: new Date(), gwgDestructionRequestedBy: staffId },
        });
        documentLocked();
        await release;
      },
      { timeout: 10_000 },
    );

    await locked;
    const insert = racer.$transaction(
      async (tx) => {
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>(
          Prisma.sql`SELECT pg_backend_pid()::integer AS pid`,
        );
        reportPid(backend!.pid);
        return tx.documentVersion.create({
          data: {
            documentId: document.id,
            versionNo: 1,
            storageBucket: 'gwg-test',
            storageKey: `gwg-test/${document.id}/race`,
            storageVersionId: `version-${document.id}-race`,
            sha256: Buffer.alloc(32, 9),
            sizeBytes: 42n,
            immutable: true,
            createdById: staffId,
          },
        });
      },
      { timeout: 10_000 },
    );

    try {
      expect(await waitForBackendLock(await pidReady)).toBe(true);
    } finally {
      releaseClaim();
    }

    await expect(claim).resolves.toBeUndefined();
    await expect(insert).rejects.toThrow(/befindet sich in Vernichtung/);
    expect(await owner.documentVersion.count({ where: { documentId: document.id } })).toBe(0);
  }, 15_000);

  it('löscht nach vorgemerkter Vernichtung ausschließlich die Zielversionen', async () => {
    await owner.client.update({
      where: { id: clientId },
      data: { mandateEndedAt: new Date('2010-01-01T00:00:00Z') },
    });
    await owner.document.update({
      where: { id: documentId },
      data: { retentionUntil: new Date('2015-01-01T00:00:00Z') },
    });
    for (const id of [documentId, nullRetentionDocumentId, futureRetentionDocumentId]) {
      await owner.document.update({
        where: { id },
        data: { gwgDestructionRequestedAt: new Date(), gwgDestructionRequestedBy: staffId },
      });
    }

    await expect(expectDestroyFunction(nullRetentionDocumentId)).rejects.toThrow();
    await expect(expectDestroyFunction(futureRetentionDocumentId)).rejects.toThrow();

    await expect(
      owner.client.update({ where: { id: clientId }, data: { mandateEndedAt: null } }),
    ).rejects.toThrow();
    await expect(
      owner.document.update({ where: { id: documentId }, data: { deletedAt: new Date() } }),
    ).rejects.toThrow();
    await expect(
      owner.gwgCheck.update({ where: { id: checkId }, data: { status: 'EXPIRED' } }),
    ).resolves.toBeTruthy();
    await expect(
      owner.gwgCheck.update({ where: { id: checkId }, data: { legalForm: 'AG' } }),
    ).rejects.toThrow();
    expect(
      (await owner.client.findUnique({ where: { id: clientId }, select: { allowActive: true } }))
        ?.allowActive,
    ).toBe(false);
    await expect(
      owner.client.update({ where: { id: clientId }, data: { allowActive: true } }),
    ).rejects.toThrow();
    await expect(
      owner.gwgIdDocument.create({
        data: {
          gwgCheckId: checkId,
          type: 'PERSONALAUSWEIS',
          ownerName: 'Neue Referenz',
          documentId,
        },
      }),
    ).rejects.toThrow();

    await expect(
      owner.documentVersion.create({
        data: {
          documentId,
          versionNo: 2,
          storageBucket: 'gwg-test',
          storageKey: `gwg-test/${documentId}/2`,
          storageVersionId: `version-${documentId}-2`,
          sha256: Buffer.alloc(32, 2),
          sizeBytes: 42n,
          immutable: true,
          createdById: staffId,
        },
      }),
    ).rejects.toThrow();

    await expectDestroyFunction();

    expect(await owner.documentVersion.count({ where: { documentId } })).toBe(0);
    expect(
      (
        await owner.document.findUnique({
          where: { id: documentId },
          select: { gwgDestroyedAt: true, deletedAt: true },
        })
      )?.gwgDestroyedAt,
    ).not.toBeNull();
    expect(
      (
        await owner.gwgIdDocument.findUnique({
          where: { id: linkedIdDocumentId },
          select: { documentId: true },
        })
      )?.documentId,
    ).toBeNull();
    await expect(
      owner.document.update({ where: { id: documentId }, data: { deletedAt: null } }),
    ).rejects.toThrow();
    await expect(owner.document.delete({ where: { id: documentId } })).rejects.toThrow();

    await expect(
      owner.documentVersion.create({
        data: {
          documentId,
          versionNo: 3,
          storageBucket: 'gwg-test',
          storageKey: `gwg-test/${documentId}/3`,
          storageVersionId: `version-${documentId}-3`,
          sha256: Buffer.alloc(32, 3),
          sizeBytes: 42n,
          immutable: true,
          createdById: staffId,
        },
      }),
    ).rejects.toThrow();

    await expect(expectDestroyCheckFunction()).resolves.toBeTruthy();
    const destroyedCheck = await owner.gwgCheck.findUnique({
      where: { id: checkId },
      select: { destroyedAt: true, legalForm: true, representativeNames: true },
    });
    expect(destroyedCheck?.destroyedAt).not.toBeNull();
    expect(destroyedCheck?.legalForm).toBeNull();
    expect(destroyedCheck?.representativeNames).toEqual([]);
    expect(await owner.gwgBeneficialOwner.count({ where: { gwgCheckId: checkId } })).toBe(0);
    expect(await owner.gwgRepresentative.count({ where: { gwgCheckId: checkId } })).toBe(0);
    expect(
      (
        await owner.gwgIdDocument.findUnique({
          where: { id: linkedIdDocumentId },
          select: { ownerName: true, number: true },
        })
      )?.ownerName,
    ).toBe('VERNICHTET');
    await expect(
      owner.gwgCheck.update({ where: { id: checkId }, data: { destroyedAt: null } }),
    ).rejects.toThrow();
    await expect(
      owner.document.update({ where: { id: documentId }, data: { title: 'Manipuliert' } }),
    ).rejects.toThrow(/unver(?:ä|ae)nderlich/);
    await expect(
      owner.gwgCheck.update({ where: { id: checkId }, data: { status: 'REJECTED' } }),
    ).rejects.toThrow(/unver(?:ä|ae)nderlich/);
    await expect(
      owner.gwgOnboardingInvite.update({
        where: { id: inviteId },
        data: { gwgCheckId: null },
      }),
    ).rejects.toThrow(/unver(?:ä|ae)nderlich/);
    await expect(
      owner.document.update({ where: { id: documentId }, data: { updatedAt: new Date() } }),
    ).resolves.toBeTruthy();
    await expect(
      owner.gwgCheck.update({ where: { id: checkId }, data: { updatedAt: new Date() } }),
    ).resolves.toBeTruthy();
  });
});

function expectDestroyFunction(targetDocumentId = documentId): Promise<unknown> {
  return owner.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);
    await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_actor_type', 'STAFF', true)`);
    await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_actor_id', ${staffId}, true)`);
    return tx.$queryRaw(
      Prisma.sql`SELECT app.destroy_gwg_document_versions(${targetDocumentId}::uuid)`,
    );
  });
}

function expectDestroyCheckFunction(targetCheckId = checkId): Promise<unknown> {
  return owner.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);
    await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_actor_type', 'STAFF', true)`);
    await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_actor_id', ${staffId}, true)`);
    return tx.$queryRaw(Prisma.sql`SELECT app.destroy_gwg_check(${targetCheckId}::uuid)`);
  });
}

async function waitForBackendLock(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [activity] = await owner.$queryRaw<Array<{ waiting: boolean }>>(
      Prisma.sql`SELECT COALESCE(wait_event_type = 'Lock', FALSE) AS waiting
                 FROM pg_stat_activity WHERE pid = ${pid}`,
    );
    if (activity?.waiting) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}
