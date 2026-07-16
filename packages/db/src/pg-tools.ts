import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';

export interface PgConnectionArgs {
  args: string[];
  env: Record<string, string>;
}

/** Keep PostgreSQL passwords out of process arguments and process listings. */
export function pgConnArgs(dbUrl: string): PgConnectionArgs {
  const url = new URL(dbUrl);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('PostgreSQL-URL erwartet.');
  }
  const username = decodeURIComponent(url.username);
  const args = [
    '-h',
    url.hostname,
    '-p',
    url.port || '5432',
    '-U',
    username,
    '-d',
    url.pathname.slice(1) ? decodeURIComponent(url.pathname.slice(1)) : username,
  ];
  const env: Record<string, string> = { PGPASSWORD: decodeURIComponent(url.password) };
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) env['PGSSLMODE'] = sslmode;
  return { args, env };
}

export function pgDumpArgs(connectionArgs: readonly string[]): string[] {
  return ['--format=custom', '--no-owner', '--compress=6', ...connectionArgs];
}

export interface PgDumpResult {
  sha: Buffer;
  sizeBytes: number;
}

export interface PgDumpProcess {
  stream: PassThrough;
  result: () => Promise<PgDumpResult>;
  abort: () => void;
}

/**
 * Starts pg_dump once and exposes a sink-neutral byte stream. Hashing, byte
 * counting, stderr limiting and ENOENT handling are shared by web and worker.
 */
export function spawnPgDump(
  connectionEnv: Record<string, string>,
  args: readonly string[],
  options: {
    path?: string;
    parentEnv?: NodeJS.ProcessEnv;
  } = {},
): PgDumpProcess {
  const child = spawn(options.path ?? process.env['PG_DUMP_PATH'] ?? 'pg_dump', [...args], {
    env: { ...(options.parentEnv ?? process.env), ...connectionEnv },
  });
  const hash = createHash('sha256');
  let sizeBytes = 0;
  let stderr = '';
  let spawnError: Error | null = null;

  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 1_000) stderr += chunk.toString('utf8').slice(0, 1_000 - stderr.length);
  });
  const stream = new PassThrough();
  child.stdout.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    sizeBytes += chunk.length;
  });
  child.stdout.pipe(stream);

  let settle!: (code: number) => void;
  let settled = false;
  const completion = new Promise<number>((resolve) => {
    settle = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
  });
  child.on('close', (code) => settle(code ?? -1));
  child.on('error', (error) => {
    spawnError = error;
    stream.destroy(error);
    settle(-1);
  });

  let resultPromise: Promise<PgDumpResult> | undefined;
  return {
    stream,
    result: () => {
      resultPromise ??= completion.then((code) => {
        if (spawnError) {
          throw new Error(`pg_dump konnte nicht gestartet werden: ${spawnError.message}`);
        }
        if (code !== 0) throw new Error(`pg_dump exit ${code}: ${stderr}`);
        return { sha: hash.digest(), sizeBytes };
      });
      return resultPromise;
    },
    abort: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      if (!stream.destroyed) stream.destroy();
    },
  };
}

export function prismaBytes(value: Buffer | Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value);
}
