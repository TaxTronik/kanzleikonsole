// Fachkatalog: MANDATE-STRUCTURE-001
// Fachkatalog: GWG-BENEFICIAL-OWNERS-001
// Fachkatalog: GWG-RISK-REVIEW-001
// Fachkatalog: GWG-RETENTION-DESTRUCTION-001
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { PrismaClient } from '@taxtronik/db/prisma-client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Prisma } from '@prisma/client';
import type { StaffSession } from '@/server/auth/staff';
import type { TxClient } from '@taxtronik/db';
// Production SQL, scope and mutation services run unchanged; no Next request or external audit service is needed.
vi.mock('@/server/auth/staff', () => ({ staffAuth: vi.fn() }));
vi.mock('@/server/container', () => ({ evidenceService: { record: vi.fn() } }));
const enabled = process.env['MANDATE_SERVICE_DB_TEST'] === '1';
(enabled ? describe : describe.skip)(
  'production mandate services against an isolated PostgreSQL app role',
  () => {
    let owner: InstanceType<typeof PrismaClient>, app: InstanceType<typeof PrismaClient>;
    let tenantId: string,
      clientId: string,
      linkedClientId: string,
      staffId: string,
      employeeId: string,
      checkId: string,
      versionId: string,
      secondVersionId: string,
      bindingId: string;
    let session: StaffSession;
    let structure: typeof import('../service'), gwg: typeof import('../gwg-structure');
    const firstKey = randomUUID(),
      secondKey = randomUUID();
    async function actor<T>(fn: (tx: TxClient) => Promise<T>, actorId = staffId) {
      return app.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id',${tenantId},true),set_config('app.current_actor_id',${actorId},true),set_config('app.current_actor_type','STAFF',true)`;
        return fn(tx as unknown as TxClient);
      });
    }
    beforeAll(async () => {
      for (const name of ['DATABASE_URL', 'DATABASE_APP_URL']) {
        const value = process.env[name];
        if (!value || !new URL(value).pathname.includes('taxtronik_expansion_'))
          throw new Error('This suite requires an explicitly isolated expansion database.');
      }
      owner = new PrismaClient({
        adapter: new PrismaPg({ connectionString: process.env['DATABASE_URL']! }),
      });
      app = new PrismaClient({
        adapter: new PrismaPg({ connectionString: process.env['DATABASE_APP_URL']! }),
      });
      structure = await import('../service');
      gwg = await import('../gwg-structure');
      const suffix = randomUUID();
      tenantId = (
        await owner.tenant.create({
          data: { slug: 'real-mandate-services-' + suffix, name: 'Isolated service tests' },
        })
      ).id;
      staffId = (
        await owner.staffUser.create({
          data: {
            tenantId,
            email: suffix + '@example.test',
            fullName: 'Staff admin',
            passwordHash: 'x',
            roles: { create: { role: 'ADMIN' } },
          },
        })
      ).id;
      employeeId = (
        await owner.staffUser.create({
          data: {
            tenantId,
            email: 'employee-' + suffix + '@example.test',
            fullName: 'Employee',
            passwordHash: 'x',
            roles: { create: { role: 'EMPLOYEE' } },
          },
        })
      ).id;
      clientId = (
        await owner.client.create({ data: { tenantId, kind: 'JURPERS', name: 'Actual mandate' } })
      ).id;
      linkedClientId = (
        await owner.client.create({
          data: {
            tenantId,
            kind: 'JURPERS',
            name: 'Confidential linked mandate',
            vertraulich: true,
          },
        })
      ).id;
      checkId = (await owner.gwgCheck.create({ data: { tenantId, clientId } })).id;
      session = {
        user: { tenantId, staffId, roles: ['ADMIN'], permissions: [] },
      } as unknown as StaffSession;
    });
    afterAll(async () => {
      await Promise.all([owner?.$disconnect(), app?.$disconnect()]);
    });
    const input = (client: string, linked: string, revision: number) => ({
      clientId: client,
      expectedRevision: revision,
      note: 'Explicit direct ownership',
      nodes: [
        {
          key: firstKey,
          kind: 'CLIENT',
          label: 'Forged incoming root name',
          linkedClientId: client,
          x: 10,
          y: 10,
        },
        {
          key: secondKey,
          kind: 'CLIENT',
          label: 'Forged incoming linked name',
          linkedClientId: linked,
          x: 200,
          y: 10,
        },
      ],
      edges: [
        { from: firstKey, to: secondKey, kind: 'CAPITAL', percentage: 60, note: 'Manual source' },
      ],
    });
    it('saves and reloads a structure through actual Prisma SQL locks and immutable rows', async () => {
      versionId = await actor((tx) =>
        structure.saveStructureTx(tx, session, input(clientId, linkedClientId, 0)),
      );
      const stored = await actor((tx) =>
        structure.loadStructureTx(tx, session, clientId, versionId),
      );
      expect(stored?.revision).toBe(1);
      expect(stored?.input.nodes.map((n) => n.label)).toContain('Actual mandate');
      expect(stored?.input.nodes.map((n) => n.label)).not.toContain('Forged incoming root name');
      await expect(
        actor((tx) => structure.saveStructureTx(tx, session, input(clientId, linkedClientId, 0))),
      ).rejects.toThrow('inzwischen');
      await expect(
        actor((tx) =>
          tx.mandateStructureVersion.update({
            where: { id: versionId },
            data: { note: 'replace' },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        actor((tx) =>
          tx.mandateStructureNode.create({
            data: {
              tenantId,
              versionId,
              nodeKey: randomUUID(),
              kind: 'PERSON',
              label: 'Late injection',
              x: 0,
              y: 0,
            },
          }),
        ),
      ).rejects.toThrow('sealed');
    });
    it('binds the exact immutable version to the concrete open check', async () => {
      bindingId = await actor((tx) =>
        gwg.bindGwgStructureTx(tx, session, {
          clientId,
          checkId,
          versionId,
          expectedBindingRevision: 0,
          note: 'Direct sources must be reviewed',
          confirmed: true,
        }),
      );
      const binding = await owner.gwgStructureBinding.findUniqueOrThrow({
        where: { id: bindingId },
      });
      expect(binding.structureVersionId).toBe(versionId);
      expect(binding.revision).toBe(1);
      expect(binding.structureHash).toHaveLength(64);
    });
    it('resets a running review and appends history when another structure version is chosen', async () => {
      await owner.gwgCheck.update({
        where: { id: checkId },
        data: { status: 'IN_REVIEW', reviewSubmittedAt: new Date(), reviewSubmittedBy: staffId },
      });
      secondVersionId = await actor((tx) =>
        structure.saveStructureTx(tx, session, input(clientId, linkedClientId, 1)),
      );
      await actor((tx) =>
        gwg.bindGwgStructureTx(tx, session, {
          clientId,
          checkId,
          versionId: secondVersionId,
          expectedBindingRevision: 1,
          note: 'Changed working basis requires review',
          confirmed: true,
        }),
      );
      const check = await owner.gwgCheck.findUniqueOrThrow({ where: { id: checkId } });
      expect(check.status).toBe('DRAFT');
      expect(check.reviewSubmittedAt).toBeNull();
      expect(check.reviewSubmittedBy).toBeNull();
      expect(
        (await owner.gwgStructureBinding.findUniqueOrThrow({ where: { id: bindingId } }))
          .structureVersionId,
      ).toBe(versionId);
    });
    it('hides binding metadata and all node labels when either linked mandate is inaccessible', async () => {
      expect(
        await actor(
          (tx) => tx.gwgStructureBinding.findMany({ where: { gwgCheckId: checkId } }),
          employeeId,
        ),
      ).toEqual([]);
      const employee = {
        user: { tenantId, staffId: employeeId, roles: ['EMPLOYEE'], permissions: [] },
      } as unknown as StaffSession;
      await expect(
        actor((tx) => structure.loadStructureTx(tx, employee, clientId), employeeId),
      ).rejects.toThrow('Zugriff');
    });
    it('does not permit direct rewrites, deletion, or binding into another mandate', async () => {
      await expect(
        actor((tx) =>
          tx.gwgStructureBinding.update({ where: { id: bindingId }, data: { note: 'forged' } }),
        ),
      ).rejects.toThrow();
      await expect(owner.gwgStructureBinding.delete({ where: { id: bindingId } })).rejects.toThrow(
        'immutable',
      );
      const other = await owner.gwgCheck.create({ data: { tenantId, clientId: linkedClientId } });
      await expect(
        actor((tx) =>
          tx.gwgStructureBinding.create({
            data: {
              tenantId,
              clientId: linkedClientId,
              gwgCheckId: other.id,
              structureVersionId: versionId,
              structureHash: 'a'.repeat(64),
              revision: 1,
              note: 'Cross mandate must be rejected',
              createdBy: staffId,
            },
          }),
        ),
      ).rejects.toThrow();
    });
    it('refuses completed checks without changing the old structure use', async () => {
      const closedClient = await owner.client.create({
        data: { tenantId, kind: 'NATPERS', name: 'Synthetic completed check' },
      });
      const closed = await owner.gwgCheck.create({ data: { tenantId, clientId: closedClient.id } });
      await actor(async (tx) => {
        const doc = await tx.document.create({
          data: {
            tenantId,
            clientId: closedClient.id,
            title: 'Synthetic identity',
            classification: 'GWG_EVIDENCE',
            mimeType: 'image/jpeg',
          },
        });
        await tx.documentVersion.create({
          data: {
            documentId: doc.id,
            versionNo: 1,
            storageBucket: 'isolated-test',
            storageKey: randomUUID(),
            sha256: Buffer.alloc(32, 0x44),
            sizeBytes: 1n,
            scanStatus: 'CLEAN',
            scanCompletedAt: new Date(),
            createdById: staffId,
          },
        });
        await tx.gwgIdDocument.create({
          data: {
            gwgCheckId: closed.id,
            type: 'PERSONALAUSWEIS',
            ownerName: closedClient.name,
            documentId: doc.id,
            naturalClientSubjectId: closedClient.id,
            identityAssignmentConfirmedAt: new Date(),
            identityAssignmentConfirmedBy: staffId,
            number: 'ISOLATED-FIXTURE',
            issuedBy: 'Test fixture',
            issueDate: new Date('2020-01-01'),
            expiryDate: new Date('2099-12-31'),
            verifiedAt: new Date(),
          },
        });
        await tx.gwgCheck.update({
          where: { id: closed.id },
          data: { status: 'VERIFIED', verifiedAt: new Date() },
        });
      });
      await expect(
        actor((tx) =>
          gwg.bindGwgStructureTx(tx, session, {
            clientId: closedClient.id,
            checkId: closed.id,
            versionId: secondVersionId,
            expectedBindingRevision: 0,
            note: 'May not rewrite a completed check',
            confirmed: true,
          }),
        ),
      ).rejects.toThrow('abgeschlossen');
      expect((await owner.gwgCheck.findUniqueOrThrow({ where: { id: closed.id } })).status).toBe(
        'VERIFIED',
      );
      expect(await owner.gwgStructureBinding.count({ where: { gwgCheckId: checkId } })).toBe(2);
    });
    it('purges only the GwG binding content through the existing controlled destruction function', async () => {
      await owner.client.update({
        where: { id: clientId },
        data: { mandateEndedAt: new Date('2010-01-01T00:00:00Z') },
      });
      await actor((tx) => tx.$executeRaw`SELECT app.destroy_gwg_check(${checkId}::uuid)`);
      const purged = await owner.gwgStructureBinding.findUniqueOrThrow({
        where: { id: bindingId },
      });
      expect(purged.destroyedAt).not.toBeNull();
      expect(purged.structureVersionId).toBeNull();
      expect(purged.structureHash).toBeNull();
      expect(purged.note).toBeNull();
      expect(
        await owner.mandateStructureVersion.findUnique({ where: { id: versionId } }),
      ).not.toBeNull();
    });
  },
);
