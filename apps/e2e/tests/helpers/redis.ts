import net from 'node:net';

function parseRedisUrl(): { host: string; port: number } {
  const raw = process.env['E2E_REDIS_URL'] ?? process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
  const url = new URL(raw);
  return {
    host: url.hostname || '127.0.0.1',
    port: Number(url.port || 6379),
  };
}

export async function flushRedisDb(): Promise<void> {
  const { host, port } = parseRedisUrl();

  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };

    socket.setTimeout(5000);
    socket.on('connect', () => {
      socket.write('*1\r\n$7\r\nFLUSHDB\r\n');
    });
    socket.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (text.startsWith('+OK')) done();
      else done(new Error(`Redis FLUSHDB failed: ${text.trim()}`));
    });
    socket.on('timeout', () => done(new Error(`Redis FLUSHDB timed out (${host}:${port})`)));
    socket.on('error', done);
  });
}
