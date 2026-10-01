import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withVerifiedDrillFile } from '../backup-drill-file';

describe('BACKUP-DRILL-INTEGRITY-001: verified private copy before restore', () => {
  let directory: string;
  const original = Buffer.from('PGDMP: original trusted backup bytes');
  const expectedSha = createHash('sha256').update(original).digest();

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'drill-file-test-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('passes exactly the verified bytes in a private file and removes them after restore', async () => {
    const restore = vi.fn(async (path: string) => {
      expect(await readFile(path)).toEqual(original);
      if (process.platform !== 'win32') {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
      }
      return 'restored';
    });
    await expect(
      withVerifiedDrillFile({
        body: Readable.from([original.subarray(0, 8), original.subarray(8)]),
        expectedSha,
        expectedSize: BigInt(original.length),
        directory,
        restore,
      }),
    ).resolves.toBe('restored');
    expect(restore).toHaveBeenCalledTimes(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    'tampered',
    'truncated',
    'oversized',
    'missing-hash',
    'invalid-hash',
    'missing-size',
    'zero-size',
  ])('never invokes restore for %s bytes/record and removes partial files', async (kind) => {
    const changed = Buffer.from(original);
    changed[0] = 0;
    const bytes =
      kind === 'tampered'
        ? changed
        : kind === 'truncated'
          ? original.subarray(0, -1)
          : kind === 'oversized'
            ? Buffer.concat([original, Buffer.from('extra')])
            : original;
    const body = Readable.from([bytes]);
    const restore = vi.fn();
    await expect(
      withVerifiedDrillFile({
        body,
        expectedSha:
          kind === 'missing-hash' ? null : kind === 'invalid-hash' ? Buffer.alloc(31) : expectedSha,
        expectedSize:
          kind === 'missing-size' ? null : kind === 'zero-size' ? 0n : BigInt(original.length),
        directory,
        restore,
      }),
    ).rejects.toThrow();
    expect(restore).not.toHaveBeenCalled();
    expect(body.destroyed).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  });

  it('does not restore after an interrupted S3 download', async () => {
    const restore = vi.fn();
    const body = Readable.from(
      (async function* () {
        yield original.subarray(0, 5);
        throw new Error('download interrupted');
      })(),
    );
    await expect(
      withVerifiedDrillFile({
        body,
        expectedSha,
        expectedSize: BigInt(original.length),
        directory,
        restore,
      }),
    ).rejects.toThrow('download interrupted');
    expect(restore).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it('removes verified files when pg_restore fails', async () => {
    await expect(
      withVerifiedDrillFile({
        body: Readable.from([original]),
        expectedSha,
        expectedSize: BigInt(original.length),
        directory,
        restore: async () => {
          throw new Error('pg_restore failed');
        },
      }),
    ).rejects.toThrow('pg_restore failed');
    expect(await readdir(directory)).toEqual([]);
  });

  it('keeps concurrent invocations in distinct private directories', async () => {
    const paths: string[] = [];
    let unblock!: () => void;
    const bothReady = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const restore = async (path: string) => {
      paths.push(path);
      if (paths.length === 2) unblock();
      await bothReady;
      expect(await readFile(path)).toEqual(original);
    };
    await Promise.all(
      [1, 2].map(() =>
        withVerifiedDrillFile({
          body: Readable.from([original]),
          expectedSha,
          expectedSize: BigInt(original.length),
          directory,
          restore,
        }),
      ),
    );
    expect(new Set(paths).size).toBe(2);
    expect(await readdir(directory)).toEqual([]);
  });
});
