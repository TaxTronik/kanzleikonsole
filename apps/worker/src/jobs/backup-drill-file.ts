import { createHash, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** BACKUP-DRILL-INTEGRITY-001: pg_restore must never see unverified dump bytes.
 * A dump can contain executable SQL; checking its digest after restoring is too late.
 * The expected digest/size come from the database BackupRecord, not S3 metadata.
 * Only the private local copy that was hashed is handed to the restore process. */
export async function withVerifiedDrillFile<T>(input: {
  body: Readable;
  expectedSha: Uint8Array | null;
  expectedSize: bigint | null;
  directory?: string;
  restore: (path: string) => Promise<T>;
}): Promise<T> {
  let directory: string | undefined;
  try {
    if (
      !input.expectedSha ||
      input.expectedSha.length !== 32 ||
      !input.expectedSize ||
      input.expectedSize < 0n
    ) {
      throw new Error('BackupRecord ohne gültigen SHA-256-/Größennachweis — kein Restore-Drill.');
    }
    const parent = input.directory ?? process.env['BACKUP_DRILL_TMP_DIR'] ?? tmpdir();
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const capacity = await statfs(parent, { bigint: true });
    if (capacity.bavail * capacity.bsize < input.expectedSize) {
      throw new Error('Nicht genügend Speicherplatz für die verifizierte Restore-Drill-Kopie.');
    }
    directory = await mkdtemp(join(parent, 'taxtronik-drill-'));
    const path = join(directory, 'verified.dump');
    const hash = createHash('sha256');
    let size = 0n;
    const check = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += BigInt(chunk.length);
        if (size > input.expectedSize!) {
          callback(new Error('Backup-Größe überschreitet den BackupRecord — kein Restore-Drill.'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(input.body, check, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
    if (
      size !== input.expectedSize ||
      !timingSafeEqual(hash.digest(), Buffer.from(input.expectedSha))
    ) {
      throw new Error(
        'SHA-256 oder Größe des Dumps weicht vom BackupRecord ab — kein Restore-Drill.',
      );
    }
    return await input.restore(path);
  } finally {
    input.body.destroy();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
