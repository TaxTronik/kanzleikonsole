// Fachkatalog: DOC-UPLOAD-JOURNAL-001
// Fachkatalog: DOC-OBJECT-LOCK-001
// Fachkatalog: DSGVO-OPERATIONAL-RETENTION-001
// =============================================================================
// K-06: storage-orphan-cleanup gegen echtes PostgreSQL.
//
// Die Upload-Pfade journalisieren ihre Speicherabsicht vor dem Object-Write
// (`storage_orphan.intent = TRUE`, Zeilenform wie journalStorageIntents in
// apps/web/src/server/documents/storage-intent.ts). Dieser Test legt genau
// solche Zeilen an und belegt, dass der Worker die nach einem Prozessabbruch
// offenen Absichten auflöst:
//   (1) Abbruch zwischen PUT und DB-Commit: Objekt vorhanden, unreferenziert
//       -> Version recovern, binden, versionsgenau löschen (DELETED).
//   (2) Abbruch vor dem PUT bzw. gescheiterter PUT: kein Objekt -> ABSENT.
//   (3) Fachcommit lief, Abschluss fehlt: Dokumentversion referenziert den
//       Schlüssel -> REFERENCED, nichts wird gelöscht.
//   (4) Object Lock: erst nach dem gespeicherten Retention-Ende.
//   (5) Nach gescheitertem Commit gebundene Version: direkt löschen.
//   (6) Risikoanalyse verweist auf Rohergebnis bzw. Archiv-Snapshot (ohne
//       Versionsspalte): REFERENCED, nichts wird gelöscht.
//   (7) B14: Der verbleibende Rückstand wird je Tenant mit der Fälligkeit des
//       ältesten Kandidaten gemessen (Prisma-groupBy gegen PostgreSQL); Alarm
//       und Kennzahl selbst prüft maintenance-backlog.test.ts.
//
// Der Object Store ist eine Attrappe; Auswahl, Claims, Constraints (ABSENT nur
// für Absichten) und Statusübergänge laufen gegen die migrierte Datenbank.
// Nur mit ausdrücklichem Opt-in (WORKER_DB_TEST=1). Die Zeilen tragen ein
// Erstellungsdatum im Jahr 2001, der Lauf ein `now` kurz danach: Fremde
// Zeilen derselben Datenbank sind dadurch nicht fällig.
// =============================================================================

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// B-02: lokal per WORKER_DB_TEST=1, im db-CI-Job per DB_TESTS=1 (Glob über alle
// *-db.test.ts). In CI scheitert die Suite ohne Opt-in, statt still übersprungen zu werden.
const enabled = process.env['WORKER_DB_TEST'] === '1' || process.env['DB_TESTS'] === '1';
if (!enabled && process.env['CI'] === 'true') {
  throw new Error(
    'WORKER_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}
if (enabled) {
  let url: URL;
  try {
    url = new URL(process.env['DATABASE_URL'] ?? '');
  } catch {
    throw new Error('WORKER_DB_TEST requires a valid DATABASE_URL.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.pathname.length < 2 ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  ) {
    throw new Error('WORKER_DB_TEST requires a loopback PostgreSQL DATABASE_URL.');
  }
}

interface FakeObject {
  versionId: string;
  sha256: Buffer;
  sizeBytes: bigint;
}

const h = vi.hoisted(() => ({
  objects: new Map<string, FakeObject>(),
  deleted: [] as string[],
  recordBacklog: vi.fn(async (_job: string, tenants: Array<{ count: number }>, _now?: Date) => ({
    count: tenants.reduce((sum, tenant) => sum + tenant.count, 0),
  })),
}));

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {}, queues: {} }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../maintenance-backlog', () => ({ recordMaintenanceBacklog: h.recordBacklog }));
vi.mock('@taxtronik/storage', () => ({
  recoverPreparedBytesCommit: async (prepared: {
    targetBucket: string;
    targetKey: string;
    sha256: Buffer;
    sizeBytes: bigint;
  }) => {
    const object = h.objects.get(`${prepared.targetBucket}/${prepared.targetKey}`);
    if (!object) return null;
    if (!object.sha256.equals(prepared.sha256) || object.sizeBytes !== prepared.sizeBytes) {
      throw new Error('PREPARED_UPLOAD_MISMATCH');
    }
    return { ...prepared, storageVersionId: object.versionId };
  },
  deleteObjectVersion: async (bucket: string, key: string, versionId: string) => {
    h.deleted.push(`${bucket}/${key}@${versionId}`);
    h.objects.delete(`${bucket}/${key}`);
  },
}));

import { prismaOwner } from '../../prisma-owner';
import { runStorageOrphanCleanup } from '../storage-orphan-cleanup';

const CREATED_AT = new Date('2001-01-01T00:00:00.000Z');
const NOW = new Date('2001-01-01T01:00:00.000Z');
const LATER = new Date('2001-06-01T00:00:00.000Z');

const describeDb = enabled ? describe : describe.skip;

describeDb('K-06 storage-orphan-cleanup resolves journaled upload intents (PostgreSQL)', () => {
  let tenantId = '';
  let staffId = '';
  let documentId = '';

  beforeAll(async () => {
    const suffix = randomUUID();
    tenantId = (
      await prismaOwner.tenant.create({
        data: { slug: `intent-cleanup-${suffix}`, name: 'Synthetic intent cleanup' },
      })
    ).id;
    staffId = (
      await prismaOwner.staffUser.create({
        data: {
          tenantId,
          email: `${suffix}@example.test`,
          fullName: 'Synthetic staff',
          passwordHash: 'x',
        },
      })
    ).id;
    documentId = (
      await prismaOwner.document.create({
        data: {
          tenantId,
          ownerStaffId: staffId,
          title: 'Synthetic upload',
          classification: 'GENERAL',
          mimeType: 'application/pdf',
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (tenantId) {
      await prismaOwner.storageOrphan.deleteMany({ where: { tenantId } });
      await prismaOwner.tenant.delete({ where: { id: tenantId } });
    }
  });

  beforeEach(async () => {
    h.objects.clear();
    h.deleted.length = 0;
    h.recordBacklog.mockClear();
    await prismaOwner.storageOrphan.deleteMany({ where: { tenantId } });
  });

  /** Zeile wie journalStorageIntents (Web) sie vor dem PUT schreibt. */
  async function journalIntent(input: {
    content: string;
    immutable?: boolean;
    retentionUntil?: Date | null;
    source?: string;
  }) {
    const bytes = Buffer.from(input.content);
    const key = `tenants/${tenantId}/${input.immutable ? 'gobd' : 'none'}/2001/01/${randomUUID()}.bin`;
    const row = await prismaOwner.storageOrphan.create({
      data: {
        tenantId,
        source: input.source ?? 'staff.document.commit',
        intent: true,
        storageBucket: input.immutable ? 'gobd' : 'general',
        storageKey: key,
        storageVersionId: '',
        sha256: new Uint8Array(createHash('sha256').update(bytes).digest()),
        sizeBytes: BigInt(bytes.length),
        immutable: input.immutable ?? false,
        retentionUntil: input.retentionUntil ?? null,
        createdAt: CREATED_AT,
      },
    });
    return { row, bytes };
  }

  /** Bedingter PUT der Absicht ist gelandet (der Prozess bricht danach ab). */
  function putObject(row: { storageBucket: string; storageKey: string }, bytes: Buffer) {
    const versionId = `v-${randomUUID()}`;
    h.objects.set(`${row.storageBucket}/${row.storageKey}`, {
      versionId,
      sha256: createHash('sha256').update(bytes).digest(),
      sizeBytes: BigInt(bytes.length),
    });
    return versionId;
  }

  const load = (id: string) => prismaOwner.storageOrphan.findUniqueOrThrow({ where: { id } });

  it('(1) loescht das nach Abbruch zwischen PUT und DB-Commit unreferenzierte Objekt', async () => {
    const { row, bytes } = await journalIntent({ content: 'crash after put' });
    const versionId = putObject(row, bytes);

    const result = await runStorageOrphanCleanup(NOW);

    expect(result).toMatchObject({ claimed: 1, deleted: 1, absent: 0, failed: 0, backlog: 0 });
    expect(h.deleted).toEqual([`${row.storageBucket}/${row.storageKey}@${versionId}`]);
    await expect(load(row.id)).resolves.toMatchObject({
      resolution: 'DELETED',
      storageVersionId: versionId,
      cleanedAt: expect.any(Date),
      cleanupClaimedAt: null,
    });
  });

  it('(2) schliesst eine nie geschriebene Absicht als ABSENT ab', async () => {
    const { row } = await journalIntent({ content: 'crash before put' });

    const result = await runStorageOrphanCleanup(NOW);

    expect(result).toMatchObject({ claimed: 1, deleted: 0, absent: 1, failed: 0 });
    expect(h.deleted).toEqual([]);
    await expect(load(row.id)).resolves.toMatchObject({
      resolution: 'ABSENT',
      storageVersionId: '',
      cleanedAt: expect.any(Date),
    });
  });

  it('(3) markiert eine committete Referenz als REFERENCED und loescht nichts', async () => {
    const { row, bytes } = await journalIntent({ content: 'committed, settle lost' });
    const versionId = putObject(row, bytes);
    await prismaOwner.documentVersion.create({
      data: {
        documentId,
        versionNo: 1,
        storageBucket: row.storageBucket,
        storageKey: row.storageKey,
        storageVersionId: versionId,
        sha256: row.sha256,
        sizeBytes: row.sizeBytes,
        immutable: false,
        scanStatus: 'CLEAN',
        scanCompletedAt: CREATED_AT,
        createdById: staffId,
      },
    });

    const result = await runStorageOrphanCleanup(NOW);

    expect(result).toMatchObject({ claimed: 1, referenced: 1, deleted: 0 });
    expect(h.deleted).toEqual([]);
    expect(h.objects.size).toBe(1);
    await expect(load(row.id)).resolves.toMatchObject({ resolution: 'REFERENCED' });
  });

  it('(4) laesst ein Object-Lock-Objekt bis zum Retention-Ende offen und loescht danach', async () => {
    const retentionUntil = new Date('2001-03-01T00:00:00.000Z');
    const { row, bytes } = await journalIntent({
      content: 'gobd crash after put',
      immutable: true,
      retentionUntil,
    });
    const versionId = putObject(row, bytes);

    expect(await runStorageOrphanCleanup(NOW)).toMatchObject({ claimed: 0, backlog: 0 });
    await expect(load(row.id)).resolves.toMatchObject({ resolution: null, cleanedAt: null });

    expect(await runStorageOrphanCleanup(LATER)).toMatchObject({ claimed: 1, deleted: 1 });
    expect(h.deleted).toEqual([`${row.storageBucket}/${row.storageKey}@${versionId}`]);
  });

  it('(5) loescht nach gescheitertem Commit die gebundene Version ohne Recovery', async () => {
    const { row, bytes } = await journalIntent({ content: 'commit failed' });
    const versionId = putObject(row, bytes);
    // releaseStorageIntent: Version und Fehler binden, Absicht offen lassen.
    await prismaOwner.storageOrphan.update({
      where: { id: row.id },
      data: { storageVersionId: versionId, failure: 'REFERENCE_CHANGED' },
    });
    h.objects.delete(`${row.storageBucket}/${row.storageKey}`);

    const result = await runStorageOrphanCleanup(NOW);

    expect(result).toMatchObject({ claimed: 1, deleted: 1 });
    expect(h.deleted).toEqual([`${row.storageBucket}/${row.storageKey}@${versionId}`]);
  });

  it('(6) wertet Rohergebnis- und Archivverweise einer Risikoanalyse als Bezug', async () => {
    // Retention-Ende vor NOW: Die GoBD-Absichten sind faellig.
    const retentionUntil = new Date('2001-01-01T00:30:00.000Z');
    const raw = await journalIntent({
      content: 'engine raw result',
      immutable: true,
      retentionUntil,
      source: 'risk.analysis.raw_result',
    });
    const archive = await journalIntent({
      content: 'archive snapshot',
      immutable: true,
      retentionUntil,
      source: 'risk.analysis.archive',
    });
    putObject(raw.row, raw.bytes);
    putObject(archive.row, archive.bytes);
    // Verlorenes COMMIT-ACK: Die Analyse traegt beide Verweise, die Absichten
    // sind (nach nachgelagerter Kompensation) wieder offen.
    const analysis = await prismaOwner.riskAnalysis.create({
      data: {
        tenantId,
        sourceText: 'Synthetischer Sachverhalt',
        textHash: 'synthetic-hash',
        katalogVersion: 'katalog',
        engineVersion: 'engine',
        createdById: staffId,
        rawResultBucket: raw.row.storageBucket,
        rawResultKey: raw.row.storageKey,
      },
    });
    await prismaOwner.riskAnalysis.update({
      where: { id: analysis.id },
      data: {
        archivedAt: CREATED_AT,
        archiveBucket: archive.row.storageBucket,
        archiveKey: archive.row.storageKey,
      },
    });

    const result = await runStorageOrphanCleanup(NOW);

    expect(result).toMatchObject({ claimed: 2, referenced: 2, deleted: 0, incidents: 0 });
    expect(h.deleted).toEqual([]);
    expect(h.objects.size).toBe(2);
    await expect(load(raw.row.id)).resolves.toMatchObject({ resolution: 'REFERENCED' });
    await expect(load(archive.row.id)).resolves.toMatchObject({ resolution: 'REFERENCED' });
  });

  it('(7) B14: misst den verbleibenden Rückstand je Tenant samt Fälligkeit des ältesten', async () => {
    // Nachträglich journalisierter Orphan ohne auffindbare Bytes: bleibt fällig.
    const failing = await journalIntent({ content: 'missing bytes' });
    await prismaOwner.storageOrphan.update({
      where: { id: failing.row.id },
      data: { intent: false },
    });
    // Object Lock: fällig erst mit dem Retention-Ende, danach aber gleich alt.
    const retentionUntil = new Date('2001-01-01T00:45:00.000Z');
    const locked = await journalIntent({ content: 'locked', immutable: true, retentionUntil });
    await prismaOwner.storageOrphan.update({
      where: { id: locked.row.id },
      data: { intent: false },
    });

    const result = await runStorageOrphanCleanup(NOW);

    expect(result).toMatchObject({ claimed: 2, failed: 2, backlog: 2 });
    expect(h.recordBacklog).toHaveBeenCalledTimes(1);
    const [job, tenants, at] = h.recordBacklog.mock.calls[0]!;
    expect(job).toBe('storageOrphanCleanup');
    expect(at).toBe(NOW);
    // Fremde Zeilen derselben Datenbank sind 2001 nicht fällig (siehe Kopf).
    expect(tenants).toEqual([
      // Frist 30 min nach Erstellung (00:30) liegt vor dem Retention-Ende (00:45).
      { tenantId, count: 2, oldestDueAt: new Date('2001-01-01T00:30:00.000Z') },
    ]);
  });
});
