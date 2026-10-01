import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, test } from 'node:test';
import { flushRedisDb } from '../tests/helpers/redis.ts';

const originalEnv = {
  E2E_REDIS_URL: process.env.E2E_REDIS_URL,
  REDIS_URL: process.env.REDIS_URL,
  E2E_PRESERVE_SHARED_SERVICES: process.env.E2E_PRESERVE_SHARED_SERVICES,
};
afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// A real TCP server models independent database contents and RESP acknowledgments.
// Unlike a method stub, it detects pipelined FLUSHDB after a failing SELECT.
async function fakeRedis(
  options: { fragmented?: boolean; endOnSelect?: boolean; malformed?: boolean } = {},
) {
  const databases = [new Set(['db0-sentinel']), new Set(['db1-sentinel'])];
  const commands: string[][] = [];
  const sockets = new Set<net.Socket>();
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let selected = 0;
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk;
      for (;;) {
        const match =
          /^(\*2\r\n\$6\r\nSELECT\r\n\$\d+\r\n(\d+)\r\n|\*1\r\n\$7\r\nFLUSHDB\r\n)/.exec(input);
        if (!match) return;
        input = input.slice(match[0].length);
        const command = match[2] === undefined ? ['FLUSHDB'] : ['SELECT', match[2]];
        commands.push(command);
        if (command[0] === 'SELECT') {
          if (options.endOnSelect) {
            socket.end('+O');
            continue;
          }
          const requested = Number(command[1]);
          if (!databases[requested]) {
            socket.write('-ERR DB index is out of range\r\n');
            continue;
          }
          selected = requested;
        } else databases[selected]!.clear();
        if (options.malformed) socket.write('+OK extra\r\n');
        else if (options.fragmented) {
          socket.write('+O');
          setTimeout(() => socket.write('K\r'), 5);
          setTimeout(() => socket.write('\n'), 10);
        } else socket.write('+OK\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as net.AddressInfo;
  return {
    url: `redis://127.0.0.1:${address.port}`,
    databases,
    commands,
    connections: () => connections,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function configure(url: string) {
  process.env.E2E_REDIS_URL = url;
  delete process.env.E2E_PRESERVE_SHARED_SERVICES;
}

test('SELECTs the requested database before flushing and preserves database zero', async (t) => {
  const redis = await fakeRedis({ fragmented: true });
  t.after(redis.close);
  configure(`${redis.url}/1`);
  await flushRedisDb();
  assert.deepEqual(redis.commands, [['SELECT', '1'], ['FLUSHDB']]);
  assert.equal(redis.databases[0]!.has('db0-sentinel'), true);
  assert.equal(redis.databases[1]!.size, 0);
});

test('defaults to database zero and uses REDIS_URL when no E2E override exists', async (t) => {
  const redis = await fakeRedis();
  t.after(redis.close);
  configure(redis.url);
  delete process.env.E2E_REDIS_URL;
  process.env.REDIS_URL = redis.url;
  await flushRedisDb();
  assert.deepEqual(redis.commands, [['SELECT', '0'], ['FLUSHDB']]);
  assert.equal(redis.databases[0]!.size, 0);
  assert.equal(redis.databases[1]!.has('db1-sentinel'), true);
});

test('failed SELECT never sends FLUSHDB and preserves every database', async (t) => {
  const redis = await fakeRedis();
  t.after(redis.close);
  configure(`${redis.url}/99`);
  await assert.rejects(flushRedisDb(), /SELECT failed.*out of range/);
  await delay(20);
  assert.deepEqual(redis.commands, [['SELECT', '99']]);
  assert.equal(redis.databases[0]!.has('db0-sentinel'), true);
  assert.equal(redis.databases[1]!.has('db1-sentinel'), true);
});

test('incomplete reply followed by connection end fails without flushing', async (t) => {
  const redis = await fakeRedis({ endOnSelect: true });
  t.after(redis.close);
  configure(`${redis.url}/1`);
  await assert.rejects(flushRedisDb(), /ended before SELECT completed/);
  assert.deepEqual(redis.commands, [['SELECT', '1']]);
  assert.equal(redis.databases[0]!.has('db0-sentinel'), true);
  assert.equal(redis.databases[1]!.has('db1-sentinel'), true);
});

test('a malformed positive reply is not an acknowledgment and cannot authorize flushing', async (t) => {
  const redis = await fakeRedis({ malformed: true });
  t.after(redis.close);
  configure(`${redis.url}/1`);
  await assert.rejects(flushRedisDb(), /SELECT failed/);
  assert.deepEqual(redis.commands, [['SELECT', '1']]);
  assert.equal(redis.databases[1]!.has('db1-sentinel'), true);
});

for (const path of ['/x', '/-1', '/1.5', '/01', '/1/2', '/5/../0', '/%31', '/9007199254740992']) {
  test(`rejects invalid database path ${path} before any network I/O`, async (t) => {
    const redis = await fakeRedis();
    t.after(redis.close);
    configure(`${redis.url}${path}`);
    await assert.rejects(flushRedisDb(), /database/);
    assert.equal(redis.connections(), 0);
  });
}

for (const variant of ['credentials', 'tls', 'query', 'fragment']) {
  test(`rejects unsupported ${variant} before any network I/O`, async (t) => {
    const redis = await fakeRedis();
    t.after(redis.close);
    const url = new URL(`${redis.url}/1`);
    if (variant === 'credentials') {
      url.username = 'user';
      url.password = 'password';
    }
    if (variant === 'tls') url.protocol = 'rediss:';
    if (variant === 'query') url.search = '?db=0';
    if (variant === 'fragment') url.hash = '#0';
    configure(url.toString());
    await assert.rejects(flushRedisDb(), /without credentials, TLS, query or fragment/);
    assert.equal(redis.connections(), 0);
  });
}

test('preserveShared bypasses cleanup and makes no connection', async (t) => {
  const redis = await fakeRedis();
  t.after(redis.close);
  configure(`${redis.url}/1`);
  process.env.E2E_PRESERVE_SHARED_SERVICES = 'true';
  await flushRedisDb();
  assert.equal(redis.connections(), 0);
  assert.equal(redis.databases[0]!.has('db0-sentinel'), true);
  assert.equal(redis.databases[1]!.has('db1-sentinel'), true);
});
