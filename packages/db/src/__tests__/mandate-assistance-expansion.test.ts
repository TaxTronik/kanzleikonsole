// Fachkatalog: CLIENT-ASSISTANCE-001
// Fachkatalog: MANDATE-STRUCTURE-001
// Fachkatalog: WORKFLOW-DEPENDENCY-001
// Fachkatalog: CLIENT-OFFBOARDING-001
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { PrismaClient } from '../prisma-client';
import type { Prisma } from '@prisma/client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
const run =
  process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL'] ? describe : describe.skip;
run('mandate and assistance expansion with real SQL guards', () => {
  const owner = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
  });
  const app = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
  });
  let tenantId: string,
    otherTenantId: string,
    staffId: string,
    clientId: string,
    caseId: string,
    revisionId: string,
    outputId: string;
  const items: string[] = [];
  const hash = 'a'.repeat(64);
  async function actor<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    tenant = tenantId,
    type = 'STAFF',
  ) {
    return app.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenant},true),set_config('app.current_actor_id',${staffId},true),set_config('app.current_actor_type',${type},true)`;
      return fn(tx);
    });
  }
  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    tenantId = (
      await owner.tenant.create({
        data: { slug: 'mandate-assistance-' + suffix, name: 'Isolated expansion tests' },
      })
    ).id;
    otherTenantId = (
      await owner.tenant.create({ data: { slug: 'other-mandate-' + suffix, name: 'Other' } })
    ).id;
    staffId = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: suffix + '@example.test',
          fullName: 'Test admin',
          passwordHash: 'x',
          roles: { create: { role: 'ADMIN' } },
        },
      })
    ).id;
    for (let i = 0; i < 3; i++) {
      const client = await owner.client.create({
        data: { tenantId, kind: 'NATPERS', name: 'Test ' + i },
      });
      if (i === 0) clientId = client.id;
      const workflow = await owner.workflowInstance.create({
        data: {
          tenantId,
          clientId: client.id,
          name: 'Test workflow',
          assessmentYear: 2026,
          startedByStaff: staffId,
        },
      });
      items.push(
        (
          await owner.workflowItem.create({
            data: { instanceId: workflow.id, title: 'Test step', position: 0 },
          })
        ).id,
      );
    }
    const schema = { title: 'Captured', version: 1, fields: [] };
    await actor(async (tx) => {
      const item = await tx.clientAssistanceCase.create({
        data: {
          tenantId,
          clientId,
          kind: 'PROCEDURE',
          title: 'Captured',
          schemaSnapshot: schema,
          answers: {},
          revision: 1,
          status: 'DRAFT',
        },
      });
      caseId = item.id;
      const snapshot = {
        version: 1,
        caseId: item.id,
        title: 'Captured',
        kind: 'PROCEDURE',
        revision: 1,
        status: 'DRAFT',
        occurredAt: '2026-08-31T00:00:00.000Z',
        answers: {},
        schema,
        sourceVersionId: null,
        sourceHash: null,
        externalVersionId: null,
        externalHash: null,
        confirmedAt: null,
        reviewNote: null,
        reviewedByStaff: null,
      };
      revisionId = (
        await tx.clientAssistanceRevision.create({
          data: {
            caseId,
            revision: 1,
            answers: {},
            status: 'DRAFT',
            actorId: staffId,
            actorType: 'STAFF',
            snapshot,
            snapshotHash: hash,
          },
        })
      ).id;
      outputId = (
        await tx.clientAssistanceOutput.create({
          data: {
            revisionId,
            format: 'pdf',
            generatorVersion: 'test/1',
            snapshotHash: hash,
            manifest: { snapshotHash: hash },
            createdBy: staffId,
            actorType: 'STAFF',
          },
        })
      ).id;
    });
  });
  // The suite runs in an isolated database. Append-only evidence is intentionally not bypassed for cleanup.
  afterAll(async () => {
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  });
  it('hides assistance data and outputs outside their tenant', async () => {
    expect(
      await actor(
        (tx) => tx.clientAssistanceCase.findMany({ where: { id: caseId } }),
        otherTenantId,
      ),
    ).toEqual([]);
    expect(
      await actor(
        (tx) => tx.clientAssistanceOutput.findMany({ where: { id: outputId } }),
        otherTenantId,
      ),
    ).toEqual([]);
  });
  it('does not rewrite revision history even with a known UUID', async () => {
    await expect(
      actor((tx) =>
        tx.clientAssistanceRevision.update({
          where: { id: revisionId },
          data: { answers: { forged: 'value' } },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      owner.clientAssistanceRevision.delete({ where: { id: revisionId } }),
    ).rejects.toThrow('append only');
  });
  it('rejects source and generator substitutions on a reserved output', async () => {
    await expect(
      actor((tx) =>
        tx.clientAssistanceOutput.update({
          where: { id: outputId },
          data: { generatorVersion: 'forged/2' },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      actor((tx) =>
        tx.clientAssistanceOutput.create({
          data: {
            revisionId,
            format: 'docx',
            generatorVersion: 'test/1',
            snapshotHash: 'b'.repeat(64),
            manifest: {},
            createdBy: staffId,
            actorType: 'STAFF',
          },
        }),
      ),
    ).rejects.toThrow();
  });
  it('does not append a revision that disagrees with the case snapshot', async () => {
    await expect(
      actor((tx) =>
        tx.clientAssistanceRevision.create({
          data: {
            caseId,
            revision: 2,
            answers: {},
            status: 'REVIEWED',
            actorId: staffId,
            actorType: 'STAFF',
            snapshot: {},
            snapshotHash: hash,
          },
        }),
      ),
    ).rejects.toThrow();
  });
  it('rejects cross-tenant structure links at the database boundary', async () => {
    const foreign = await owner.client.create({
      data: { tenantId: otherTenantId, kind: 'NATPERS', name: 'Hidden' },
    });
    const version = await actor((tx) =>
      tx.mandateStructureVersion.create({
        data: { tenantId, clientId, revision: 1, contentHash: hash, createdBy: staffId },
      }),
    );
    await expect(
      actor((tx) =>
        tx.mandateStructureNode.create({
          data: {
            tenantId,
            versionId: version.id,
            nodeKey: 'a',
            kind: 'CLIENT',
            label: 'Injected',
            linkedClientId: foreign.id,
            x: 0,
            y: 0,
          },
        }),
      ),
    ).rejects.toThrow();
  });
  it('serializes dependencies and rejects indirect cycles', async () => {
    for (const [from, to] of [
      [items[0]!, items[1]!],
      [items[1]!, items[2]!],
    ])
      await actor((tx) =>
        tx.workflowDependency.create({
          data: { tenantId, predecessorItemId: from!, successorItemId: to!, createdBy: staffId },
        }),
      );
    await expect(
      actor((tx) =>
        tx.workflowDependency.create({
          data: {
            tenantId,
            predecessorItemId: items[2]!,
            successorItemId: items[0]!,
            createdBy: staffId,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
