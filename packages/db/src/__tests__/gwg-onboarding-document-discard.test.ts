// Fachkatalog: GWG-SELF-ONBOARDING-001
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma as PrismaTypes } from '@prisma/client';
import { Prisma, PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260819000000_gwg_onboarding_document_discard/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const fkMigration = readFileSync(
  new URL(
    '../../prisma/migrations/20261005100700_gwg_invite_uploads_by_fk/migration.sql',
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

// Review-Finding D-08: Die Zuordnung prüft allein document.gwg_onboarding_invite_id;
// die JSON-Liste wird nur noch für App-Rollbacks mitgeführt.
describe('GwG onboarding document discard über den Fremdschlüssel (D-08)', () => {
  async function openUpload(list: (documentId: string) => PrismaTypes.InputJsonValue) {
    const seed = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const invite = await owner.gwgOnboardingInvite.create({
      data: {
        tenantId,
        clientId,
        inviteEmail: `fk-${seed}@example.test`,
        inviteName: 'Erika Muster',
        tokenHash: `token-fk-${seed}`,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        status: 'STARTED',
        boundClientRevision: 'revision',
        createdByStaff: staffId,
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
            immutable: true,
            scanStatus: 'CLEAN',
            scanCompletedAt: new Date(),
            createdById: staffId,
          },
        },
      },
    });
    await owner.gwgOnboardingInvite.update({
      where: { id: invite.id },
      data: { uploadedDocumentIds: list(document.id) },
    });
    return { inviteId: invite.id, documentId: document.id };
  }

  function discard(inviteId: string, documentId: string) {
    return app.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('app.current_tenant_id', ${tenantId}, true),
               set_config('app.current_actor_id', '', true),
               set_config('app.current_actor_type', 'SYSTEM', true)
      `;
      return tx.$queryRaw<Array<{ discarded: number }>>(Prisma.sql`
        SELECT app.discard_open_gwg_onboarding_document(
          ${inviteId}::uuid,
          ${documentId}::uuid
        ) AS discarded
      `);
    });
  }

  it('ersetzt die Funktion mit unveränderten Attributen und ohne Listenbedingung', async () => {
    const authorization = fkMigration.slice(
      fkMigration.indexOf('PERFORM d."id"'),
      fkMigration.indexOf('FOR UPDATE OF inv, d;'),
    );
    expect(authorization).toContain('ON d."gwg_onboarding_invite_id" = inv."id"');
    expect(authorization).not.toContain('uploaded_document_ids');
    expect(fkMigration).toContain(
      'LANGUAGE plpgsql\nVOLATILE\nSECURITY DEFINER\nSET search_path = pg_catalog, public, app, pg_temp',
    );
    const [fn] = await owner.$queryRaw<
      Array<{ volatile: string; definer: boolean; config: string[]; acl: string }>
    >`
      SELECT provolatile::text AS volatile, prosecdef AS definer, proconfig AS config,
             proacl::text AS acl
        FROM pg_proc
       WHERE oid = 'app.discard_open_gwg_onboarding_document(uuid,uuid)'::regprocedure
    `;
    expect(fn).toMatchObject({
      volatile: 'v',
      definer: true,
      config: ['search_path=pg_catalog, public, app, pg_temp'],
    });
    expect(fn!.acl).toContain('taxtronik_app=X/');
    expect(fn!.acl).not.toMatch(/(^|[{,])=X\//);
  });

  it('verwirft einen finalisierten Upload auch ohne Eintrag in der JSON-Liste', async () => {
    const target = await openUpload(() => []);
    expect(await discard(target.inviteId, target.documentId)).toEqual([{ discarded: 1 }]);
    expect(await owner.document.findUnique({ where: { id: target.documentId } })).toBeNull();
  });

  it('pflegt die JSON-Liste für das vorige Release weiter und lässt andere Einträge stehen', async () => {
    const other = '00000000-0000-4000-8000-0000000d0800';
    const target = await openUpload((documentId) => [other, documentId]);
    const stale = new Date('2020-01-01T00:00:00.000Z');
    await owner.gwgOnboardingInvite.update({
      where: { id: target.inviteId },
      data: { updatedAt: stale },
    });
    expect(await discard(target.inviteId, target.documentId)).toEqual([{ discarded: 1 }]);
    const after = await owner.gwgOnboardingInvite.findUniqueOrThrow({
      where: { id: target.inviteId },
      select: { uploadedDocumentIds: true, updatedAt: true },
    });
    expect(after.uploadedDocumentIds).toEqual([other]);
    // Der Zeitstempel geht weiter in den GwG-Fristbeginn nie etablierter Beziehungen ein.
    expect(after.updatedAt.getTime()).toBeGreaterThan(stale.getTime());
  });

  it('bricht bei einer Nicht-Array-Liste nicht ab und lässt sie unverändert', async () => {
    const target = await openUpload(() => ({ legacy: true }));
    expect(await discard(target.inviteId, target.documentId)).toEqual([{ discarded: 1 }]);
    const invite = await owner.gwgOnboardingInvite.findUniqueOrThrow({
      where: { id: target.inviteId },
      select: { uploadedDocumentIds: true },
    });
    expect(invite.uploadedDocumentIds).toEqual({ legacy: true });
  });

  it('gewährt über die JSON-Liste einer anderen Einladung keinen Zugriff', async () => {
    const victim = await openUpload(() => []);
    const attacker = await openUpload(() => []);
    await owner.gwgOnboardingInvite.update({
      where: { id: attacker.inviteId },
      data: { uploadedDocumentIds: [attacker.documentId, victim.documentId] },
    });
    await expect(discard(attacker.inviteId, victim.documentId)).rejects.toThrow(
      /nicht mehr verwerfbar/,
    );
    expect(await owner.document.findUnique({ where: { id: victim.documentId } })).not.toBeNull();
    // Aufräumen über den regulären Pfad; unveränderliche Versionen löscht nur er.
    expect(await discard(victim.inviteId, victim.documentId)).toEqual([{ discarded: 1 }]);
    expect(await discard(attacker.inviteId, attacker.documentId)).toEqual([{ discarded: 1 }]);
  });
});
