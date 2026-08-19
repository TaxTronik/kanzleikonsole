import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260819000000_gwg_onboarding_document_discard/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});
let tenantId: string;
let clientId: string;
let staffId: string;

beforeAll(async () => {
  const tenant = await owner.tenant.create({
    data: { slug: `gwg-discard-${Date.now()}`, name: 'GwG Discard Test' },
  });
  tenantId = tenant.id;
  staffId = (
    await owner.staffUser.create({
      data: {
        tenantId,
        email: `gwg-discard-${Date.now()}@example.test`,
        fullName: 'GwG Discard Test',
        passwordHash: 'x',
      },
    })
  ).id;
  clientId = (
    await owner.client.create({
      data: { tenantId, kind: 'JURPERS', name: 'Discard GmbH', allowActive: false },
    })
  ).id;
});

afterAll(async () => {
  if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

async function createInviteDocument(status: 'STARTED' | 'SUBMITTED') {
  const invite = await owner.gwgOnboardingInvite.create({
    data: {
      tenantId,
      clientId,
      inviteEmail: `invite-${Date.now()}-${status}@example.test`,
      inviteName: 'Erika Muster',
      tokenHash: `token-${Date.now()}-${status}`,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      status,
      submittedAt: status === 'SUBMITTED' ? new Date() : null,
      boundClientRevision: status === 'STARTED' ? 'revision' : null,
      createdByStaff: staffId,
      uploadedDocumentIds: [],
    },
  });
  const document = await owner.document.create({
    data: {
      tenantId,
      clientId,
      title: 'Versehentlicher Ausweis',
      classification: 'GWG_EVIDENCE',
      mimeType: 'application/pdf',
      gwgOnboardingInviteId: invite.id,
      versions: {
        create: {
          versionNo: 1,
          storageBucket: 'taxtronik-gwg',
          storageKey: `${tenantId}/${invite.id}.pdf`,
          storageVersionId: `version-${invite.id}`,
          sha256: Buffer.alloc(32, 1),
          sizeBytes: 1n,
          // Der offene Positivfall beweist die kontrollierte Ausnahme vom
          // Immutable-Guard. Der bereits eingereichte Negativfall braucht nur
          // den Lifecycle-Guard und bleibt für das Fixture-Cleanup mutable.
          immutable: status === 'STARTED',
          scanStatus: 'CLEAN',
          scanCompletedAt: new Date(),
          createdById: staffId,
        },
      },
    },
  });
  await owner.gwgOnboardingInvite.update({
    where: { id: invite.id },
    data: { uploadedDocumentIds: [document.id] },
  });
  return { inviteId: invite.id, documentId: document.id };
}

describe('GwG onboarding document discard migration', () => {
  it('begrenzt das Hard-Delete auf offene, unverknüpfte Invite-Belege im Systemkontext', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION app.discard_open_gwg_onboarding_document',
    );
    expect(migration).toContain("app.current_actor_type() IS DISTINCT FROM 'SYSTEM'");
    expect(migration).toContain('inv."status" IN (\'PENDING\'');
    expect(migration).toContain('inv."expires_at" > CURRENT_TIMESTAMP');
    expect(migration).toContain('NOT EXISTS (\n       SELECT 1 FROM public."gwg_id_document"');
    expect(migration).toContain("set_config('app.gwg_discard_document_id'");
    expect(migration).toContain(
      "to_regprocedure(\n             'app.discard_open_gwg_onboarding_document(uuid,uuid)'",
    );
  });

  it('erteilt der App nur EXECUTE auf den kontrollierten Pfad', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION app.discard_open_gwg_onboarding_document(UUID, UUID) FROM PUBLIC;',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION app.discard_open_gwg_onboarding_document(UUID, UUID) TO taxtronik_app;',
    );
  });

  it('löscht genau einen offenen, unverknüpften Invite-Beleg über die App-Rolle', async () => {
    const target = await createInviteDocument('STARTED');
    await app.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('app.current_tenant_id', ${tenantId}, true),
               set_config('app.current_actor_id', '', true),
               set_config('app.current_actor_type', 'SYSTEM', true)
      `;
      const result = await tx.$queryRaw<Array<{ discarded: number }>>(Prisma.sql`
        SELECT app.discard_open_gwg_onboarding_document(
          ${target.inviteId}::uuid,
          ${target.documentId}::uuid
        ) AS discarded
      `);
      expect(result).toEqual([{ discarded: 1 }]);
    });

    expect(await owner.document.findUnique({ where: { id: target.documentId } })).toBeNull();
    const invite = await owner.gwgOnboardingInvite.findUniqueOrThrow({
      where: { id: target.inviteId },
      select: { uploadedDocumentIds: true },
    });
    expect(invite.uploadedDocumentIds).toEqual([]);
  });

  it('verweigert denselben Hard-Delete nach dem Submit', async () => {
    const target = await createInviteDocument('SUBMITTED');
    await expect(
      app.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT set_config('app.current_tenant_id', ${tenantId}, true),
                 set_config('app.current_actor_id', '', true),
                 set_config('app.current_actor_type', 'SYSTEM', true)
        `;
        return tx.$queryRaw(Prisma.sql`
          SELECT app.discard_open_gwg_onboarding_document(
            ${target.inviteId}::uuid,
            ${target.documentId}::uuid
          )
        `);
      }),
    ).rejects.toThrow(/nicht mehr verwerfbar/);
    expect(await owner.document.findUnique({ where: { id: target.documentId } })).not.toBeNull();
  });
});
