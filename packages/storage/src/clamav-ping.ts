import { once } from 'node:events';
import { createConnection } from 'node:net';

/** The zPING command and its response are NUL-terminated clamd frames. */
export async function pingClamAv(host: string, port: number, timeoutMs: number): Promise<void> {
  const socket = createConnection({ host, port, signal: AbortSignal.timeout(timeoutMs) });
  const expected = 'PONG\0';
  let received = '';
  try {
    await once(socket, 'connect');
    socket.write('zPING\0');
    for await (const chunk of socket) {
      if (chunk.length > expected.length - received.length) break;
      received += chunk.toString('latin1');
      if (received === expected) return;
      if (!expected.startsWith(received)) break;
    }
    throw new Error('ClamAV hat kein vollständiges PONG gesendet.');
  } finally {
    socket.destroy();
  }
}
