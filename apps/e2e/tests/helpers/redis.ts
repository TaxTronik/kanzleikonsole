import net from 'node:net';

function parseRedisUrl(): { host: string; port: number; database: number } {
  const raw = process.env['E2E_REDIS_URL'] ?? process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
  const url = new URL(raw);
  // This intentionally small test helper supports unauthenticated TCP Redis only.
  // Never silently discard TLS, credentials, options or the selected database.
  if (url.protocol !== 'redis:' || url.username || url.password || url.search || url.hash) {
    throw new Error(
      'E2E Redis cleanup requires redis:// without credentials, TLS, query or fragment.',
    );
  }
  // URL normalizes dot segments. Validate the original path so /5/../0 cannot
  // silently turn a requested cleanup into a different database selection.
  const parts = /^redis:\/\/[^/?#]+(\/[^?#]*)?$/i.exec(raw);
  if (!parts) throw new Error('E2E Redis URL must use the explicit redis://host/database form.');
  const path = parts[1] ?? '';
  if (path !== '' && path !== '/' && !/^\/(0|[1-9]\d*)$/.test(path)) {
    throw new Error('E2E Redis database must be a nonnegative integer URL path.');
  }
  const database = path === '' || path === '/' ? 0 : Number(path.slice(1));
  const port = Number(url.port || 6379);
  if (!Number.isSafeInteger(database) || port < 1) {
    throw new Error('E2E Redis database or port is outside the supported range.');
  }
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port,
    database,
  };
}

export async function flushRedisDb(): Promise<void> {
  // Die A11Y-Stichprobe darf auf einem gemeinsam genutzten Dev-Stack keine
  // Worker-/Signal-Jobs oder fremde Sitzungsdaten pauschal entfernen.
  if (process.env['E2E_PRESERVE_SHARED_SERVICES'] === 'true') return;
  const { host, port, database } = parseRedisUrl();

  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    let command = 'SELECT';
    let response = '';

    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };

    socket.setTimeout(5000);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      const db = String(database);
      socket.write(`*2\r\n$6\r\nSELECT\r\n$${db.length}\r\n${db}\r\n`);
    });
    socket.on('data', (chunk) => {
      if (settled) return;
      response += chunk;
      if (response.length > 4096) return done(new Error(`Redis ${command} reply is too large.`));
      const end = response.indexOf('\r\n');
      if (end === -1) return;
      if (response !== '+OK\r\n') {
        return done(new Error(`Redis ${command} failed: ${response.trim()}`));
      }
      if (command === 'FLUSHDB') return done();
      // Await a complete successful SELECT reply before sending the destructive
      // command. A rejected SELECT must never fall through to flushing DB 0.
      command = 'FLUSHDB';
      response = '';
      socket.write('*1\r\n$7\r\nFLUSHDB\r\n');
    });
    socket.on('timeout', () => done(new Error(`Redis ${command} timed out (${host}:${port})`)));
    socket.on('end', () => done(new Error(`Redis connection ended before ${command} completed.`)));
    socket.on('close', () =>
      done(new Error(`Redis connection closed before ${command} completed.`)),
    );
    socket.on('error', done);
  });
}
