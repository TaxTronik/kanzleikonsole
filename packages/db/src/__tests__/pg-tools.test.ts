import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { pgConnArgs, pgDumpArgs, spawnPgDump } from '../pg-tools';

describe('PostgreSQL process tools', () => {
  it('keeps credentials out of argv and preserves SSL mode', () => {
    const result = pgConnArgs(
      'postgresql://db%20user:s3cr%25t@db.internal:6543/taxtronik?sslmode=require',
    );

    expect(result.args).toEqual([
      '-h',
      'db.internal',
      '-p',
      '6543',
      '-U',
      'db user',
      '-d',
      'taxtronik',
    ]);
    expect(result.args.join(' ')).not.toContain('s3cr');
    expect(result.env).toEqual({ PGPASSWORD: 's3cr%t', PGSSLMODE: 'require' });
  });

  it('builds one canonical custom-format dump argument list', () => {
    expect(pgDumpArgs(['-h', 'db'])).toEqual([
      '--format=custom',
      '--no-owner',
      '--compress=6',
      '-h',
      'db',
    ]);
  });

  it('streams bytes while calculating their hash and size', async () => {
    const content = 'shared dump stream';
    const dump = spawnPgDump({}, ['-e', `process.stdout.write(${JSON.stringify(content)})`], {
      path: process.execPath,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of dump.stream) chunks.push(Buffer.from(chunk));

    await expect(dump.result()).resolves.toEqual({
      sha: createHash('sha256').update(content).digest(),
      sizeBytes: Buffer.byteLength(content),
    });
    expect(Buffer.concat(chunks).toString('utf8')).toBe(content);
  });

  it('reports missing pg_dump executables without an unhandled stream error', async () => {
    const dump = spawnPgDump({}, [], { path: 'definitely-missing-pg-dump-binary' });
    dump.stream.on('error', () => undefined);
    await expect(dump.result()).rejects.toThrow('pg_dump konnte nicht gestartet werden');
  });
});
