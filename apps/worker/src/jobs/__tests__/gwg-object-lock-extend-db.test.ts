// Fachkatalog: TCMS-NACHWEIS-001, GWG-RETENTION-DESTRUCTION-001
// =============================================================================
// RT3D-K-01 (kk-tcms-fix5): gwg-object-lock-extend gegen echtes PostgreSQL.
//
// Belegt die Kandidatenauswahl (nur Versionen im GwG-Bucket eines nicht
// vernichteten, nicht vorgemerkten GwG-Belegs mit Verweis des Tax-CMS, dessen
// Aufbewahrungsende in der Zukunft und nach dem bestätigten Lock-Ende liegt),
// die Buchführung je Objektversion in gwg_object_lock_extension (Erfolg,
// Fehlschlag mit festem Code, Wiederholung im nächsten Lauf, nie zurück), den
// erneuten Nachlauf nach einem angehobenen Aufbewahrungsende (Mandatsende) und
// den Rückstand je Tenant für den Alarm. Der Object Store ist eine Attrappe
// (extendObjectLockRetention selbst prüft packages/storage); der Lauf ist auf
// den eigenen Tenant begrenzt. Nur mit ausdrücklichem Opt-in (WORKER_DB_TEST=1
// bzw. DB_TESTS=1); die synthetischen Tenants bleiben in der Wegwerf-Datenbank.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertLoopbackDatabases, createActiveClientFixture } from '../../__tests__/app-role-db';

const enabled = process.env['WORKER_DB_TEST'] === '1' || process.env['DB_TESTS'] === '1';
if (!enabled && process.env['CI'] === 'true') {
  throw new Error(
    'WORKER_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}
if (enabled) assertLoopbackDatabases('WORKER_DB_TEST');

const h = vi.hoisted(() => ({
  /** Objektschlüssel → Ausgang der Attrappe; ohne Eintrag: verlängert. */
  ausgang: new Map<string, 'unveraendert' | Error>(),
  aufrufe: [] as Array<{ key: string; versionId: string; ziel: string }>,
  rueckstand: [] as unknown[][],
}));

vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {}, queues: {} }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../maintenance-backlog', () => ({
  recordMaintenanceBacklog: vi.fn(async (...args: unknown[]) => {
    h.rueckstand.push(args);
    return { count: 0, oldestDueAt: null, consecutiveRuns: 0, alarm: false, threshold: {} };
  }),
}));
vi.mock('@taxtronik/storage', () => ({
  getBucketForTier: (tier: string) => (tier === 'GWG' ? 'gwg' : 'unerwartet'),
  extendObjectLockRetention: async (
    ref: { bucket: string; key: string; versionId: string },
    ziel: Date,
  ) => {
    h.aufrufe.push({ key: ref.key, versionId: ref.versionId, ziel: ziel.toISOString() });
    if (!ref.versionId.trim()) {
      throw Object.assign(new Error('keine Version'), { code: 'STORAGE_VERSION_ID_MISSING' });
    }
    const ausgang = h.ausgang.get(ref.key);
    if (ausgang instanceof Error) throw ausgang;
    return ausgang === 'unveraendert'
      ? {
          status: 'UNVERAENDERT',
          mode: 'GOVERNANCE',
          retainUntil: new Date('2040-01-01T00:00:00Z'),
        }
      : { status: 'VERLAENGERT', mode: 'GOVERNANCE', retainUntil: ziel };
  },
}));

import { prismaOwner } from '../../prisma-owner';
import { runGwgObjectLockExtend } from '../gwg-object-lock-extend';

const describeDb = enabled ? describe : describe.skip;
const NO_LIMIT = { exhausted: () => false };
const JETZT = new Date('2026-10-21T12:00:00Z');

describeDb('RT3D-K-01 gwg-object-lock-extend gegen PostgreSQL', () => {
  let tenantId = '';
  let staffId = '';
  let mandantId = '';

  /** Zustand eines Mandanten-Kontexts für Fixtures (Staff, wie die Ablage). */
  async function imTenant<T>(fn: (tx: typeof prismaOwner) => Promise<T>): Promise<T> {
    return prismaOwner.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true),
        set_config('app.current_actor_id', ${staffId}, true),
        set_config('app.current_actor_type', 'STAFF', true)`;
      return fn(tx as unknown as typeof prismaOwner);
    }) as Promise<T>;
  }

  interface Beleg {
    id: string;
    versionen: Array<{ id: string; key: string }>;
  }

  /**
   * Früherer Nachweis als GwG-Beleg auf dem echten Weg (ohne Superuser): als
   * allgemeines Dokument gebunden, freigegeben und dann zum GwG-Beleg
   * umklassifiziert (die Datenbank hebt das Aufbewahrungsende auf die
   * Steuerfrist, Anlage 2019 → 1.1.2030). `versionen`: Bucket und Objektversion
   * je Version (die erste bindet).
   */
  async function beleg(
    o: {
      anlage?: Date;
      versionen?: Array<{ bucket: string; versionId: string | null }>;
      gebunden?: boolean;
      mandant?: string;
      aufbewahrung?: Date;
    } = {},
  ): Promise<Beleg> {
    const specs = o.versionen ?? [{ bucket: 'gwg', versionId: 'v1' }];
    const clientId = o.mandant ?? mandantId;
    const doc = await imTenant((tx) =>
      tx.document.create({
        data: {
          tenantId,
          clientId,
          title: 'Ausweiskopie',
          classification: 'GENERAL',
          mimeType: 'application/pdf',
          createdAt: o.anlage ?? new Date('2019-01-15T00:00:00Z'),
          retentionUntil: o.aufbewahrung ?? new Date('2025-01-01T00:00:00Z'),
        },
      }),
    );
    const versionen: Beleg['versionen'] = [];
    for (const [index, spec] of specs.entries()) {
      const key = `tenants/${tenantId}/${spec.bucket}/${doc.id}/v${index + 1}`;
      const version = await prismaOwner.documentVersion.create({
        data: {
          documentId: doc.id,
          versionNo: index + 1,
          storageBucket: spec.bucket,
          storageKey: key,
          storageVersionId: spec.versionId,
          sha256: Buffer.alloc(32, 0x3d),
          sizeBytes: 812n,
          immutable: false,
          scanStatus: 'CLEAN',
          scanCompletedAt: new Date(),
          createdById: staffId,
        },
      });
      versionen.push({ id: version.id, key });
      if (index === 0 && o.gebunden !== false) {
        await prismaOwner.tcmsDocumentReference.create({
          data: {
            tenantId,
            clientId,
            documentId: doc.id,
            documentVersionId: version.id,
            sha256: Buffer.alloc(32, 0x3d),
            tcmsSubject: 'EXECUTION',
            tcmsExecutionId: 'cmvfobjectlock',
            createdBy: staffId,
            releasedAt: null,
          },
        });
        await prismaOwner.tcmsDocumentReference.updateMany({
          where: { documentId: doc.id },
          data: { releasedAt: new Date(), releasedBy: staffId, releaseReason: 'REMOVED' },
        });
      }
    }
    await prismaOwner.document.update({
      where: { id: doc.id },
      data: { classification: 'GWG_EVIDENCE' },
    });
    return { id: doc.id, versionen };
  }

  async function stand(versionId: string) {
    return prismaOwner.gwgObjectLockExtension.findUnique({
      where: { documentVersionId: versionId },
    });
  }

  function lauf() {
    return runGwgObjectLockExtend(JETZT, NO_LIMIT, { tenantIds: [tenantId] });
  }

  beforeAll(async () => {
    const seed = randomUUID();
    tenantId = (
      await prismaOwner.tenant.create({ data: { slug: `rt3d-lock-${seed}`, name: 'RT3D Lock' } })
    ).id;
    staffId = (
      await prismaOwner.staffUser.create({
        data: {
          tenantId,
          email: `rt3d-lock-${seed}@example.test`,
          fullName: 'Ada Admin',
          passwordHash: 'synthetic',
          roles: { create: { role: 'ADMIN' } },
        },
      })
    ).id;
    mandantId = await createActiveClientFixture(prismaOwner, tenantId, staffId, 'Lock GmbH');
  }, 60_000);

  beforeEach(() => {
    h.ausgang.clear();
    h.aufrufe.length = 0;
    h.rueckstand.length = 0;
  });

  it('verlängert nur Versionen gebundener GwG-Belege im GwG-Bucket, hält Erfolg und Fehlschlag fest und wiederholt nur Offenes', async () => {
    const zwei = await beleg({
      versionen: [
        { bucket: 'gwg', versionId: 'v1' },
        { bucket: 'general', versionId: 'v2' },
        { bucket: 'gwg', versionId: 'v3' },
      ],
    });
    const verweigert = await beleg();
    const ohneVersion = await beleg({ versionen: [{ bucket: 'gwg', versionId: null }] });
    // Nicht betroffen: ohne Verweis (auch mit späterem Aufbewahrungsende),
    // Aufbewahrungsende vorbei (Anlage 2014 → 1.1.2025), vorgemerkt.
    const ohneVerweis = await beleg({
      gebunden: false,
      aufbewahrung: new Date('2031-01-01T00:00:00Z'),
    });
    const abgelaufen = await beleg({ anlage: new Date('2014-03-01T00:00:00Z') });
    const vorgemerkt = await beleg();
    await prismaOwner.document.update({
      where: { id: vorgemerkt.id },
      data: { gwgDestructionRequestedAt: new Date(), gwgDestructionRequestedBy: staffId },
    });
    h.ausgang.set(
      verweigert.versionen[0]!.key,
      Object.assign(new Error('Access Denied'), { name: 'AccessDenied' }),
    );

    const erster = await lauf();
    const ziel = '2030-01-01T00:00:00.000Z';
    expect(h.aufrufe.map((a) => a.key).sort()).toEqual(
      [
        zwei.versionen[0]!.key,
        zwei.versionen[2]!.key,
        verweigert.versionen[0]!.key,
        ohneVersion.versionen[0]!.key,
      ].sort(),
    );
    expect(new Set(h.aufrufe.map((a) => a.ziel))).toEqual(new Set([ziel]));
    expect(erster).toMatchObject({
      examined: 4,
      extended: 2,
      unchanged: 0,
      failed: 2,
      backlog: 2,
      budgetExhausted: false,
    });
    for (const v of [zwei.versionen[0]!, zwei.versionen[2]!]) {
      expect(await stand(v.id)).toMatchObject({
        tenantId,
        retainUntil: new Date(ziel),
        failedAttempts: 0,
        failedSince: null,
        lastError: null,
      });
    }
    expect(await stand(verweigert.versionen[0]!.id)).toMatchObject({
      retainUntil: null,
      failedAttempts: 1,
      lastError: 'AccessDenied',
    });
    expect(await stand(ohneVersion.versionen[0]!.id)).toMatchObject({
      failedAttempts: 1,
      lastError: 'STORAGE_VERSION_ID_MISSING',
    });
    for (const d of [ohneVerweis, abgelaufen, vorgemerkt]) {
      expect(await stand(d.versionen[0]!.id)).toBeNull();
    }
    expect(await stand(zwei.versionen[1]!.id)).toBeNull();
    // Rückstand je Tenant für den Alarm (B14): beide offenen Versionen, fällig seit dem Fehlschlag.
    expect(h.rueckstand).toHaveLength(1);
    const [job, tenants] = h.rueckstand[0]! as [string, Array<Record<string, unknown>>];
    expect(job).toBe('gwgObjectLockExtend');
    expect(tenants).toEqual([{ tenantId, count: 2, oldestDueAt: expect.any(Date) }]);
    // Fällig seit dem ersten Fehlschlag; ein weiterer Fehlschlag verschiebt das nicht.
    const seit = (await stand(ohneVersion.versionen[0]!.id))!.failedSince!;
    expect(seit).toBeInstanceOf(Date);

    // Zweiter Lauf: nur die offenen Versionen; der Speicher antwortet wieder.
    h.ausgang.clear();
    h.aufrufe.length = 0;
    const zweiter = await lauf();
    expect(h.aufrufe.map((a) => a.key).sort()).toEqual(
      [verweigert.versionen[0]!.key, ohneVersion.versionen[0]!.key].sort(),
    );
    expect(zweiter).toMatchObject({ examined: 2, extended: 1, failed: 1, backlog: 1 });
    expect(await stand(verweigert.versionen[0]!.id)).toMatchObject({
      retainUntil: new Date(ziel),
      failedAttempts: 0,
      failedSince: null,
      lastError: null,
    });
    expect(await stand(ohneVersion.versionen[0]!.id)).toMatchObject({
      failedAttempts: 2,
      failedSince: seit,
      lastError: 'STORAGE_VERSION_ID_MISSING',
    });

    // Dritter Lauf: nichts mehr zu tun außer der Version ohne Objektversion.
    h.aufrufe.length = 0;
    await lauf();
    expect(h.aufrufe.map((a) => a.key)).toEqual([ohneVersion.versionen[0]!.key]);
  });

  it('zieht nach, wenn die Datenbank das Aufbewahrungsende anhebt (Mandatsende), und hält ein längeres Lock-Ende fest', async () => {
    const eigenerMandant = await createActiveClientFixture(
      prismaOwner,
      tenantId,
      staffId,
      'Mandatsende GmbH',
    );
    const b = await beleg({ mandant: eigenerMandant });
    const laenger = await beleg({ mandant: eigenerMandant });
    await lauf();
    expect(await stand(b.versionen[0]!.id)).toMatchObject({
      retainUntil: new Date('2030-01-01T00:00:00Z'),
    });

    // Mandatsende 2027 → GwG-Frist 1.1.2033: der nächste Lauf verlängert erneut.
    await imTenant((tx) =>
      tx.client.update({
        where: { id: eigenerMandant },
        data: { mandateEndedAt: new Date('2027-05-01T00:00:00Z') },
      }),
    );
    h.aufrufe.length = 0;
    h.ausgang.set(laenger.versionen[0]!.key, 'unveraendert');
    const ergebnis = await lauf();
    // Nur die beiden angehobenen Belege dieses Mandanten; die Version ohne
    // Objektversion aus dem ersten Test bleibt offen und scheitert erneut.
    const eigene = new Set([b.versionen[0]!.key, laenger.versionen[0]!.key]);
    expect(
      h.aufrufe
        .filter((a) => eigene.has(a.key))
        .map((a) => [a.key, a.ziel])
        .sort(),
    ).toEqual(
      [
        [b.versionen[0]!.key, '2033-01-01T00:00:00.000Z'],
        [laenger.versionen[0]!.key, '2033-01-01T00:00:00.000Z'],
      ].sort(),
    );
    expect(ergebnis).toMatchObject({ extended: 1, unchanged: 1, failed: 1, backlog: 1 });
    expect(await stand(b.versionen[0]!.id)).toMatchObject({
      retainUntil: new Date('2033-01-01T00:00:00Z'),
    });
    // Der Speicher meldet ein längeres Ende: festgehalten, nie zurück.
    expect(await stand(laenger.versionen[0]!.id)).toMatchObject({
      retainUntil: new Date('2040-01-01T00:00:00Z'),
    });
  });

  it('die Zeile entfällt mit der Objektversion (kontrollierte Vernichtung)', async () => {
    const beendet = await createActiveClientFixture(prismaOwner, tenantId, staffId, 'Ende GmbH');
    const b = await beleg({ anlage: new Date('2014-03-01T00:00:00Z'), mandant: beendet });
    // Fertig verlängerter Stand wie nach einem früheren Lauf.
    await prismaOwner.gwgObjectLockExtension.create({
      data: {
        documentVersionId: b.versionen[0]!.id,
        tenantId,
        retainUntil: new Date('2025-01-01T00:00:00Z'),
      },
    });
    // Anlage 2014, Mandatsende 2015: beide Fristen abgelaufen; die Vernichtung
    // entfernt die Version.
    await prismaOwner.client.update({
      where: { id: beendet },
      data: { mandateEndedAt: new Date('2015-06-30T00:00:00Z') },
    });
    await imTenant(async (tx) => {
      await tx.document.update({
        where: { id: b.id },
        data: { gwgDestructionRequestedAt: new Date(), gwgDestructionRequestedBy: staffId },
      });
      await tx.$queryRaw`SELECT app.destroy_gwg_document_versions(${b.id}::uuid) AS n`;
    });
    expect(await stand(b.versionen[0]!.id)).toBeNull();
  });
});
