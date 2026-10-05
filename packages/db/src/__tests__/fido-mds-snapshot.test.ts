// Fachkatalog: ACCESS-TENANT-RLS-001
// P-23: Ablage des signaturgeprüften FIDO-MDS-Snapshots durch den Worker und
// Lesezugriff der Hardware-Anmeldung gegen eine echte PostgreSQL-DB. Der
// globale Anker wird vor jedem Test geleert und am Ende exakt wiederhergestellt
// (packages/db-Tests laufen seriell).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  FIDO_MDS_UNCLAIMED_POLICY_HASH,
  FidoMdsSnapshotOutdatedError,
  readFidoMdsSnapshotEntries,
  readFidoMdsTrustState,
  storeFidoMdsSnapshot,
  type FidoMdsSnapshotInput,
  type FidoMdsTransactionClient,
} from '../fido-mds-snapshot';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import { PrismaClient } from '../prisma-client';

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('FIDO-MDS-Snapshot-Tests brauchen DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});

const AAGUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AAGUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NEXT_UPDATE = new Date('2099-01-01T00:00:00.000Z');

type AnchorRow = {
  blob_serial: bigint;
  next_update: string;
  verified_at: Date;
  policy_revision: bigint;
  policy_hash: string;
  snapshot_serial: bigint | null;
  snapshot_sha256: string | null;
  snapshot_entries: unknown;
};
let originalAnchor: AnchorRow | undefined;

function entry(aaguid: string, status = 'FIDO_CERTIFIED_L2') {
  return {
    aaguid,
    metadataStatement: { aaguid, description: `Modell ${aaguid.slice(0, 4)}` },
    statusReports: [{ status, effectiveDate: '2020-01-01' }],
    timeOfLastStatusChange: '2020-01-01',
  };
}

function snapshot(overrides: Partial<FidoMdsSnapshotInput> = {}): FidoMdsSnapshotInput {
  return {
    serial: 7,
    nextUpdate: NEXT_UPDATE,
    blobSha256: 'a'.repeat(64),
    // U2F-/UAF-Einträge ohne AAGUID filtert bereits der Worker; ein solcher
    // Eintrag darf die Abfrage trotzdem nicht stören.
    entries: [entry(AAGUID_B), { aaid: '4e4e#4005' }, entry(AAGUID_A)],
    ...overrides,
  };
}

async function anchor(): Promise<AnchorRow | undefined> {
  const [row] = await owner.$queryRaw<AnchorRow[]>`
    SELECT "blob_serial", to_char("next_update", 'YYYY-MM-DD') AS "next_update",
           "verified_at", "policy_revision", "policy_hash",
           "snapshot_serial", "snapshot_sha256", "snapshot_entries"
      FROM public."fido_mds_trust_state"
  `;
  return row;
}

async function insertAnchor(serial: number, policyRevision = 2): Promise<void> {
  await owner.$executeRaw`
    INSERT INTO public."fido_mds_trust_state" (
      "singleton", "blob_serial", "next_update", "verified_at", "policy_revision", "policy_hash"
    ) VALUES (
      TRUE, ${serial}, DATE '2099-01-01', CURRENT_TIMESTAMP, ${policyRevision}, ${'b'.repeat(64)}
    )
  `;
}

/** Zeichnet alle SQL-Anweisungen der Ablage auf (Beleg: kein unnötiger Snapshot-Schreibzugriff). */
function recordingClient(statements: string[]): FidoMdsTransactionClient {
  const record = (target: object, key: string | symbol) => {
    const value = Reflect.get(target, key) as unknown;
    if ((key === '$queryRaw' || key === '$executeRaw') && typeof value === 'function') {
      return (strings: TemplateStringsArray, ...values: unknown[]) => {
        statements.push(strings.join('?'));
        return (value as (...args: unknown[]) => unknown).call(target, strings, ...values);
      };
    }
    return value;
  };
  return {
    $queryRaw: owner.$queryRaw.bind(owner),
    $transaction: ((fn: (tx: object) => Promise<unknown>, options?: object) =>
      owner.$transaction((tx) => fn(new Proxy(tx, { get: record })), options)) as never,
  };
}

describeWithDatabase('P-23 FIDO-MDS-Snapshot (PostgreSQL)', () => {
  beforeAll(async () => {
    originalAnchor = await anchor();
  });

  beforeEach(async () => {
    await owner.$executeRaw`DELETE FROM public."fido_mds_trust_state"`;
  });

  afterAll(async () => {
    try {
      await owner.$executeRaw`DELETE FROM public."fido_mds_trust_state"`;
      if (originalAnchor) {
        const original = originalAnchor;
        await owner.$executeRaw`
          INSERT INTO public."fido_mds_trust_state" (
            "singleton", "blob_serial", "next_update", "verified_at",
            "policy_revision", "policy_hash",
            "snapshot_serial", "snapshot_sha256", "snapshot_entries"
          ) VALUES (
            TRUE, ${original.blob_serial}, ${original.next_update}::date, ${original.verified_at},
            ${original.policy_revision}, ${original.policy_hash},
            ${original.snapshot_serial}, ${original.snapshot_sha256},
            ${original.snapshot_entries === null ? null : JSON.stringify(original.snapshot_entries)}::jsonb
          )
        `;
      }
    } finally {
      await Promise.all([owner.$disconnect(), app.$disconnect()]);
    }
  });

  it('hält auch die Snapshot-Spalten vollständig außerhalb der App-Rolle', async () => {
    const [privileges] = await owner.$queryRaw<Array<{ canSelect: boolean; canUpdate: boolean }>>`
      SELECT
        has_column_privilege(
          'taxtronik_app', 'public.fido_mds_trust_state', 'snapshot_entries', 'SELECT'
        ) AS "canSelect",
        has_column_privilege(
          'taxtronik_app', 'public.fido_mds_trust_state', 'snapshot_entries', 'UPDATE'
        ) AS "canUpdate"
    `;
    expect(privileges).toEqual({ canSelect: false, canUpdate: false });
    await expect(
      app.$queryRaw`SELECT "snapshot_entries" FROM public."fido_mds_trust_state"`,
    ).rejects.toThrow(/permission denied/i);
  });

  it.each([
    [
      'Snapshot ohne Prüfsumme',
      `UPDATE public."fido_mds_trust_state" SET "snapshot_serial" = 5, "snapshot_entries" = '[]'::jsonb`,
    ],
    [
      'Prüfsumme in Großbuchstaben',
      `UPDATE public."fido_mds_trust_state" SET "snapshot_serial" = 5, "snapshot_sha256" = '${'A'.repeat(64)}', "snapshot_entries" = '[]'::jsonb`,
    ],
    [
      'Einträge als Objekt',
      `UPDATE public."fido_mds_trust_state" SET "snapshot_serial" = 5, "snapshot_sha256" = '${'a'.repeat(64)}', "snapshot_entries" = '{}'::jsonb`,
    ],
    [
      'Snapshot neuer als der Anker',
      `UPDATE public."fido_mds_trust_state" SET "snapshot_serial" = 6, "snapshot_sha256" = '${'a'.repeat(64)}', "snapshot_entries" = '[]'::jsonb`,
    ],
  ])('weist einen inkonsistenten Snapshot per Constraint ab (%s)', async (_case, statement) => {
    await insertAnchor(5);
    await expect(owner.$executeRawUnsafe(statement)).rejects.toThrow(
      /fido_mds_trust_state_snapshot_check/,
    );
  });

  it('legt Snapshot und Anker ohne App-Policy an; die App liest nur freigegebene Einträge', async () => {
    await expect(storeFidoMdsSnapshot(owner, snapshot())).resolves.toBe('stored');

    expect(await anchor()).toEqual({
      blob_serial: 7n,
      next_update: '2099-01-01',
      verified_at: expect.any(Date),
      policy_revision: 0n,
      policy_hash: FIDO_MDS_UNCLAIMED_POLICY_HASH,
      snapshot_serial: 7n,
      snapshot_sha256: 'a'.repeat(64),
      snapshot_entries: snapshot().entries,
    });
    await expect(readFidoMdsTrustState(owner)).resolves.toEqual({
      blobSerial: 7n,
      nextUpdate: '2099-01-01',
      verifiedAt: expect.any(Date),
      policyRevision: 0n,
      policyHash: FIDO_MDS_UNCLAIMED_POLICY_HASH,
      snapshotSha256: 'a'.repeat(64),
    });

    // AAGUIDs unabhängig von der Schreibweise, Reihenfolge wie im BLOB.
    await expect(
      readFidoMdsSnapshotEntries(owner, {
        blobSerial: 7n,
        aaguids: [AAGUID_A.toUpperCase(), AAGUID_B],
      }),
    ).resolves.toEqual({ blobSha256: 'a'.repeat(64), entries: [entry(AAGUID_B), entry(AAGUID_A)] });
    await expect(
      readFidoMdsSnapshotEntries(owner, { blobSerial: 7n, aaguids: [AAGUID_A] }),
    ).resolves.toEqual({ blobSha256: 'a'.repeat(64), entries: [entry(AAGUID_A)] });
    // Snapshot vorhanden, aber kein freigegebenes Modell enthalten.
    await expect(
      readFidoMdsSnapshotEntries(owner, {
        blobSerial: 7n,
        aaguids: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
      }),
    ).resolves.toEqual({ blobSha256: 'a'.repeat(64), entries: [] });
    // Für eine andere Serie gibt es keinen Snapshot.
    await expect(
      readFidoMdsSnapshotEntries(owner, { blobSerial: 8n, aaguids: [AAGUID_A] }),
    ).resolves.toBeNull();
  });

  it('meldet einen Anker ohne Snapshot (Bestand vor P-23) explizit ohne Prüfsumme', async () => {
    await insertAnchor(5);
    await expect(readFidoMdsTrustState(owner)).resolves.toMatchObject({
      blobSerial: 5n,
      snapshotSha256: null,
    });
    await expect(
      readFidoMdsSnapshotEntries(owner, { blobSerial: 5n, aaguids: [AAGUID_A] }),
    ).resolves.toBeNull();
  });

  it('verwirft den Snapshot, wenn eine ältere App-Replica die Serie selbst vorrückt', async () => {
    await storeFidoMdsSnapshot(owner, snapshot());
    // Verhalten der App vor P-23: Serie verankern, ohne den Snapshot zu kennen.
    await owner.$executeRaw`
      UPDATE public."fido_mds_trust_state" SET "blob_serial" = 8, "verified_at" = CURRENT_TIMESTAMP
    `;
    await expect(readFidoMdsTrustState(owner)).resolves.toMatchObject({
      blobSerial: 8n,
      snapshotSha256: null,
    });
    await expect(
      readFidoMdsSnapshotEntries(owner, { blobSerial: 8n, aaguids: [AAGUID_A] }),
    ).resolves.toBeNull();

    // Der nächste Worker-Lauf mit Serie 8 stellt einen gültigen Snapshot her.
    await expect(
      storeFidoMdsSnapshot(owner, snapshot({ serial: 8, blobSha256: 'c'.repeat(64) })),
    ).resolves.toBe('stored');
    await expect(readFidoMdsTrustState(owner)).resolves.toMatchObject({
      blobSerial: 8n,
      snapshotSha256: 'c'.repeat(64),
    });
  });

  it('lässt die von der App beanspruchte Policy unberührt und erneuert nur den Prüfzeitpunkt', async () => {
    await owner.$executeRaw`
      INSERT INTO public."fido_mds_trust_state" (
        "singleton", "blob_serial", "next_update", "verified_at", "policy_revision", "policy_hash"
      ) VALUES (
        TRUE, 0, DATE '1970-01-01', TIMESTAMPTZ '1970-01-01 00:00:00+00', 3, ${'b'.repeat(64)}
      )
    `;
    await storeFidoMdsSnapshot(owner, snapshot());
    const stored = await anchor();
    expect(stored).toMatchObject({
      blob_serial: 7n,
      next_update: '2099-01-01',
      policy_revision: 3n,
      policy_hash: 'b'.repeat(64),
      snapshot_serial: 7n,
    });
    expect(stored!.verified_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('schreibt einen unveränderten BLOB nicht neu, rückt aber verified_at vor', async () => {
    await storeFidoMdsSnapshot(owner, snapshot());
    await owner.$executeRaw`
      UPDATE public."fido_mds_trust_state"
         SET "verified_at" = CURRENT_TIMESTAMP - INTERVAL '50 minutes'
    `;
    const statements: string[] = [];

    await expect(storeFidoMdsSnapshot(recordingClient(statements), snapshot())).resolves.toBe(
      'unchanged',
    );

    expect(statements.some((sql) => sql.includes('"snapshot_entries" ='))).toBe(false);
    const after = await anchor();
    expect(after!.verified_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(after).toMatchObject({ snapshot_serial: 7n, snapshot_sha256: 'a'.repeat(64) });
  });

  it('ersetzt bei gleicher Serie, aber anderem BLOB den Snapshot', async () => {
    await storeFidoMdsSnapshot(owner, snapshot());
    await expect(
      storeFidoMdsSnapshot(
        owner,
        snapshot({ blobSha256: 'b'.repeat(64), entries: [entry(AAGUID_A)] }),
      ),
    ).resolves.toBe('stored');
    await expect(
      readFidoMdsSnapshotEntries(owner, { blobSerial: 7n, aaguids: [AAGUID_A, AAGUID_B] }),
    ).resolves.toEqual({ blobSha256: 'b'.repeat(64), entries: [entry(AAGUID_A)] });
  });

  it('übernimmt eine neuere Serie samt Snapshot in einem Schritt', async () => {
    await storeFidoMdsSnapshot(owner, snapshot());
    await expect(
      storeFidoMdsSnapshot(
        owner,
        snapshot({
          serial: 8,
          nextUpdate: new Date('2099-02-01T00:00:00.000Z'),
          blobSha256: 'c'.repeat(64),
          entries: [entry(AAGUID_A, 'REVOKED')],
        }),
      ),
    ).resolves.toBe('stored');
    expect(await anchor()).toMatchObject({
      blob_serial: 8n,
      next_update: '2099-02-01',
      snapshot_serial: 8n,
      snapshot_sha256: 'c'.repeat(64),
      snapshot_entries: [entry(AAGUID_A, 'REVOKED')],
    });
    await expect(
      readFidoMdsSnapshotEntries(owner, { blobSerial: 7n, aaguids: [AAGUID_A] }),
    ).resolves.toBeNull();
  });

  it('weist einen älteren BLOB ab, ohne Anker oder Snapshot zu verändern', async () => {
    await storeFidoMdsSnapshot(owner, snapshot({ serial: 9, blobSha256: 'd'.repeat(64) }));
    const before = await anchor();

    await expect(storeFidoMdsSnapshot(owner, snapshot({ serial: 8 }))).rejects.toBeInstanceOf(
      FidoMdsSnapshotOutdatedError,
    );
    expect(await anchor()).toEqual(before);
  });

  it('weist auch bei einem zwischenzeitlich vorgerückten Anker unter Zeilensperre ab', async () => {
    await storeFidoMdsSnapshot(owner, snapshot({ serial: 9, blobSha256: 'd'.repeat(64) }));
    const before = await anchor();
    // Die Vorabprüfung sieht noch keinen Anker (Wettlauf mit einer anderen
    // Worker-Replica); entscheidend ist die Prüfung unter FOR UPDATE.
    const racingClient: FidoMdsTransactionClient = {
      $queryRaw: (async () => []) as unknown as typeof owner.$queryRaw,
      $transaction: owner.$transaction.bind(owner) as typeof owner.$transaction,
    };

    await expect(
      storeFidoMdsSnapshot(racingClient, snapshot({ serial: 8 })),
    ).rejects.toBeInstanceOf(FidoMdsSnapshotOutdatedError);
    expect(await anchor()).toEqual(before);
  });

  it('bindet den App-Commit-Guard an die vom Worker verankerte Serie', async () => {
    await owner.$executeRaw`
      INSERT INTO public."fido_mds_trust_state" (
        "singleton", "blob_serial", "next_update", "verified_at", "policy_revision", "policy_hash"
      ) VALUES (
        TRUE, 0, DATE '1970-01-01', TIMESTAMPTZ '1970-01-01 00:00:00+00', 1, ${'b'.repeat(64)}
      )
    `;
    const guard = (serial: bigint) =>
      owner.$queryRaw<Array<{ matches: boolean | null }>>`
        SELECT app.lock_matching_fido_mds_state(${serial}, ${1n}, ${'b'.repeat(64)}) AS "matches"
      `;
    // Vor dem ersten Worker-Lauf (Serie 0) bestätigt der Guard nichts.
    await expect(guard(0n)).resolves.toEqual([{ matches: false }]);

    await storeFidoMdsSnapshot(owner, snapshot());
    await expect(guard(7n)).resolves.toEqual([{ matches: true }]);

    await storeFidoMdsSnapshot(owner, snapshot({ serial: 8, blobSha256: 'c'.repeat(64) }));
    await expect(guard(7n)).resolves.toEqual([{ matches: false }]);
    await expect(guard(8n)).resolves.toEqual([{ matches: true }]);
  });

  it('weist ungültige Eingaben vor jedem Datenbankzugriff ab', async () => {
    await expect(storeFidoMdsSnapshot(owner, snapshot({ serial: 0 }))).rejects.toThrow(
      /fortlaufende Version/,
    );
    await expect(
      storeFidoMdsSnapshot(owner, snapshot({ nextUpdate: new Date(Number.NaN) })),
    ).rejects.toThrow(/nextUpdate/);
    await expect(storeFidoMdsSnapshot(owner, snapshot({ blobSha256: 'xyz' }))).rejects.toThrow(
      /Prüfsumme/,
    );
    expect(await anchor()).toBeUndefined();
  });
});
