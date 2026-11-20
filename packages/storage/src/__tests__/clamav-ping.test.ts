import { once } from 'node:events';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { pingClamAv } from '../clamav-ping';

async function probe(reply: (socket: Socket) => void, timeout = 1_000) {
  const server = createServer((socket) => socket.once('data', () => reply(socket)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await pingClamAv('127.0.0.1', (server.address() as AddressInfo).port, timeout);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('ClamAV readiness', () => {
  it('accepts a fragmented PONG frame', async () => {
    await expect(
      probe((socket) => {
        socket.write('PO');
        setImmediate(() => socket.end('NG\0'));
      }),
    ).resolves.toBeUndefined();
  });

  it.each(['', 'PO', 'ERROR\0'])('rejects a closed connection with reply %j', async (reply) => {
    await expect(probe((socket) => socket.end(reply))).rejects.toThrow('PONG');
  });

  it('aborts a connected socket that never replies', async () => {
    await expect(probe(() => {}, 75)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
