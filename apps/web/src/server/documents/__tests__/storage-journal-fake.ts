// =============================================================================
// Testdouble fuer Journal-first-Uploads (Review-Finding K-06).
//
// Bildet die Teile nach, die ein Upload-Pfad vom Object Store und vom
// Storage-Orphan-Journal sieht: Vorbereiten (Scan, Hash, fester Schluessel),
// bedingter PUT, Owner-Journal (`storage_orphan`) und den atomaren Abschluss
// ueber `app.settle_storage_intent`. Pfadtests nutzen ihn, um einen
// Prozessabbruch zwischen PUT und DB-Commit nachzustellen und den dann
// verbleibenden Journalzustand zu pruefen. Dass der Cleanup-Worker genau
// solche Zeilen aufloest, belegt `apps/worker/.../storage-orphan-cleanup-db.test.ts`.
// =============================================================================

import { createHash } from 'node:crypto';
import type { CommitDocumentResult, PreparedBytesCommit } from '@taxtronik/storage';

type Tier = PreparedBytesCommit['tier'];

export interface JournalRow {
  id: string;
  tenantId: string;
  source: string;
  intent: boolean;
  storageBucket: string;
  storageKey: string;
  storageVersionId: string;
  sha256: Uint8Array;
  sizeBytes: bigint;
  immutable: boolean;
  retentionUntil: Date | null;
  failure: string | null;
  cleanupError: string | null;
  resolution: string | null;
  cleanedAt: Date | null;
  cleanupClaimedAt: Date | null;
}

export interface StoredObject {
  bucket: string;
  key: string;
  versionId: string;
  sha256: Buffer;
  sizeBytes: bigint;
  retainUntil: Date | null;
}

type Where = Record<string, unknown>;

function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([field, expected]) => {
    const actual = row[field];
    if (expected && typeof expected === 'object' && 'in' in (expected as object)) {
      return (expected as { in: unknown[] }).in.includes(actual);
    }
    if (expected === null) return actual === null || actual === undefined;
    return actual === expected;
  });
}

export const FAKE_RETENTION_UNTIL = new Date(Date.UTC(2036, 0, 1));

class StorageJournalFake {
  rows: JournalRow[] = [];
  objects: StoredObject[] = [];
  /** Reihenfolge der beobachtbaren Schritte (prepare, journal, put, settle, ...). */
  events: string[] = [];
  failJournal: Error | null = null;
  failPut: Error | null = null;
  private seq = 0;

  reset(): void {
    this.rows = [];
    this.objects = [];
    this.events = [];
    this.failJournal = null;
    this.failPut = null;
    this.seq = 0;
  }

  /** `prepareBytesCommitWithTier`: Scan (EICAR-Praefix = infiziert), Hash, fester Key. */
  prepare = async (input: {
    fileData: Buffer;
    tier: Tier;
    tenantId: string;
    skipScan?: boolean;
    classification?: string;
    retentionYears?: number;
    retentionAnchor?: Date;
  }): Promise<PreparedBytesCommit> => {
    this.events.push('prepare');
    if (!input.skipScan && input.fileData.subarray(0, 5).toString('latin1') === 'EICAR') {
      throw new Error('INFECTED: Datei wurde von ClamAV als infiziert markiert.');
    }
    const immutable = input.tier !== 'NONE';
    const n = ++this.seq;
    return {
      tier: input.tier,
      tenantId: input.tenantId,
      targetBucket: `bucket-${input.tier.toLowerCase()}`,
      targetKey: `tenants/${input.tenantId}/${input.tier.toLowerCase()}/2026/10/object-${n}.bin`,
      sha256: createHash('sha256').update(input.fileData).digest(),
      sizeBytes: BigInt(input.fileData.length),
      immutable,
      retentionUntil: immutable ? FAKE_RETENTION_UNTIL : null,
      detectedMime:
        input.fileData.subarray(0, 5).toString('latin1') === '%PDF-' ? 'application/pdf' : null,
    };
  };

  /** `commitPreparedBytes`: genau eine Version unter dem festen Schluessel. */
  commit = async (input: {
    fileData: Buffer;
    prepared: PreparedBytesCommit;
  }): Promise<CommitDocumentResult> => {
    const { prepared } = input;
    this.events.push(`put:${prepared.targetKey}`);
    if (this.failPut) throw this.failPut;
    const sha256 = createHash('sha256').update(input.fileData).digest();
    if (!sha256.equals(prepared.sha256)) throw new Error('PREPARED_UPLOAD_MISMATCH');
    const versionId = `version-${++this.seq}`;
    this.objects.push({
      bucket: prepared.targetBucket,
      key: prepared.targetKey,
      versionId,
      sha256,
      sizeBytes: BigInt(input.fileData.length),
      retainUntil: prepared.retentionUntil,
    });
    return {
      targetBucket: prepared.targetBucket,
      targetKey: prepared.targetKey,
      storageVersionId: versionId,
      sha256: Buffer.from(prepared.sha256),
      sizeBytes: prepared.sizeBytes,
      immutable: prepared.immutable,
      retentionUntil: prepared.retentionUntil,
      detectedMime: prepared.detectedMime,
    };
  };

  /** Owner-Client mit der Teilmenge von `storageOrphan`, die die Upload-Pfade nutzen. */
  owner = {
    $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
    storageOrphan: {
      create: async ({ data }: { data: Partial<JournalRow> }) => {
        this.events.push('journal');
        if (this.failJournal) throw this.failJournal;
        const row: JournalRow = {
          id: `intent-${++this.seq}`,
          tenantId: '',
          source: '',
          intent: false,
          storageBucket: '',
          storageKey: '',
          storageVersionId: '',
          sha256: new Uint8Array(),
          sizeBytes: 0n,
          immutable: false,
          retentionUntil: null,
          failure: null,
          cleanupError: null,
          resolution: null,
          cleanedAt: null,
          cleanupClaimedAt: null,
          ...data,
        };
        this.rows.push(row);
        return { id: row.id };
      },
      updateMany: async ({ where, data }: { where: Where; data: Partial<JournalRow> }) => {
        const hits = this.rows.filter((row) =>
          matches(row as unknown as Record<string, unknown>, where),
        );
        for (const row of hits) Object.assign(row, data);
        this.events.push(`journal-update:${hits.length}`);
        return { count: hits.length };
      },
      upsert: async (input: {
        where: {
          storageBucket_storageKey_storageVersionId: {
            storageBucket: string;
            storageKey: string;
            storageVersionId: string;
          };
        };
        create: Partial<JournalRow>;
        update: Partial<JournalRow>;
      }) => {
        this.events.push('compensate');
        const key = input.where.storageBucket_storageKey_storageVersionId;
        const existing = this.rows.find((row) => matches(row as never, key));
        if (existing) {
          Object.assign(existing, input.update);
          return existing;
        }
        const defaults: Partial<JournalRow> = {
          intent: false,
          storageVersionId: '',
          failure: null,
          cleanupError: null,
          resolution: null,
          cleanedAt: null,
          cleanupClaimedAt: null,
          retentionUntil: null,
        };
        const row = {
          ...defaults,
          ...input.create,
          id: `orphan-${++this.seq}`,
        } as JournalRow;
        this.rows.push(row);
        return row;
      },
    },
  };

  /**
   * `tx.$executeRaw` fuer `app.settle_storage_intent`: dieselben Bedingungen
   * wie die DB-Funktion (offen, unbeansprucht, gleiche Identitaet). Die
   * Dokumentreferenz prueft der DB-Test; hier zaehlt die Reihenfolge.
   */
  executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
    const sql = strings.join('?');
    if (!sql.includes('app.settle_storage_intent')) {
      throw new Error(`storage-journal-fake: unerwartetes SQL ${sql}`);
    }
    const [id, bucket, key, version] = values as [string, string, string, string];
    this.events.push('settle');
    const row = this.rows.find(
      (candidate) =>
        candidate.id === id &&
        candidate.intent &&
        candidate.cleanedAt === null &&
        candidate.cleanupClaimedAt === null &&
        candidate.storageBucket === bucket &&
        candidate.storageKey === key &&
        (candidate.storageVersionId === '' || candidate.storageVersionId === version),
    );
    if (!row) throw new Error('STORAGE_INTENT_NOT_OPEN: Speicherabsicht ist nicht mehr offen.');
    Object.assign(row, {
      storageVersionId: version,
      resolution: 'REFERENCED',
      cleanedAt: new Date(),
    });
    return 1;
  };

  openIntents(): JournalRow[] {
    return this.rows.filter((row) => row.intent && row.cleanedAt === null);
  }

  /**
   * Prueft den Vertrag, den der Cleanup-Worker an eine offene Absicht stellt:
   * auswaehlbar (offen, unbeansprucht), Tenant-Praefix, und genau ein Objekt
   * mit identischem Hash und identischer Groesse (oder keines -> ABSENT).
   */
  workerContract(row: JournalRow): {
    selectable: boolean;
    tenantPrefix: boolean;
    objectVersions: number;
    retentionGated: boolean;
  } {
    const versions = this.objects.filter(
      (object) =>
        object.bucket === row.storageBucket &&
        object.key === row.storageKey &&
        object.sizeBytes === row.sizeBytes &&
        object.sha256.equals(Buffer.from(row.sha256)),
    );
    return {
      selectable: row.intent && row.cleanedAt === null && row.cleanupClaimedAt === null,
      tenantPrefix: row.storageKey.startsWith(`tenants/${row.tenantId}/`),
      objectVersions: versions.length,
      retentionGated: !row.immutable || row.retentionUntil !== null,
    };
  }
}

export const storageJournal = new StorageJournalFake();

/** Haengt den Prozess an dieser Stelle auf: kein Commit, keine Kompensation. */
export function processCrash(): Promise<never> {
  return new Promise<never>(() => undefined);
}

/** Wartet, bis ein Ereignis (z. B. der PUT) beobachtet wurde. */
export async function waitForEvent(prefix: string, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!storageJournal.events.some((event) => event.startsWith(prefix))) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`storage-journal-fake: ${prefix} nicht beobachtet`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
