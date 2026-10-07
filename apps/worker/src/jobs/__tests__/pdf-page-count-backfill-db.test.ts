// Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001, DOC-VERSION-IMMUTABILITY-001
// =============================================================================
// P-13: pdf-page-count-backfill gegen echtes PostgreSQL.
//
// Belegt, was der Mock-Test nicht prüfen kann: die Kandidatenauswahl (genau
// die Versionen, die loadIdentitySourceTx als PDF-Quelle zählen würde), das
// Speichern unter der App-Rolle mit RLS (withSystemContext), die Trigger von
// document_version (Unveränderlichkeitsschutz lässt die abgeleitete Seitenzahl
// zu; zugeordnete GwG-Belege bleiben gesperrt und werden ausgelassen) und die
// Wiederholbarkeit (ein zweiter Lauf findet nichts mehr). Objektspeicher und
// Seitenzählung sind Attrappen; die Läufe sind auf die eigenen Tenants
// begrenzt. Nur mit ausdrücklichem Opt-in (WORKER_DB_TEST=1). Wie die übrigen
// DB-Suiten bleiben die synthetischen Tenants mit ihren unveränderlichen
// Versionen in der Wegwerf-Datenbank.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

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

const h = vi.hoisted(() => {
  class FakeStoredObjectError extends Error {
    constructor(readonly integrityViolation: boolean) {
      super('synthetic storage error');
    }
  }
  return {
    FakeStoredObjectError,
    // Objektschlüssel → Inhalt der Attrappe: Seitenzahl, „unlesbar“ oder Hashabweichung.
    objects: new Map<string, number | 'unreadable' | 'integrity'>(),
    fetched: [] as string[],
  };
});

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {}, queues: {} }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@taxtronik/storage', () => ({
  StoredObjectError: h.FakeStoredObjectError,
  fetchVerifiedObjectBytes: async (ref: { key: string }) => {
    h.fetched.push(ref.key);
    const object = h.objects.get(ref.key);
    if (object === undefined) throw new h.FakeStoredObjectError(false);
    if (object === 'integrity') throw new h.FakeStoredObjectError(true);
    return Buffer.from(String(object));
  },
}));
vi.mock('@taxtronik/mail/pdf-page-count-node', () => ({
  countPdfPagesInWorkerThread: async (bytes: Buffer) => {
    const text = bytes.toString();
    return text === 'unreadable'
      ? { status: 'unreadable', reason: 'parser' }
      : { status: 'counted', pages: Number(text) };
  },
}));

import { prismaOwner } from '../../prisma-owner';
import { runPdfPageCountBackfill } from '../pdf-page-count-backfill';

const describeDb = enabled ? describe : describe.skip;
const NO_LIMIT = { exhausted: () => false };

describeDb('P-13 pdf-page-count-backfill against PostgreSQL', () => {
  // Je Tenant ein Mitarbeiter, ein Mandant und dessen offene GwG-Prüfung: Vor der
  // Freischaltung lässt die GwG-Schranke nur GwG-Belege mit Staff-Kontext zu.
  const tenants = {
    main: { tenantId: '', staffId: '', clientId: '', checkId: '' },
    other: { tenantId: '', staffId: '', clientId: '', checkId: '' },
  };
  // Fixture-Name → Dokument-ID bzw. Versionen in versionNo-Reihenfolge.
  const docs = new Map<string, { documentId: string; versions: string[] }>();

  interface DocSpec {
    name: string;
    tenant?: keyof typeof tenants;
    mimeType?: string;
    versions?: number;
    immutable?: boolean;
    scanStatus?: 'CLEAN' | 'PENDING';
    sizeBytes?: bigint;
    pdfPageCount?: number | null;
    object?: number | 'unreadable' | 'integrity';
  }

  async function createDoc(spec: DocSpec) {
    const { tenantId, staffId, clientId } = tenants[spec.tenant ?? 'main'];
    const created = await prismaOwner.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true),
        set_config('app.current_actor_id', ${staffId}, true),
        set_config('app.current_actor_type', 'STAFF', true)`;
      const document = await tx.document.create({
        data: {
          tenantId,
          clientId,
          title: `P-13 ${spec.name}`,
          classification: 'GWG_EVIDENCE',
          mimeType: spec.mimeType ?? 'application/pdf',
        },
      });
      const versions: Array<{ id: string; key: string }> = [];
      for (let versionNo = 1; versionNo <= (spec.versions ?? 1); versionNo += 1) {
        const key = `tenants/${tenantId}/gwg/${document.id}/v${versionNo}`;
        const clean = (spec.scanStatus ?? 'CLEAN') === 'CLEAN';
        const version = await tx.documentVersion.create({
          data: {
            documentId: document.id,
            versionNo,
            storageBucket: 'gwg-test',
            storageKey: key,
            storageVersionId: clean ? `object-${versionNo}` : null,
            sha256: Buffer.alloc(32, versionNo),
            sizeBytes: spec.sizeBytes ?? 2048n,
            immutable: spec.immutable ?? false,
            scanStatus: spec.scanStatus ?? 'CLEAN',
            scanCompletedAt: clean ? new Date() : null,
            pdfPageCount: spec.pdfPageCount ?? null,
            createdById: staffId,
          },
        });
        versions.push({ id: version.id, key });
      }
      return { documentId: document.id, versions };
    });
    for (const { key } of created.versions) h.objects.set(key, spec.object ?? 3);
    docs.set(spec.name, {
      documentId: created.documentId,
      versions: created.versions.map((version) => version.id),
    });
  }

  async function versionState(name: string, index = -1) {
    const versions = docs.get(name)!.versions;
    return prismaOwner.documentVersion.findUniqueOrThrow({
      where: { id: versions.at(index)! },
      select: { pdfPageCount: true, pdfPageCountCheckedAt: true },
    });
  }

  beforeAll(async () => {
    const suffix = randomUUID();
    for (const [key, entry] of Object.entries(tenants)) {
      entry.tenantId = (
        await prismaOwner.tenant.create({
          data: { slug: `p13-${key}-${suffix}`, name: `P-13 Nachtrag ${key}` },
        })
      ).id;
      entry.staffId = (
        await prismaOwner.staffUser.create({
          data: {
            tenantId: entry.tenantId,
            email: `p13-${key}-${suffix}@example.test`,
            fullName: 'P-13 Admin',
            passwordHash: 'x',
            roles: { create: { role: 'ADMIN' } },
          },
        })
      ).id;
      entry.clientId = (
        await prismaOwner.client.create({
          data: { tenantId: entry.tenantId, kind: 'NATPERS', name: `P-13 Mandant ${key}` },
        })
      ).id;
      entry.checkId = (
        await prismaOwner.gwgCheck.create({
          data: { tenantId: entry.tenantId, clientId: entry.clientId },
        })
      ).id;
    }

    await createDoc({ name: 'eligible', object: 4 });
    await createDoc({ name: 'immutable', immutable: true, object: 2 });
    await createDoc({ name: 'two-versions', versions: 2, object: 5 });
    await createDoc({ name: 'unreadable', object: 'unreadable' });
    await createDoc({ name: 'integrity', object: 'integrity' });
    await createDoc({ name: 'general' });
    await createDoc({ name: 'image', mimeType: 'image/jpeg' });
    await createDoc({ name: 'too-large', sizeBytes: BigInt(25 * 1024 * 1024 + 1) });
    await createDoc({ name: 'pending', scanStatus: 'PENDING' });
    await createDoc({ name: 'already-counted', pdfPageCount: 9 });
    await createDoc({ name: 'deleted' });
    await createDoc({ name: 'destruction' });
    await createDoc({ name: 'assigned' });
    await createDoc({ name: 'other-tenant', tenant: 'other', object: 6 });

    const { staffId, clientId, checkId } = tenants.main;
    // Umgestuft (wie eine Umklassifizierung): kein GwG-Beleg mehr.
    await prismaOwner.document.update({
      where: { id: docs.get('general')!.documentId },
      data: { classification: 'GENERAL' },
    });
    await prismaOwner.document.update({
      where: { id: docs.get('deleted')!.documentId },
      data: { deletedAt: new Date() },
    });
    await prismaOwner.document.update({
      where: { id: docs.get('destruction')!.documentId },
      data: { gwgDestructionRequestedAt: new Date(), gwgDestructionRequestedBy: staffId },
    });
    // Einem Ausweissatz zugeordnet: der Trigger sperrt jede Änderung der Version.
    await prismaOwner.gwgIdDocument.create({
      data: {
        gwgCheckId: checkId,
        type: 'PERSONALAUSWEIS',
        ownerName: 'P-13 Mandant main',
        documentId: docs.get('assigned')!.documentId,
        naturalClientSubjectId: clientId,
        identityAssignmentConfirmedAt: new Date(),
        identityAssignmentConfirmedBy: staffId,
        number: 'P13-FIXTURE',
        issuedBy: 'Testbehoerde',
        issueDate: new Date('2020-01-01T00:00:00.000Z'),
        expiryDate: new Date('2099-12-31T00:00:00.000Z'),
      },
    });
  });

  it('zählt genau die PDF-Ausweisquellen ohne Seitenzahl nach, je Tenant unter RLS', async () => {
    const result = await runPdfPageCountBackfill(NO_LIMIT, {
      tenantIds: [tenants.main.tenantId, tenants.other.tenantId],
    });

    expect(result).toEqual({
      examined: 6,
      counted: 4,
      unreadable: 1,
      integrity: 1,
      skipped: 0,
      failed: 0,
      backlog: 0,
      budgetExhausted: false,
      aborted: false,
    });
    expect(await versionState('eligible')).toMatchObject({ pdfPageCount: 4 });
    // Der Unveränderlichkeitsschutz lässt die abgeleitete Seitenzahl zu.
    expect(await versionState('immutable')).toMatchObject({ pdfPageCount: 2 });
    expect((await versionState('immutable')).pdfPageCountCheckedAt).toBeInstanceOf(Date);
    // Nur die neueste Version zählt (wie loadIdentitySourceTx).
    expect(await versionState('two-versions')).toMatchObject({ pdfPageCount: 5 });
    expect(await versionState('two-versions', 0)).toEqual({
      pdfPageCount: null,
      pdfPageCountCheckedAt: null,
    });
    expect(await versionState('other-tenant')).toMatchObject({ pdfPageCount: 6 });
    // Nicht lesbar bzw. abweichendes Objekt: geprüft, ohne Seitenzahl.
    for (const name of ['unreadable', 'integrity']) {
      const state = await versionState(name);
      expect(state.pdfPageCount, name).toBeNull();
      expect(state.pdfPageCountCheckedAt, name).toBeInstanceOf(Date);
    }
    // Keine Kandidaten: weder geladen noch verändert.
    for (const name of [
      'general',
      'image',
      'too-large',
      'pending',
      'deleted',
      'destruction',
      'assigned',
    ]) {
      expect(await versionState(name), name).toEqual({
        pdfPageCount: null,
        pdfPageCountCheckedAt: null,
      });
      expect(
        h.fetched.some((key) => key.includes(docs.get(name)!.documentId)),
        name,
      ).toBe(false);
    }
    expect(await versionState('already-counted')).toEqual({
      pdfPageCount: 9,
      pdfPageCountCheckedAt: null,
    });
  });

  it('ist idempotent: ein zweiter Lauf findet nichts mehr', async () => {
    h.fetched.length = 0;
    const result = await runPdfPageCountBackfill(NO_LIMIT, {
      tenantIds: [tenants.main.tenantId, tenants.other.tenantId],
    });
    expect(result).toMatchObject({ examined: 0, counted: 0, backlog: 0 });
    expect(h.fetched).toEqual([]);
  });

  it('lässt zugeordnete GwG-Belege aus, weil der Trigger ihre Versionen sperrt', async () => {
    const versionId = docs.get('assigned')!.versions[0]!;
    await expect(
      prismaOwner.documentVersion.update({
        where: { id: versionId },
        data: { pdfPageCount: 1 },
      }),
    ).rejects.toThrow(/unveraenderlich/);
    expect(await versionState('assigned')).toEqual({
      pdfPageCount: null,
      pdfPageCountCheckedAt: null,
    });
  });
});
