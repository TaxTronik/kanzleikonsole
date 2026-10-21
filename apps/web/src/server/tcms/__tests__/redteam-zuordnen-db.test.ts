// =============================================================================
// Red-Team kk-tcms-rt3c (TCMS stage 3): Zuordnen ungeklärter Portal-Anlagen und
// Dokumentsperren der Bindung (kk-tcms-s10nach) gegen echtes PostgreSQL,
// App-Rolle unter RLS. Datenbank-Ablehnungen nur über @taxtronik/db/testing/
// db-fehler (Guard).
//
// Geprüfte Schutzziele (TCMS-NACHWEIS-001):
//   - `ungeklaerteAnlageTx`/`ungeklaerteAnlageZuordnen` sind auf Tenant und
//     Mandant gebunden; ein fremder Mandant findet und ordnet nichts zu.
//   - Die Ereignis-ID wird höchstens einmal gesetzt (keine Doppelzuordnung,
//     kein Wechsel über die Datenbank).
//   - Ein als EVENT-Anlage gebundenes Dokument darf den Mandanten/Tenant nicht
//     wechseln, nicht in eine ausgeschlossene Klasse umklassifiziert werden und
//     keine neue Version erhalten (56a0ba8, 03dce2f, 6e3fc49).
//
//   DB_TESTS=1 (db_suite_env) pnpm exec vitest run --config vitest.db.config.ts \
//     src/server/tcms/__tests__/redteam-zuordnen-db.test.ts
// Fachkatalog: TCMS-NACHWEIS-001
// =============================================================================
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient, TenantContext } from '@taxtronik/db';
import { dbAbgewiesen } from '../../../../../../packages/db/src/testing/db-fehler';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../packages/db/src/__tests__/gwg-test-fixture';

vi.mock('server-only', () => ({}));
vi.mock('@/server/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));

import { withTenantContext } from '@taxtronik/db/tenant-context';
import { meldungsAnlageVerknuepfenTx } from '../durchfuehrung/verweis';
import { ungeklaerteAnlageTx, ungeklaerteAnlageZuordnen } from '../portal/meldevorgang';

const enabled = process.env.TCMS_BEREICH_D_DB_TEST === '1' || process.env.DB_TESTS === '1';
if (!enabled && process.env.CI === 'true') {
  throw new Error(
    'TCMS_BEREICH_D_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}

const EREIGNIS = 'cmvfereignisrt3caaaaaaaaaaa';
const EREIGNIS2 = 'cmvfereignisrt3cbbbbbbbbbbb';

(enabled ? describe : describe.skip)('RT3C: Zuordnen und Dokumentsperren', () => {
  let owner!: PrismaClient;
  let tenantId = '';
  let mandantA = '';
  let mandantB = '';
  let kontakt = '';
  let typ = '';
  let admin = '';

  const staffCtx = (): TenantContext => ({ tenantId, actorId: admin, actorType: 'STAFF' });

  async function dokument(mandant: string) {
    const doc = await owner.document.create({
      data: {
        tenantId,
        clientId: mandant,
        title: 'Nachweis.csv',
        classification: 'GENERAL',
        documentTypeId: typ,
        mimeType: 'text/csv',
        sharedWithClientAt: new Date(),
      },
    });
    const sha = Buffer.from(randomUUID().replaceAll('-', '').repeat(2), 'hex');
    const version = await owner.documentVersion.create({
      data: {
        documentId: doc.id,
        versionNo: 1,
        storageBucket: 'general',
        storageKey: `tenants/${tenantId}/none/${doc.id}.csv`,
        sha256: sha,
        sizeBytes: 812n,
        immutable: false,
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
        createdById: admin,
      },
    });
    return { id: doc.id, versionId: version.id, sha: sha.toString('hex') };
  }

  /** Gebundene, ungeklärte EVENT-Anlage (ohne Ereignis-ID, ohne Meldevorgang). */
  async function ungeklaerteAnlage(mandant: string) {
    const doc = await dokument(mandant);
    const verknuepfungId = await withTenantContext(
      { tenantId, actorId: kontakt, actorType: 'CLIENT_CONTACT' },
      (tx) =>
        meldungsAnlageVerknuepfenTx(
          tx,
          { tenantId, mandantId: mandant, kontaktId: kontakt },
          doc.id,
          randomUUID(),
        ),
    );
    return { ...doc, verknuepfungId };
  }

  beforeAll(async () => {
    ({ prismaOwner: owner } = await import('@taxtronik/db'));
    tenantId = (
      await owner.tenant.create({
        data: { slug: `rt3c-zuordnen-${randomUUID()}`, name: 'RT3C Zuordnen' },
      })
    ).id;
    admin = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `rt3c-zuordnen-${randomUUID()}@example.test`,
          fullName: 'Ada Admin',
          passwordHash: 'synthetic',
          roles: { create: [{ role: 'ADMIN' }] },
        },
      })
    ).id;
    mandantA = (
      await owner.client.create({
        data: { tenantId, kind: 'JURPERS', name: 'Mandant A GmbH', allowActive: false },
      })
    ).id;
    await createVerifiedLegalEntityGwgFixture(owner, {
      tenantId,
      clientId: mandantA,
      verifiedBy: admin,
      registerNumber: `HRB-RT3C-A-${randomUUID()}`,
    });
    await owner.client.update({ where: { id: mandantA }, data: { allowActive: true } });
    mandantB = (
      await owner.client.create({
        data: { tenantId, kind: 'JURPERS', name: 'Mandant B GmbH', allowActive: false },
      })
    ).id;
    kontakt = (
      await owner.clientContact.create({
        data: {
          tenantId,
          clientId: mandantA,
          email: `${randomUUID()}@example.test`,
          fullName: 'Jana Weller',
        },
      })
    ).id;
    typ = (
      await owner.documentType.create({
        data: { tenantId, name: 'Allgemein', tier: 'NONE', classificationKey: 'GENERAL' },
      })
    ).id;
  });

  afterAll(async () => {
    await owner?.$disconnect();
  });

  it('RT3C-A-01: ein fremder Mandant findet die Anlage nicht und kann sie nicht zuordnen', async () => {
    const a = await ungeklaerteAnlage(mandantA);
    // Fremder Mandant (B): weder lesen …
    const gelesenB = await withTenantContext(staffCtx(), (tx) =>
      ungeklaerteAnlageTx(tx, { tenantId, mandantId: mandantB, verknuepfungId: a.verknuepfungId }),
    );
    expect(gelesenB).toBeNull();
    // … noch zuordnen (Mandant der Aktion gebunden, nie aus dem Formular).
    const zugeordnetB = await ungeklaerteAnlageZuordnen(staffCtx(), {
      tenantId,
      mandantId: mandantB,
      verknuepfungId: a.verknuepfungId,
      ereignisId: EREIGNIS,
    });
    expect(zugeordnetB).toBe(false);
    const ref = await owner.tcmsDocumentReference.findUnique({ where: { id: a.verknuepfungId } });
    expect(ref).toMatchObject({ tcmsEventId: null, releasedAt: null });
  });

  it('RT3C-A-02: korrekte Zuordnung einmalig; eine zweite Zuordnung greift nicht', async () => {
    const a = await ungeklaerteAnlage(mandantA);
    const gelesen = await withTenantContext(staffCtx(), (tx) =>
      ungeklaerteAnlageTx(tx, { tenantId, mandantId: mandantA, verknuepfungId: a.verknuepfungId }),
    );
    expect(gelesen).toEqual({ dokumentId: a.id, sha256: a.sha });

    const erste = await ungeklaerteAnlageZuordnen(staffCtx(), {
      tenantId,
      mandantId: mandantA,
      verknuepfungId: a.verknuepfungId,
      ereignisId: EREIGNIS,
    });
    expect(erste).toBe(true);
    // Zweite Zuordnung (anderes Ereignis): die Anlage ist nicht mehr offen.
    const zweite = await ungeklaerteAnlageZuordnen(staffCtx(), {
      tenantId,
      mandantId: mandantA,
      verknuepfungId: a.verknuepfungId,
      ereignisId: EREIGNIS2,
    });
    expect(zweite).toBe(false);
    const ref = await owner.tcmsDocumentReference.findUnique({ where: { id: a.verknuepfungId } });
    expect(ref!.tcmsEventId).toBe(EREIGNIS);
  });

  it('RT3C-A-03: die Ereignis-ID lässt sich auch über die Datenbank nicht wechseln', async () => {
    const a = await ungeklaerteAnlage(mandantA);
    await ungeklaerteAnlageZuordnen(staffCtx(), {
      tenantId,
      mandantId: mandantA,
      verknuepfungId: a.verknuepfungId,
      ereignisId: EREIGNIS,
    });
    await dbAbgewiesen(
      withTenantContext(
        staffCtx(),
        (tx) =>
          tx.$executeRaw`UPDATE tcms_document_reference SET tcms_event_id = ${EREIGNIS2} WHERE id = ${a.verknuepfungId}::uuid`,
      ),
      { meldung: 'die Ereignis-ID wird nur einmal gesetzt', sqlState: '23514' },
      'RT3C-A-03',
    );
  });

  it('RT3C-D-01: ein als EVENT-Anlage gebundenes Dokument darf den Mandanten nicht wechseln', async () => {
    const a = await ungeklaerteAnlage(mandantA);
    await dbAbgewiesen(
      withTenantContext(
        staffCtx(),
        (tx) =>
          tx.$executeRaw`UPDATE document SET client_id = ${mandantB}::uuid WHERE id = ${a.id}::uuid`,
      ),
      { meldung: 'Mandantenwechsel gesperrt', sqlState: '23001' },
      'Mandantenwechsel',
    );
    // Auch ein Umklassifizieren in eine ausgeschlossene Klasse ist gesperrt.
    await dbAbgewiesen(
      withTenantContext(
        staffCtx(),
        (tx) =>
          tx.$executeRaw`UPDATE document SET classification = 'GWG_EVIDENCE' WHERE id = ${a.id}::uuid`,
      ),
      { meldung: 'Umklassifizieren gesperrt', sqlState: '23001' },
      'Umklassifizieren',
    );
  });

  it('RT3C-D-02: ein als EVENT-Anlage gebundenes Dokument bekommt keine neue Version', async () => {
    const a = await ungeklaerteAnlage(mandantA);
    const sha = Buffer.from(randomUUID().replaceAll('-', '').repeat(2), 'hex');
    await dbAbgewiesen(
      withTenantContext(
        staffCtx(),
        (tx) =>
          tx.$executeRaw`
          INSERT INTO document_version
            (id, document_id, version_no, storage_bucket, storage_key, sha256, size_bytes,
             immutable, scan_status, created_by_id, created_at)
          VALUES
            (gen_random_uuid(), ${a.id}::uuid, 2, 'general',
             ${'tenants/' + tenantId + '/none/' + a.id + '-v2.csv'}, ${sha}, 99,
             false, 'PENDING', ${admin}::uuid, now())`,
      ),
      { meldung: 'neue Version gesperrt', sqlState: '23001' },
      'RT3C-D-02',
    );
  });
});
