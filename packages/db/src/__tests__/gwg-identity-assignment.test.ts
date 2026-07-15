import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import { Prisma, PrismaClient } from '../prisma-client';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260801004300_gwg_identity_subjects_and_document_sets/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const recoveryMigration = readFileSync(
  new URL(
    '../../prisma/migrations/20260801004400_legacy_gwg_guard_recovery/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');

describe('GwG-Identitaetszuordnung – Migrationsvertrag', () => {
  it('ist transaktional und entsperrt den 034-Guard nur fuer die Legacy-Dubletten', () => {
    const statements = migration
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('--'));
    expect(statements[0]).toBe('BEGIN;');
    expect(statements.at(-1)).toBe('COMMIT;');
    expect(migration).toContain('BEGIN VERIFIED LEGACY DUPLICATE REMEDIATION');
    expect(migration).toContain('DISABLE TRIGGER gwg_id_document_scope_and_claim');
    expect(migration).toContain('ENABLE TRIGGER gwg_id_document_scope_and_claim');
    expect(migration.indexOf('DISABLE TRIGGER gwg_id_document_scope_and_claim')).toBeLessThan(
      migration.indexOf('WITH ranked AS MATERIALIZED'),
    );
    expect(migration.indexOf('WITH ranked AS MATERIALIZED')).toBeLessThan(
      migration.indexOf('ENABLE TRIGGER gwg_id_document_scope_and_claim'),
    );
  });

  it('backfillt homonyme Vertreter positionsgetreu und ohne Namens-Deduplizierung', () => {
    expect(migration).toContain('WITH ORDINALITY AS entry("name", "ordinality")');
    expect(migration).toContain('(entry."ordinality" - 1)::INTEGER');
    expect(migration).not.toMatch(/SELECT\s+DISTINCT[\s\S]{0,200}representative_names/);
    expect(schema).toContain('@@unique([gwgCheckId, position])');
    expect(schema).not.toContain('@@unique([gwgCheckId, fullName])');
  });

  it('laesst Legacy-Zuordnungen unbestaetigt und gibt jeder Zeile ein eigenes Set', () => {
    const legacyBackfill = migration.slice(
      0,
      migration.indexOf('-- 3. Scope-/Bestaetigungs-Guard'),
    );
    expect(migration).toContain(
      'ADD COLUMN "document_set_id" UUID NOT NULL DEFAULT gen_random_uuid()',
    );
    expect(legacyBackfill).not.toMatch(
      /SET\s+"(?:natural_client|beneficial_owner|representative)_subject_id"/,
    );
    expect(legacyBackfill).not.toMatch(/SET\s+"identity_assignment_confirmed_at"/);
  });

  it('grandfathert nur bereits VERIFIED Checks und sperrt neue Abkuerzungen', () => {
    expect(migration).toContain(
      'ADD COLUMN "identity_assignment_required" BOOLEAN NOT NULL DEFAULT TRUE',
    );
    expect(migration).toContain(
      'SET "identity_assignment_required" = FALSE\n WHERE "status" = \'VERIFIED\'\n   AND "destroyed_at" IS NULL',
    );
    expect(migration).not.toContain(
      'SET "identity_assignment_required" = ("status" <> \'VERIFIED\')',
    );
    expect(migration).toContain('Grandfathering ist ausschliesslich dem Migrations-Backfill');
    expect(migration).toContain(
      'OLD."identity_assignment_required" = TRUE\n     AND NEW."identity_assignment_required" = FALSE',
    );
    expect(migration).toContain('app.gwg_check_has_confirmed_identity(NEW."id")');
  });

  it('bindet Scope, Set-Konsistenz und kontrollierte Vernichtung an DB-Guards', () => {
    expect(migration).toContain('NEW."natural_client_subject_id" IS DISTINCT FROM check_client');
    expect(migration).toContain('bo."gwg_check_id" = NEW."gwg_check_id"');
    expect(migration).toContain('rep."gwg_check_id" = NEW."gwg_check_id"');
    expect(migration).toContain('CREATE CONSTRAINT TRIGGER gwg_document_set_consistency');
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(migration).toContain('CREATE TRIGGER gwg_check_purge_representatives_after_destruction');
    expect(migration).toContain('NEW."owner_name" = \'VERNICHTET\'');
    expect(recoveryMigration).toContain('d."deleted_at" IS NULL');
    expect(recoveryMigration).toContain('d."gwg_destruction_requested_at" IS NULL');
    expect(recoveryMigration).toContain('d."gwg_destroyed_at" IS NULL');
    expect(recoveryMigration).toContain('Zugeordneter GwG-Beweisinhalt ist unveraenderlich');
    expect(recoveryMigration).toContain('OLD."deleted_at" IS NULL');
    expect(recoveryMigration).toContain('NEW."deleted_at" IS NOT NULL');
    expect(recoveryMigration).toContain('Zugeordneter GwG-Beleg darf nicht ausgeblendet werden');
  });

  it('akzeptiert nur einen vollstaendig konsistenten und verfuegbaren Ausweissatz', () => {
    expect(recoveryMigration).toContain('peer."number" IS DISTINCT FROM NEW."number"');
    expect(recoveryMigration).toContain('peer."identity_assignment_confirmed_at"');
    expect(recoveryMigration).toContain('AND NOT EXISTS (');
    expect(recoveryMigration).toContain('member."document_id" IS NULL');
    expect(recoveryMigration).toContain('evidence."gwg_destroyed_at" IS NOT NULL');
    expect(recoveryMigration).toContain('current_version."scan_status" = \'CLEAN\'');
    expect(recoveryMigration).toContain('current_version."scan_completed_at" IS NOT NULL');
    expect(recoveryMigration).toContain(
      'newer_version."version_no" > current_version."version_no"',
    );
  });

  it('invalidiert bestaetigte BO-Ausweissets bei Identitaetsaenderungen', () => {
    for (const sql of [migration, recoveryMigration]) {
      expect(sql).toContain('CREATE TRIGGER gwg_beneficial_owner_identity_assignment_invalidate');
      expect(sql).toContain(
        'AFTER UPDATE OF "full_name", "birth_date", "birth_place", "residence", "nationality"',
      );
      expect(sql).toContain('SET "identity_assignment_confirmed_at" = NULL');
      expect(sql).toContain('"verified_at" = NULL');
    }
  });
});

const hasDatabase = Boolean(process.env['DATABASE_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('GwG-Identitaets-Test braucht DATABASE_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

let tenantId: string;
let staffId: string;

beforeAll(async () => {
  if (!hasDatabase) return;
  const tenant = await owner.tenant.create({
    data: { slug: `test-gwg-identity-${Date.now()}`, name: 'GwG Identity Test' },
  });
  tenantId = tenant.id;
  staffId = (
    await owner.staffUser.create({
      data: {
        tenantId,
        email: `gwg-identity-${Date.now()}@example.com`,
        fullName: 'GwG Identity Staff',
        passwordHash: 'x',
      },
    })
  ).id;
});

afterAll(async () => {
  if (!hasDatabase) return;
  await owner.tenant.deleteMany({ where: { id: tenantId } });
  await owner.$disconnect();
});

type EvidenceVersionSpec = {
  versionNo: number;
  scanStatus: 'PENDING' | 'CLEAN' | 'INFECTED';
};

async function createEvidenceDocument(
  clientId: string,
  title: string,
  versions: EvidenceVersionSpec[] = [{ versionNo: 1, scanStatus: 'CLEAN' }],
): Promise<string> {
  return owner.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);
    await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_actor_type', 'STAFF', true)`);
    await tx.$queryRaw(Prisma.sql`SELECT set_config('app.current_actor_id', ${staffId}, true)`);
    const document = await tx.document.create({
      data: {
        tenantId,
        clientId,
        title,
        classification: 'GWG_EVIDENCE',
        mimeType: 'image/jpeg',
      },
    });
    for (const version of versions) {
      await tx.documentVersion.create({
        data: {
          documentId: document.id,
          versionNo: version.versionNo,
          storageBucket: 'gwg-identity-test',
          storageKey: `gwg-identity-test/${document.id}/v${version.versionNo}`,
          sha256: Buffer.alloc(32, version.versionNo),
          sizeBytes: 1n,
          immutable: false,
          scanStatus: version.scanStatus,
          scanCompletedAt: version.scanStatus === 'PENDING' ? null : new Date(),
          createdById: staffId,
        },
      });
    }
    return document.id;
  });
}

async function createConfirmedNaturalIdentityCheck(
  label: string,
  versions: EvidenceVersionSpec[],
): Promise<{ checkId: string; evidenceId: string }> {
  const client = await owner.client.create({
    data: { tenantId, kind: 'NATPERS', name: label },
  });
  const check = await owner.gwgCheck.create({
    data: { tenantId, clientId: client.id, status: 'DRAFT' },
  });
  const evidenceId = await createEvidenceDocument(client.id, `${label} Ausweis`, versions);
  const confirmedAt = new Date();
  await owner.gwgIdDocument.create({
    data: {
      gwgCheckId: check.id,
      type: 'PERSONALAUSWEIS',
      ownerName: client.name,
      documentId: evidenceId,
      naturalClientSubjectId: client.id,
      identityAssignmentConfirmedAt: confirmedAt,
      identityAssignmentConfirmedBy: staffId,
      number: `ID-${check.id}`,
      issuedBy: 'Berlin',
      issueDate: new Date('2020-01-01'),
      expiryDate: new Date('2099-12-31'),
      verifiedAt: confirmedAt,
    },
  });
  return { checkId: check.id, evidenceId };
}

describeWithDatabase('GwG-Identitaetszuordnung – DB-Invarianten', () => {
  it('ueberspringt beim Cutover ein unveraenderliches vernichtetes Legacy-Skelett', async () => {
    const cutoverStart = migration.indexOf(
      'ALTER TABLE "gwg_check"\n  ADD COLUMN "identity_assignment_required"',
    );
    const cutoverEnd = migration.indexOf('ALTER TABLE "gwg_id_document"', cutoverStart);
    expect(cutoverStart).toBeGreaterThan(-1);
    expect(cutoverEnd).toBeGreaterThan(cutoverStart);
    const cutoverStatements = migration
      .slice(cutoverStart, cutoverEnd)
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);

    await owner.$transaction(async (tx) => {
      // The temp table shadows public.gwg_check. Its trigger models the 034
      // destroyed-snapshot guard, so the old all-row UPDATE would fail here.
      await tx.$executeRawUnsafe(`
        CREATE TEMP TABLE "gwg_check" (
          "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          "status" TEXT NOT NULL,
          "destroyed_at" TIMESTAMPTZ(6)
        ) ON COMMIT DROP
      `);
      await tx.$executeRawUnsafe(`
        CREATE FUNCTION pg_temp.protect_destroyed_gwg_skeleton()
        RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD."destroyed_at" IS NOT NULL THEN
            RAISE EXCEPTION 'vernichtetes Legacy-Skelett ist unveraenderlich';
          END IF;
          RETURN NEW;
        END;
        $$
      `);
      await tx.$executeRawUnsafe(`
        CREATE TRIGGER protect_destroyed_gwg_skeleton
        BEFORE UPDATE ON "gwg_check"
        FOR EACH ROW EXECUTE FUNCTION pg_temp.protect_destroyed_gwg_skeleton()
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "gwg_check" ("status", "destroyed_at") VALUES
          ('VERIFIED', CURRENT_TIMESTAMP),
          ('VERIFIED', NULL),
          ('DRAFT', NULL)
      `);

      for (const statement of cutoverStatements) {
        await tx.$executeRawUnsafe(statement);
      }

      const rows = await tx.$queryRawUnsafe<
        Array<{ status: string; destroyed: boolean; assignment_required: boolean }>
      >(`
        SELECT "status",
               "destroyed_at" IS NOT NULL AS destroyed,
               "identity_assignment_required" AS assignment_required
          FROM "gwg_check"
         ORDER BY "destroyed_at" NULLS LAST, "status"
      `);
      expect(rows).toEqual(
        expect.arrayContaining([
          { status: 'VERIFIED', destroyed: true, assignment_required: true },
          { status: 'VERIFIED', destroyed: false, assignment_required: false },
          { status: 'DRAFT', destroyed: false, assignment_required: true },
        ]),
      );
    });
  });

  it('bereinigt VERIFIED-Legacy-Dubletten atomar trotz Snapshot-Guard', async () => {
    const rollbackMarker = 'ROLLBACK_VERIFIED_LEGACY_DUPLICATE_TEST';
    await expect(
      owner.$transaction(
        async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`,
          );
          await tx.$queryRaw(
            Prisma.sql`SELECT set_config('app.current_actor_type', 'STAFF', true)`,
          );
          await tx.$queryRaw(
            Prisma.sql`SELECT set_config('app.current_actor_id', ${staffId}, true)`,
          );

          const client = await tx.client.create({
            data: { tenantId, kind: 'JURPERS', name: 'Legacy Dublette GmbH' },
          });
          const check = await tx.gwgCheck.create({
            data: {
              tenantId,
              clientId: client.id,
              representativeNames: ['Erika Dublette'],
            },
          });
          const representative = await tx.gwgRepresentative.create({
            data: { gwgCheckId: check.id, fullName: 'Erika Dublette', position: 0 },
          });
          const [duplicateEvidence, identityEvidence] = await Promise.all([
            tx.document.create({
              data: {
                tenantId,
                clientId: client.id,
                title: 'Legacy doppelt verknuepfter Beleg',
                classification: 'GWG_EVIDENCE',
                mimeType: 'application/pdf',
              },
            }),
            tx.document.create({
              data: {
                tenantId,
                clientId: client.id,
                title: 'Bestaetigter Ausweis',
                classification: 'GWG_EVIDENCE',
                mimeType: 'image/jpeg',
              },
            }),
          ]);
          await tx.documentVersion.create({
            data: {
              documentId: identityEvidence.id,
              versionNo: 1,
              storageBucket: 'gwg-identity-test',
              storageKey: `gwg-identity-test/${identityEvidence.id}/v1`,
              sha256: Buffer.alloc(32, 0x4c),
              sizeBytes: 1n,
              immutable: false,
              scanStatus: 'CLEAN',
              scanCompletedAt: new Date(),
              createdById: staffId,
            },
          });

          await tx.$executeRawUnsafe(
            'ALTER TABLE public."gwg_id_document" ' +
              'DROP CONSTRAINT "gwg_id_document_gwg_check_id_document_id_key"',
          );
          await tx.gwgIdDocument.createMany({
            data: [
              {
                gwgCheckId: check.id,
                type: 'HANDELSREGISTERAUSZUG',
                ownerName: client.name,
                documentId: duplicateEvidence.id,
              },
              {
                gwgCheckId: check.id,
                type: 'HANDELSREGISTERAUSZUG',
                ownerName: client.name,
                documentId: duplicateEvidence.id,
              },
            ],
          });
          const confirmedAt = new Date();
          await tx.gwgIdDocument.create({
            data: {
              gwgCheckId: check.id,
              type: 'PERSONALAUSWEIS',
              ownerName: representative.fullName,
              documentId: identityEvidence.id,
              representativeSubjectId: representative.id,
              identityAssignmentConfirmedAt: confirmedAt,
              identityAssignmentConfirmedBy: staffId,
              number: 'LEGACY-ID-1',
              issuedBy: 'Berlin',
              issueDate: new Date('2020-01-01'),
              expiryDate: new Date('2099-12-31'),
              verifiedAt: confirmedAt,
            },
          });
          await tx.gwgCheck.update({
            where: { id: check.id },
            data: { status: 'VERIFIED', verifiedAt: confirmedAt },
          });

          // Flush deferred document-set checks before the migration-style
          // ALTER TABLE; PostgreSQL rejects it while trigger events are pending.
          await tx.$executeRawUnsafe('SET CONSTRAINTS gwg_document_set_consistency IMMEDIATE');
          await tx.$executeRawUnsafe(
            'ALTER TABLE public."gwg_id_document" ' +
              'DISABLE TRIGGER gwg_id_document_scope_and_claim',
          );
          await tx.$executeRawUnsafe(`
            WITH ranked AS MATERIALIZED (
              SELECT gid."id",
                     ROW_NUMBER() OVER (
                       PARTITION BY gid."gwg_check_id", gid."document_id"
                       ORDER BY gid."created_at", gid."id"
                     ) AS rn
                FROM public."gwg_id_document" gid
               WHERE gid."document_id" IS NOT NULL
            )
            UPDATE public."gwg_id_document" gid
               SET "document_id" = NULL
              FROM ranked r
             WHERE gid."id" = r."id" AND r.rn > 1
          `);
          await tx.$executeRawUnsafe(
            'ALTER TABLE public."gwg_id_document" ' +
              'ENABLE TRIGGER gwg_id_document_scope_and_claim',
          );

          const duplicateRows = await tx.gwgIdDocument.findMany({
            where: { gwgCheckId: check.id, type: 'HANDELSREGISTERAUSZUG' },
            select: { documentId: true },
          });
          expect(
            duplicateRows.filter((row) => row.documentId === duplicateEvidence.id),
          ).toHaveLength(1);
          expect(duplicateRows.filter((row) => row.documentId === null)).toHaveLength(1);
          const [trigger] = await tx.$queryRaw<Array<{ mode: string }>>(Prisma.sql`
            SELECT t.tgenabled::text AS mode
              FROM pg_catalog.pg_trigger t
             WHERE t.tgrelid = 'public.gwg_id_document'::regclass
               AND t.tgname = 'gwg_id_document_scope_and_claim'
          `);
          expect(trigger?.mode).toBe('O');
          throw new Error(rollbackMarker);
        },
        { timeout: 30_000 },
      ),
    ).rejects.toThrow(rollbackMarker);
  });

  it('blockiert eine neue Freigabe bis zur bestaetigten Natural-Client-Zuordnung', async () => {
    const client = await owner.client.create({
      data: { tenantId, kind: 'NATPERS', name: 'Erika Identity' },
    });
    const check = await owner.gwgCheck.create({
      data: { tenantId, clientId: client.id, status: 'DRAFT' },
    });
    expect(check.identityAssignmentRequired).toBe(true);

    const evidenceId = await createEvidenceDocument(client.id, 'Natural Client Ausweis');
    const idDocument = await owner.gwgIdDocument.create({
      data: {
        gwgCheckId: check.id,
        type: 'PERSONALAUSWEIS',
        ownerName: client.name,
        documentId: evidenceId,
        number: 'ID-123',
        issuedBy: 'Berlin',
        issueDate: new Date('2020-01-01'),
        expiryDate: new Date('2099-12-31'),
        verifiedAt: new Date(),
      },
    });

    await expect(
      owner.gwgCheck.update({
        where: { id: check.id },
        data: { status: 'VERIFIED', verifiedAt: new Date() },
      }),
    ).rejects.toThrow(/1:1-Identitaetszuordnung/);

    await owner.gwgIdDocument.update({
      where: { id: idDocument.id },
      data: { naturalClientSubjectId: client.id },
    });
    await expect(
      owner.gwgCheck.update({
        where: { id: check.id },
        data: { status: 'VERIFIED', verifiedAt: new Date() },
      }),
    ).rejects.toThrow(/1:1-Identitaetszuordnung/);

    const confirmedAt = new Date();
    await owner.gwgIdDocument.update({
      where: { id: idDocument.id },
      data: {
        identityAssignmentConfirmedAt: confirmedAt,
        identityAssignmentConfirmedBy: staffId,
      },
    });
    await owner.gwgCheck.update({
      where: { id: check.id },
      data: {
        status: 'VERIFIED',
        verifiedAt: confirmedAt,
        validUntil: new Date('2099-12-31'),
      },
    });
    await expect(
      owner.client.update({ where: { id: client.id }, data: { allowActive: true } }),
    ).resolves.toMatchObject({ allowActive: true });
  });

  it('blockiert VERIFIED fuer eine reine Dokumenthuelle ohne gescannte Version', async () => {
    const { checkId } = await createConfirmedNaturalIdentityCheck('Keine Dateiversion', []);
    await expect(
      owner.gwgCheck.update({
        where: { id: checkId },
        data: { status: 'VERIFIED', verifiedAt: new Date() },
      }),
    ).rejects.toThrow(/1:1-Identitaetszuordnung/);
  });

  it.each(['PENDING', 'INFECTED'] as const)(
    'blockiert VERIFIED wenn nach v1 CLEAN die aktuelle v2 %s ist',
    async (scanStatus) => {
      const { checkId } = await createConfirmedNaturalIdentityCheck(
        `Aktuelle Version ${scanStatus}`,
        [
          { versionNo: 1, scanStatus: 'CLEAN' },
          { versionNo: 2, scanStatus },
        ],
      );
      await expect(
        owner.gwgCheck.update({
          where: { id: checkId },
          data: { status: 'VERIFIED', verifiedAt: new Date() },
        }),
      ).rejects.toThrow(/1:1-Identitaetszuordnung/);
    },
  );

  it('friert Dateiversionen sofort nach der expliziten GwG-Zuordnung ein', async () => {
    const { checkId, evidenceId } = await createConfirmedNaturalIdentityCheck(
      'Finaler Beweisinhalt',
      [{ versionNo: 1, scanStatus: 'CLEAN' }],
    );
    const version = await owner.documentVersion.findFirstOrThrow({
      where: { documentId: evidenceId },
      orderBy: { versionNo: 'desc' },
    });

    await expect(
      owner.documentVersion.create({
        data: {
          documentId: evidenceId,
          versionNo: 2,
          storageBucket: 'gwg-identity-test',
          storageKey: `gwg-identity-test/${evidenceId}/v2`,
          sha256: Buffer.alloc(32, 2),
          sizeBytes: 1n,
          immutable: false,
          scanStatus: 'CLEAN',
          scanCompletedAt: new Date(),
          createdById: staffId,
        },
      }),
    ).rejects.toThrow();
    await expect(
      owner.documentVersion.update({
        where: { id: version.id },
        data: { scanStatus: 'INFECTED', scanCompletedAt: new Date() },
      }),
    ).rejects.toThrow();
    await expect(owner.documentVersion.delete({ where: { id: version.id } })).rejects.toThrow();

    // Die Sperre veraendert die bestaetigte Ausgangsversion nicht; der Check
    // kann mit genau diesem Inhalt weiterhin regulaer freigegeben werden.
    await expect(
      owner.gwgCheck.update({
        where: { id: checkId },
        data: { status: 'VERIFIED', verifiedAt: new Date() },
      }),
    ).resolves.toMatchObject({ status: 'VERIFIED' });
  });

  it('weist Subjects aus einem anderen Check auch bei gueltiger UUID zurueck', async () => {
    const [clientA, clientB] = await Promise.all([
      owner.client.create({ data: { tenantId, kind: 'JURPERS', name: 'Scope A GmbH' } }),
      owner.client.create({ data: { tenantId, kind: 'JURPERS', name: 'Scope B GmbH' } }),
    ]);
    const [checkA, checkB] = await Promise.all([
      owner.gwgCheck.create({
        data: { tenantId, clientId: clientA.id, representativeNames: ['A Vertretung'] },
      }),
      owner.gwgCheck.create({
        data: { tenantId, clientId: clientB.id, representativeNames: ['B Vertretung'] },
      }),
    ]);
    const [foreignRepresentative, foreignOwner] = await Promise.all([
      owner.gwgRepresentative.create({
        data: { gwgCheckId: checkB.id, fullName: 'B Vertretung', position: 0 },
      }),
      owner.gwgBeneficialOwner.create({
        data: { gwgCheckId: checkB.id, fullName: 'B Eigentum' },
      }),
    ]);
    const evidenceId = await createEvidenceDocument(clientA.id, 'Scope Ausweis');

    await expect(
      owner.gwgIdDocument.create({
        data: {
          gwgCheckId: checkA.id,
          type: 'PERSONALAUSWEIS',
          ownerName: foreignRepresentative.fullName,
          documentId: evidenceId,
          representativeSubjectId: foreignRepresentative.id,
        },
      }),
    ).rejects.toThrow();

    await expect(
      owner.gwgIdDocument.create({
        data: {
          gwgCheckId: checkA.id,
          type: 'PERSONALAUSWEIS',
          ownerName: foreignOwner.fullName,
          documentId: evidenceId,
          beneficialOwnerSubjectId: foreignOwner.id,
        },
      }),
    ).rejects.toThrow();
  });

  it('weist soft-geloeschte und vernichtete Evidence-Belege beim Verknuepfen zurueck', async () => {
    const client = await owner.client.create({
      data: { tenantId, kind: 'JURPERS', name: 'Unavailable Evidence GmbH' },
    });
    const check = await owner.gwgCheck.create({
      data: { tenantId, clientId: client.id },
    });
    const [deletedEvidenceId, destroyedEvidenceId] = await Promise.all([
      createEvidenceDocument(client.id, 'Soft geloeschter GwG-Beleg'),
      createEvidenceDocument(client.id, 'Vernichteter GwG-Beleg'),
    ]);

    // Simuliert bereits vorhandene Altzustaende. DISABLE/UPDATE/ENABLE liegen
    // in einer Transaktion; bei jedem Fehler wird der Guard sicher restauriert.
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE public."document" DISABLE TRIGGER document_gwg_invite_scope_and_claim',
      );
      await tx.document.update({
        where: { id: deletedEvidenceId },
        data: { deletedAt: new Date(), deletedByStaff: staffId },
      });
      await tx.document.update({
        where: { id: destroyedEvidenceId },
        data: { gwgDestroyedAt: new Date() },
      });
      await tx.$executeRawUnsafe(
        'ALTER TABLE public."document" ENABLE TRIGGER document_gwg_invite_scope_and_claim',
      );
    });

    for (const documentId of [deletedEvidenceId, destroyedEvidenceId]) {
      await expect(
        owner.gwgIdDocument.create({
          data: {
            gwgCheckId: check.id,
            type: 'HANDELSREGISTERAUSZUG',
            ownerName: client.name,
            documentId,
          },
        }),
      ).rejects.toThrow();
    }
  });

  it('sperrt das Ausblenden eines zugeordneten Belegs und erlaubt Legacy-Restore', async () => {
    const client = await owner.client.create({
      data: { tenantId, kind: 'JURPERS', name: 'Visibility Lock GmbH' },
    });
    const check = await owner.gwgCheck.create({
      data: { tenantId, clientId: client.id, status: 'DRAFT' },
    });
    const evidenceId = await createEvidenceDocument(client.id, 'Visibility Lock Beleg');
    await owner.gwgIdDocument.create({
      data: {
        gwgCheckId: check.id,
        type: 'HANDELSREGISTERAUSZUG',
        ownerName: client.name,
        documentId: evidenceId,
      },
    });

    await expect(
      owner.document.update({
        where: { id: evidenceId },
        data: { deletedAt: new Date(), deletedByStaff: staffId },
      }),
    ).rejects.toThrow(/GwG-Beleg/);
    await expect(
      owner.document.findUniqueOrThrow({ where: { id: evidenceId } }),
    ).resolves.toMatchObject({ deletedAt: null });

    // Ein inkonsistenter Legacy-Zustand kann nach dem Upgrade weiterhin in
    // Backups vorkommen. Nur fuer den Aufbau dieses Altzustands wird genau der
    // neue Dokument-Guard innerhalb einer Transaktion kurz deaktiviert.
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE public."document" DISABLE TRIGGER document_gwg_invite_scope_and_claim',
      );
      await tx.document.update({
        where: { id: evidenceId },
        data: { deletedAt: new Date(), deletedByStaff: staffId },
      });
      await tx.$executeRawUnsafe(
        'ALTER TABLE public."document" ENABLE TRIGGER document_gwg_invite_scope_and_claim',
      );
    });

    await expect(
      owner.document.update({
        where: { id: evidenceId },
        data: { deletedAt: null, deletedByStaff: null },
      }),
    ).resolves.toMatchObject({ deletedAt: null });
    await expect(
      owner.document.findUniqueOrThrow({ where: { id: evidenceId } }),
    ).resolves.toMatchObject({ deletedAt: null });
  });

  it('invalidiert bei direkter BO-Aenderung den gesamten bestaetigten Ausweissatz', async () => {
    const client = await owner.client.create({
      data: { tenantId, kind: 'JURPERS', name: 'BO Invalidation GmbH' },
    });
    const check = await owner.gwgCheck.create({
      data: { tenantId, clientId: client.id },
    });
    const beneficialOwner = await owner.gwgBeneficialOwner.create({
      data: {
        gwgCheckId: check.id,
        fullName: 'Beate Beispiel',
        birthDate: new Date('1980-01-01'),
        nationality: 'DE',
      },
    });
    const [frontId, backId] = await Promise.all([
      createEvidenceDocument(client.id, 'BO-Ausweis Vorderseite'),
      createEvidenceDocument(client.id, 'BO-Ausweis Rueckseite'),
    ]);
    const documentSetId = crypto.randomUUID();
    const confirmedAt = new Date();
    const common = {
      gwgCheckId: check.id,
      documentSetId,
      type: 'PERSONALAUSWEIS' as const,
      ownerName: beneficialOwner.fullName,
      beneficialOwnerSubjectId: beneficialOwner.id,
      identityAssignmentConfirmedAt: confirmedAt,
      identityAssignmentConfirmedBy: staffId,
      number: 'BO-ID-1',
      issuedBy: 'Berlin',
      issueDate: new Date('2020-01-01'),
      expiryDate: new Date('2099-12-31'),
      verifiedAt: confirmedAt,
    };
    await owner.gwgIdDocument.create({ data: { ...common, documentId: frontId } });
    await owner.gwgIdDocument.create({ data: { ...common, documentId: backId } });

    // Bypasses every application action on purpose: the DB invariant must
    // invalidate both files in the set on its own.
    await owner.gwgBeneficialOwner.update({
      where: { id: beneficialOwner.id },
      data: { nationality: 'FR' },
    });

    const members = await owner.gwgIdDocument.findMany({
      where: { documentSetId },
      orderBy: { id: 'asc' },
    });
    expect(members).toHaveLength(2);
    expect(members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identityAssignmentConfirmedAt: null,
          identityAssignmentConfirmedBy: null,
          verifiedAt: null,
        }),
        expect.objectContaining({
          identityAssignmentConfirmedAt: null,
          identityAssignmentConfirmedBy: null,
          verifiedAt: null,
        }),
      ]),
    );
  });

  it('haelt homonyme Vertreter getrennt und ein Vorder-/Rueckseiten-Set konsistent', async () => {
    const client = await owner.client.create({
      data: { tenantId, kind: 'PERSGES', name: 'Homonym GbR' },
    });
    const check = await owner.gwgCheck.create({
      data: {
        tenantId,
        clientId: client.id,
        representativeNames: ['Alex Beispiel', 'Alex Beispiel'],
      },
    });
    const [representativeA, representativeB] = await Promise.all([
      owner.gwgRepresentative.create({
        data: { gwgCheckId: check.id, fullName: 'Alex Beispiel', position: 0 },
      }),
      owner.gwgRepresentative.create({
        data: { gwgCheckId: check.id, fullName: 'Alex Beispiel', position: 1 },
      }),
    ]);
    expect(representativeA.id).not.toBe(representativeB.id);

    const [frontId, backId, thirdId] = await Promise.all([
      createEvidenceDocument(client.id, 'Ausweis Vorderseite'),
      createEvidenceDocument(client.id, 'Ausweis Rueckseite'),
      createEvidenceDocument(client.id, 'Ausweis Dritte Datei'),
    ]);
    const documentSetId = crypto.randomUUID();
    const confirmedAt = new Date();
    const common = {
      gwgCheckId: check.id,
      type: 'PERSONALAUSWEIS' as const,
      ownerName: 'Alex Beispiel',
      documentSetId,
      representativeSubjectId: representativeA.id,
      identityAssignmentConfirmedAt: confirmedAt,
      identityAssignmentConfirmedBy: staffId,
      number: 'HOM-1',
      issuedBy: 'Berlin',
      issueDate: new Date('2020-01-01'),
      expiryDate: new Date('2099-12-31'),
      verifiedAt: confirmedAt,
    };
    const front = await owner.gwgIdDocument.create({
      data: { ...common, documentId: frontId },
    });
    await owner.gwgIdDocument.create({ data: { ...common, documentId: backId } });

    await expect(
      owner.$transaction(async (tx) => {
        await tx.gwgIdDocument.create({
          data: {
            ...common,
            documentId: thirdId,
            representativeSubjectId: representativeB.id,
          },
        });
      }),
    ).rejects.toThrow(/Dokumentset.*einheitlich/);

    await expect(
      owner.$transaction(async (tx) => {
        await tx.gwgIdDocument.create({
          data: { ...common, documentId: thirdId, number: 'ANDERE-NUMMER' },
        });
      }),
    ).rejects.toThrow(/Ausweisdaten einheitlich abbilden/);

    await expect(
      owner.gwgIdDocument.create({
        data: { ...common, documentSetId: crypto.randomUUID(), documentId: frontId },
      }),
    ).rejects.toThrow();

    await owner.gwgRepresentative.delete({ where: { id: representativeA.id } });
    const unassigned = await owner.gwgIdDocument.findUniqueOrThrow({ where: { id: front.id } });
    expect(unassigned).toMatchObject({
      representativeSubjectId: null,
      identityAssignmentConfirmedAt: null,
      identityAssignmentConfirmedBy: null,
    });
  });

  it('verbietet direkte neue VERIFIED-Inserts und true-zu-false-Cutover-Manipulation', async () => {
    const client = await owner.client.create({
      data: { tenantId, kind: 'NATPERS', name: 'No Shortcut' },
    });
    await expect(
      owner.gwgCheck.create({
        data: { tenantId, clientId: client.id, status: 'VERIFIED', verifiedAt: new Date() },
      }),
    ).rejects.toThrow(/zuerst als offener Check/);

    const check = await owner.gwgCheck.create({ data: { tenantId, clientId: client.id } });
    await expect(
      owner.gwgCheck.update({
        where: { id: check.id },
        data: { identityAssignmentRequired: false },
      }),
    ).rejects.toThrow(/nach dem Cutover nicht deaktiviert/);
  });
});
