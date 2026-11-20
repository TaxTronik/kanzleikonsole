// BACKUP-DRILL-INTEGRITY-001 / AUDIT-HASH-CHAIN-001: only the disposable CI clone.
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { prismaOwner } from '@taxtronik/db';
import { EvidenceService, LocalTimestampAdapter } from '@taxtronik/evidence';

async function main() {
  const [manifest] = process.argv.slice(2);
  const expectedDb = process.env['PGDATABASE'];
  if (
    !manifest ||
    process.env['CI'] !== 'true' ||
    !/^taxtronik_restore_fixture_[a-f0-9]{24}$/.test(expectedDb ?? '')
  ) {
    throw new Error('Die Restore-Fixture verlangt die eigene CI-Wegwerfdatenbank.');
  }
  const evidence = new EvidenceService(new LocalTimestampAdapter());
  const reference = await prismaOwner.$transaction(async (tx) => {
    const [db] = await tx.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    if (db?.name !== expectedDb) throw new Error('Falsche Zieldatenbank für die Restore-Fixture.');
    const tenant = await tx.tenant.create({
      data: { slug: `restore-ci-${randomUUID()}`, name: 'Synthetische Restore-Prüfung' },
    });
    const event = {
      tenantId: tenant.id,
      actorType: 'SYSTEM' as const,
      actorId: null,
      resourceType: 'restore.fixture',
    };
    const first = await evidence.record(tx, { ...event, action: 'restore.fixture.opened' });
    const last = await evidence.record(tx, { ...event, action: 'restore.fixture.closed' });
    if (!Buffer.from(last.prevHash).equals(first.thisHash))
      throw new Error('Fehlender Hashvorgänger in der Fixture.');
    return `${tenant.id}:${last.thisHash.toString('hex')}`;
  });
  await writeFile(manifest, reference, { flag: 'wx', mode: 0o600 });
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prismaOwner.$disconnect());
