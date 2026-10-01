// RISK-ARCHIVE-SNAPSHOT-001, RISK-AI-SUGGESTION-001,
// DSGVO-MANDATE-ANONYMIZATION-001: real PostgreSQL writers, app-role RLS and locks.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient, Prisma } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';
import {
  commitRiskArchiveTx,
  readRiskArchiveStateTx,
  requireWritableRiskAnalysisTx,
  requireWritableRiskMarkingTx,
  riskArchiveStateHash,
  lockClientRiskAnalysesTx,
} from '../risk-analysis';

const connection = (url: string | undefined) =>
  new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(url)),
  });
const owner = connection(process.env.DATABASE_URL);
const app = connection(process.env.DATABASE_APP_URL);
const racer = connection(process.env.DATABASE_APP_URL);
let tenantId: string;
let staffId: string;
let clientId: string;
let analysisId: string;
let markingId: string;
let evidence: {
  record(
    tx: TxClient,
    event: {
      tenantId: string;
      actorType: 'STAFF';
      actorId: string;
      action: string;
      resourceType: string;
      resourceId: string;
    },
  ): Promise<unknown>;
};
const record = (tx: TxClient, action: string) =>
  evidence.record(tx, {
    tenantId,
    actorType: 'STAFF',
    actorId: staffId,
    action,
    resourceType: 'risk_analysis',
    resourceId: analysisId,
  });

async function context(tx: TxClient) {
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '8s'");
  await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true),
    set_config('app.current_actor_type', 'STAFF', true), set_config('app.current_actor_id', ${staffId}, true)`;
}
function transaction<T>(fn: (tx: TxClient) => Promise<T>, db = app) {
  return db.$transaction(
    async (tx) => {
      await context(tx);
      return fn(tx);
    },
    { timeout: 12_000 },
  );
}
class TestRollback extends Error {}
// Real audit rows are append-only. These lock-order probes roll back their
// complete transactions after exercising the production audit append, instead
// of disabling any audit guard to clean up a test tenant afterwards.
async function rollbackTransaction(fn: (tx: TxClient) => Promise<void>, db = app) {
  try {
    await transaction(async (tx) => {
      await fn(tx);
      throw new TestRollback();
    }, db);
  } catch (error) {
    if (!(error instanceof TestRollback)) throw error;
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function backendId(tx: TxClient) {
  const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::integer AS pid`;
  return row!.pid;
}
async function waitsFor(pid: number, blocker: number) {
  for (let i = 0; i < 200; i++) {
    const [row] = await owner.$queryRaw<Array<{ blockers: number[] }>>`
      SELECT pg_blocking_pids(${pid}::integer) AS blockers`;
    if (row?.blockers.includes(blocker)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}
async function pendingArchive(key = 'unique-attempt-1') {
  const state = await transaction((tx) => readRiskArchiveStateTx(tx, tenantId, analysisId));
  return {
    tenantId,
    analysisId,
    expectedStateHash: riskArchiveStateHash(state),
    archivedAt: new Date(),
    bucket: 'synthetic-gobd',
    key,
  };
}
const markingData = () => ({
  tenantId,
  analysisId,
  start: 0,
  end: 4,
  matchedText: 'Text',
  herkunft: 'BERATER' as const,
  begriff: 'Synthetic',
  normAnker: [],
  notiz: 'Private note',
});

beforeAll(async () => {
  // Actual production audit lock/append logic, without introducing a circular
  // package dependency from db to evidence solely for this integration test.
  const evidencePath = new URL('../../../evidence/src/service.ts', import.meta.url).href;
  const { EvidenceService } = await import(evidencePath);
  evidence = new EvidenceService({}); // record() does not use a timestamp port.
  const stamp = Date.now();
  tenantId = (
    await owner.tenant.create({
      data: { slug: `risk-archive-${stamp}`, name: 'Synthetic risk archive' },
    })
  ).id;
  staffId = (
    await owner.staffUser.create({
      data: {
        tenantId,
        email: `risk-${stamp}@example.test`,
        fullName: 'Synthetic reviewer',
        passwordHash: 'x',
        active: true,
      },
    })
  ).id;
  await owner.staffRole.create({ data: { staffUserId: staffId, role: 'ADMIN' } });
});
beforeEach(async () => {
  clientId = (
    await owner.client.create({ data: { tenantId, name: 'Synthetic person', kind: 'NATPERS' } })
  ).id;
  const analysis = await owner.riskAnalysis.create({
    data: {
      tenantId,
      clientId,
      createdById: staffId,
      sourceText: 'Text source',
      sourceDoc: { type: 'doc', content: [] },
      textHash: 'synthetic',
      katalogVersion: 'test-1',
      engineVersion: 'test-1',
    },
  });
  analysisId = analysis.id;
  markingId = (await owner.riskMarking.create({ data: markingData() })).id;
});
afterAll(async () => {
  if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
  await Promise.all([owner.$disconnect(), app.$disconnect(), racer.$disconnect()]);
});

describe('RISK-ARCHIVE-SNAPSHOT-001 exact content compare after external I/O', () => {
  const changes: Array<{ name: string; change: (tx: TxClient) => Promise<unknown> }> = [
    {
      name: 'title',
      change: (tx) =>
        tx.riskAnalysis.update({ where: { id: analysisId }, data: { title: 'new title' } }),
    },
    {
      name: 'rich document',
      change: (tx) =>
        tx.riskAnalysis.update({
          where: { id: analysisId },
          data: { sourceDoc: { type: 'doc', content: ['changed'] } },
        }),
    },
    {
      name: 'worker enrichment',
      change: (tx) =>
        tx.riskAnalysis.update({ where: { id: analysisId }, data: { llmEnrichedAt: new Date() } }),
    },
    {
      name: 'marking update',
      change: (tx) =>
        tx.riskMarking.update({ where: { id: markingId }, data: { notiz: 'changed' } }),
    },
    {
      name: 'nested marking insert',
      change: (tx) =>
        tx.riskAnalysis.update({
          where: { id: analysisId },
          data: {
            markings: {
              create: {
                tenantId,
                start: 5,
                end: 11,
                matchedText: 'source',
                herkunft: 'LLM',
                begriff: 'Another',
                normAnker: [],
              },
            },
          },
        }),
    },
    { name: 'marking delete', change: (tx) => tx.riskMarking.delete({ where: { id: markingId } }) },
    {
      name: 'client display metadata',
      change: (tx) => tx.client.update({ where: { id: clientId }, data: { name: 'Renamed' } }),
    },
  ];
  it.each(changes)('rejects an uploaded stale snapshot after $name', async ({ change }) => {
    const input = await pendingArchive();
    await transaction(change);
    await expect(transaction((tx) => commitRiskArchiveTx(tx, input))).rejects.toThrow(
      /zwischenzeitlich geändert/,
    );
    expect(
      (await owner.riskAnalysis.findUniqueOrThrow({ where: { id: analysisId } })).archivedAt,
    ).toBeNull();
  });

  it('embeds rich content and deterministically orders offset ties; confidentiality stays live', async () => {
    await owner.riskMarking.create({ data: markingData() });
    const state = await transaction((tx) => readRiskArchiveStateTx(tx, tenantId, analysisId));
    expect(state.sourceDoc).toEqual({ type: 'doc', content: [] });
    expect(state.markings.map((m) => m.id)).toEqual(state.markings.map((m) => m.id).sort());
    const input = await pendingArchive();
    await transaction((tx) =>
      tx.riskAnalysis.update({ where: { id: analysisId }, data: { vertraulich: true } }),
    );
    await transaction((tx) => commitRiskArchiveTx(tx, input));
    await transaction((tx) =>
      tx.riskAnalysis.update({ where: { id: analysisId }, data: { vertraulich: false } }),
    );
  });
});

describe('RISK-ARCHIVE-SNAPSHOT-001 real concurrent writers', () => {
  const writers = [
    {
      name: 'normal marking service lock',
      write: async (tx: TxClient) => {
        await requireWritableRiskMarkingTx(tx, tenantId, markingId);
        return tx.riskMarking.update({ where: { id: markingId }, data: { notiz: 'too late' } });
      },
    },
    {
      name: 'raw SQL child update bypass',
      write: (tx: TxClient) => tx.$executeRaw`
      UPDATE public.risk_marking SET notiz = 'too late' WHERE id = ${markingId}::uuid`,
    },
    {
      name: 'nested child insertion bypass',
      write: (tx: TxClient) =>
        tx.riskAnalysis.update({
          where: { id: analysisId },
          data: {
            markings: {
              create: {
                tenantId,
                start: 0,
                end: 1,
                matchedText: 'T',
                herkunft: 'LLM',
                begriff: 'late',
                normAnker: [],
              },
            },
          },
        }),
    },
  ];
  it.each(writers)('$name waits for archive then fails closed', async ({ write }) => {
    const input = await pendingArchive();
    const locked = deferred<number>();
    const release = deferred<void>();
    const writerPid = deferred<number>();
    const archiving = transaction(async (tx) => {
      await commitRiskArchiveTx(tx, input);
      locked.resolve(await backendId(tx));
      await release.promise;
    });
    let writing: Promise<unknown> | undefined;
    let writingResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const blocker = await Promise.race([
        locked.promise,
        archiving.then(() => {
          throw new Error('archive lock absent');
        }),
      ]);
      writing = transaction(async (tx) => {
        writerPid.resolve(await backendId(tx));
        return write(tx);
      }, racer);
      writingResult = Promise.allSettled([writing]);
      expect(await waitsFor(await writerPid.promise, blocker)).toBe(true);
    } finally {
      release.resolve();
      await archiving;
    }
    expect((await writingResult!)[0]!.status).toBe('rejected');
    const live = await owner.riskAnalysis.findUniqueOrThrow({
      where: { id: analysisId },
      include: { markings: true },
    });
    expect(live.markings).toHaveLength(1);
    expect(live.markings[0]!.notiz).toBe('Private note');
    expect(live.archiveKey).toBe(input.key);
  });

  it('a raw child writer holds the parent lock; subsequent archive CAS sees its committed edit', async () => {
    const input = await pendingArchive();
    const locked = deferred<number>();
    const release = deferred<void>();
    const archivePid = deferred<number>();
    const writing = transaction(async (tx) => {
      await tx.$executeRaw`UPDATE public.risk_marking SET notiz = 'new committed note' WHERE id = ${markingId}::uuid`;
      locked.resolve(await backendId(tx));
      await release.promise;
    });
    let archivingResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const blocker = await Promise.race([
        locked.promise,
        writing.then(() => {
          throw new Error('writer lock absent');
        }),
      ]);
      const archiving = transaction(async (tx) => {
        archivePid.resolve(await backendId(tx));
        await commitRiskArchiveTx(tx, input);
      }, racer);
      archivingResult = Promise.allSettled([archiving]);
      expect(await waitsFor(await archivePid.promise, blocker)).toBe(true);
    } finally {
      release.resolve();
      await writing;
    }
    const result = (await archivingResult!)[0]!;
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected')
      expect(String(result.reason)).toContain('zwischenzeitlich geändert');
  });

  it('two uploads can only commit one pointer; the second waits and cannot replace it', async () => {
    const first = await pendingArchive('attempt-one');
    const second = await pendingArchive('attempt-two');
    const locked = deferred<number>();
    const release = deferred<void>();
    const secondPid = deferred<number>();
    const winning = transaction(async (tx) => {
      await commitRiskArchiveTx(tx, first);
      locked.resolve(await backendId(tx));
      await release.promise;
    });
    let losingResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const blocker = await Promise.race([
        locked.promise,
        winning.then(() => {
          throw new Error('archive lock absent');
        }),
      ]);
      const losing = transaction(async (tx) => {
        secondPid.resolve(await backendId(tx));
        await commitRiskArchiveTx(tx, second);
      }, racer);
      losingResult = Promise.allSettled([losing]);
      expect(await waitsFor(await secondPid.promise, blocker)).toBe(true);
    } finally {
      release.resolve();
      await winning;
    }
    expect((await losingResult!)[0]!.status).toBe('rejected');
    expect(
      (await owner.riskAnalysis.findUniqueOrThrow({ where: { id: analysisId } })).archiveKey,
    ).toBe('attempt-one');
  });
});

describe('RISK-ARCHIVE-SNAPSHOT-001 / DSGVO-MANDATE-ANONYMIZATION-001 cross-workflow lock order', () => {
  it.each(['archive', 'delegation'] as const)(
    'client -> risk -> audit serializes %s with contact-auditing retention',
    async (workflow) => {
      await owner.client.update({
        where: { id: clientId },
        data: { mandateEndedAt: new Date('2000-01-01') },
      });
      const input = await pendingArchive();
      const locked = deferred<number>();
      const release = deferred<void>();
      const redactionPid = deferred<number>();
      let redactionHasClient = false;
      const writing = rollbackTransaction(async (tx) => {
        await requireWritableRiskMarkingTx(tx, tenantId, markingId);
        locked.resolve(await backendId(tx));
        await release.promise;
        if (workflow === 'archive') {
          await commitRiskArchiveTx(tx, input);
        } else {
          // The real delegation's FK needs KEY SHARE on client while Risk is held.
          const reminder = await tx.clientReminder.create({
            data: {
              tenantId,
              clientId,
              dueDate: new Date(),
              subject: 'Synthetic delegation',
              createdByStaff: staffId,
            },
          });
          await tx.riskMarking.update({
            where: { id: markingId },
            data: { reminderId: reminder.id, status: 'IN_PRUEFUNG' },
          });
        }
        await record(tx, `synthetic.${workflow}`);
      });
      let redacting: Promise<unknown> | undefined;
      let result: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        const blocker = await Promise.race([
          locked.promise,
          writing.then(() => {
            throw new Error('writer lock absent');
          }),
        ]);
        redacting = rollbackTransaction(async (tx) => {
          redactionPid.resolve(await backendId(tx));
          await tx.$queryRaw`SELECT id FROM public.client WHERE id = ${clientId}::uuid FOR UPDATE`;
          redactionHasClient = true;
          await lockClientRiskAnalysesTx(tx, clientId);
          // Contact anonymization audits before risk side-table redaction.
          await record(tx, 'synthetic.contact.redacted');
          await tx.client.update({ where: { id: clientId }, data: { anonymizedAt: new Date() } });
          await tx.clientReminder.updateMany({
            where: { clientId },
            data: { subject: 'Anonymisiert', notes: null },
          });
          await tx.riskAnalysis.update({
            where: { id: analysisId },
            data: { sourceText: '', sourceDoc: Prisma.DbNull },
          });
          await tx.riskMarking.update({
            where: { id: markingId },
            data: { matchedText: '', notiz: null },
          });
          await record(tx, 'synthetic.client.redacted');
        }, racer);
        result = Promise.allSettled([redacting]);
        expect(await waitsFor(await redactionPid.promise, blocker)).toBe(true);
        // Retention must block on Client, before taking the audit lock or Risk.
        expect(redactionHasClient).toBe(false);
      } finally {
        release.resolve();
        await writing;
      }
      expect((await result!)[0]!.status).toBe('fulfilled');
      expect(
        (await owner.riskAnalysis.findUniqueOrThrow({ where: { id: analysisId } })).sourceText,
      ).toBe('Text source');
    },
  );

  it('an erasure holding client, risk and audit finishes before a waiting archive takes audit (rollback probes)', async () => {
    const input = await pendingArchive();
    const locked = deferred<number>();
    const release = deferred<void>();
    const archivePid = deferred<number>();
    const redacting = rollbackTransaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM public.client WHERE id = ${clientId}::uuid FOR UPDATE`;
      await lockClientRiskAnalysesTx(tx, clientId);
      await record(tx, 'synthetic.contact.redacted');
      locked.resolve(await backendId(tx));
      await release.promise;
      await tx.riskAnalysis.update({
        where: { id: analysisId },
        data: { sourceText: '', sourceDoc: Prisma.DbNull },
      });
      await tx.riskMarking.update({
        where: { id: markingId },
        data: { matchedText: '', notiz: null },
      });
    });
    let result: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const blocker = await Promise.race([
        locked.promise,
        redacting.then(() => {
          throw new Error('retention lock absent');
        }),
      ]);
      const archiving = rollbackTransaction(async (tx) => {
        archivePid.resolve(await backendId(tx));
        await commitRiskArchiveTx(tx, input);
        await record(tx, 'synthetic.archive');
      }, racer);
      result = Promise.allSettled([archiving]);
      expect(await waitsFor(await archivePid.promise, blocker)).toBe(true);
    } finally {
      release.resolve();
      await redacting;
    }
    const outcome = (await result!)[0]!;
    expect(outcome.status).toBe('fulfilled');
  });
});

describe('RISK-ARCHIVE-SNAPSHOT-001 immutable DB boundary and retention exception', () => {
  it('rolls back archive binding if subsequent audit fails in the same transaction', async () => {
    const input = await pendingArchive();
    await expect(
      transaction(async (tx) => {
        await commitRiskArchiveTx(tx, input);
        throw new Error('synthetic audit failure');
      }),
    ).rejects.toThrow('synthetic audit failure');
    const live = await owner.riskAnalysis.findUniqueOrThrow({ where: { id: analysisId } });
    expect(live.archivedAt).toBeNull();
    expect(live.archiveKey).toBeNull();
  });

  it('blocks core fields, reparenting, deletes and owner-worker mutations after archive', async () => {
    const input = await pendingArchive();
    await transaction((tx) => commitRiskArchiveTx(tx, input));
    await expect(
      transaction((tx) =>
        tx.riskAnalysis.update({ where: { id: analysisId }, data: { title: 'bad' } }),
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      transaction((tx) =>
        tx.riskAnalysis.update({ where: { id: analysisId }, data: { archiveKey: 'replace' } }),
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      transaction((tx) => tx.riskAnalysis.delete({ where: { id: analysisId } })),
    ).rejects.toThrow(/immutable/);
    await expect(
      transaction((tx) => tx.riskMarking.delete({ where: { id: markingId } })),
    ).rejects.toThrow(/immutable/);
    await expect(owner.riskMarking.create({ data: markingData() })).rejects.toThrow(/immutable/);
    await expect(
      owner.riskAnalysis.update({ where: { id: analysisId }, data: { llmEnrichedAt: new Date() } }),
    ).rejects.toThrow(/immutable/);
    await expect(
      owner.riskMarking.update({
        where: { id: markingId },
        data: { analysisId: '00000000-0000-4000-8000-000000000001' },
      }),
    ).rejects.toThrow(/identity/);
  });

  it('allows only the existing exact, due NATPERS live redaction; snapshot pointer remains', async () => {
    const input = await pendingArchive();
    await transaction((tx) => commitRiskArchiveTx(tx, input));
    const redact = (tx: TxClient) =>
      tx.riskAnalysis.update({
        where: { id: analysisId },
        data: { sourceText: '', sourceDoc: Prisma.DbNull },
      });
    await expect(transaction(redact)).rejects.toThrow(/immutable/);
    await owner.client.update({
      where: { id: clientId },
      data: { mandateEndedAt: new Date('2000-01-01'), anonymizedAt: new Date() },
    });
    await expect(
      transaction((tx) =>
        tx.riskAnalysis.update({
          where: { id: analysisId },
          data: { sourceText: '', sourceDoc: Prisma.DbNull, title: 'also changed' },
        }),
      ),
    ).rejects.toThrow(/immutable/);
    await transaction(async (tx) => {
      await redact(tx);
      await tx.riskMarking.update({
        where: { id: markingId },
        data: { matchedText: '', notiz: null },
      });
    });
    const live = await owner.riskAnalysis.findUniqueOrThrow({ where: { id: analysisId } });
    expect(live.sourceText).toBe('');
    expect(live.archiveKey).toBe(input.key);
    await expect(
      transaction((tx) =>
        tx.riskMarking.update({ where: { id: markingId }, data: { matchedText: 'repopulate' } }),
      ),
    ).rejects.toThrow(/immutable/);
  });

  it('RISK-AI-SUGGESTION-001 rejects stale source text after redaction even before archive', async () => {
    await owner.riskAnalysis.update({ where: { id: analysisId }, data: { sourceText: '' } });
    await expect(
      transaction((tx) => requireWritableRiskAnalysisTx(tx, tenantId, analysisId, 'Text source')),
    ).rejects.toThrow(/zwischenzeitlich geändert/);
  });
});
