// Fachkatalog: ACCESS-TENANT-RLS-001
// Staff-Passwortvergleiche laufen in einem begrenzten worker_threads-Pool:
// identische Ergebnisse wie bcryptjs.compare, echte Parallelität, sofortige
// Abweisung bei voller Warteschlange, Neustart nach Thread-Ausfall und eine
// reaktionsfähige Event-Loop, während Vergleiche mit Produktionskosten laufen.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Worker } from 'node:worker_threads';
import bcrypt from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('@/server/logger', () => ({ log: h.log }));

import {
  comparePasswordHashes,
  defaultPasswordHashPoolSize,
  PASSWORD_HASH_POOL_MAX_QUEUE,
  PASSWORD_HASH_POOL_MAX_SIZE,
  PasswordHashPool,
  PasswordHashPoolSaturatedError,
  PasswordHashPoolUnavailableError,
  type PasswordHashPoolOptions,
} from '../password-hash-pool';
import {
  DUMMY_PASSWORD_HASH,
  STAFF_PASSWORD_HASH_COST,
  verifyStaffPassword,
} from '../staff-password';

// Schnelle Hashes für Ergebnisvergleiche; Produktionskosten nur, wo die
// Laufzeit selbst Gegenstand ist.
const FAST_HASH = bcrypt.hashSync('richtiges-passwort', 4);
const SLOW_HASH = DUMMY_PASSWORD_HASH;

const pools: PasswordHashPool[] = [];

function pool(options: PasswordHashPoolOptions = {}): {
  pool: PasswordHashPool;
  workers: Worker[];
} {
  const workers: Worker[] = [];
  const created = new PasswordHashPool({
    ...options,
    onWorkerStart: (worker) => workers.push(worker),
  });
  pools.push(created);
  return { pool: created, workers };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await Promise.all(pools.splice(0).map((created) => created.close()));
});

describe('Passwort-Pool: Größe und Grenzen', () => {
  it('leitet die Größe aus der verfügbaren Parallelität ab (mindestens 2, höchstens 4)', () => {
    expect(PASSWORD_HASH_POOL_MAX_SIZE).toBe(4);
    expect(PASSWORD_HASH_POOL_MAX_QUEUE).toBe(32);
    expect([1, 2, 3, 4, 5, 8, 64].map((cores) => defaultPasswordHashPoolSize(cores))).toEqual([
      2, 2, 2, 3, 4, 4, 4,
    ]);
    const created = new PasswordHashPool();
    pools.push(created);
    expect(created.stats()).toEqual({
      size: defaultPasswordHashPoolSize(),
      maxQueue: 32,
      workers: 0,
      active: 0,
      queued: 0,
    });
  });
});

describe('Passwort-Pool: Ergebnisse wie bcryptjs.compare', () => {
  const unicodeHash = bcrypt.hashSync('Grüße 🔐 Kanzlei', 4);
  const longHash = bcrypt.hashSync('a'.repeat(72), 4);
  const legacyPrefixHash = FAST_HASH.replace(/^\$2b\$/, '$2a$');

  it.each([
    ['richtiges Passwort', 'richtiges-passwort', FAST_HASH],
    ['falsches Passwort', 'falsches-passwort', FAST_HASH],
    ['leeres Passwort', '', FAST_HASH],
    ['Unicode', 'Grüße 🔐 Kanzlei', unicodeHash],
    ['Unicode, falsch', 'Grüsse 🔐 Kanzlei', unicodeHash],
    ['über 72 Byte (bcrypt kürzt)', 'a'.repeat(80), longHash],
    ['$2a$-Präfix', 'richtiges-passwort', legacyPrefixHash],
    ['Hash mit falscher Länge', 'richtiges-passwort', FAST_HASH.slice(0, 59)],
    ['Dummy-Hash mit Produktionskosten', 'richtiges-passwort', DUMMY_PASSWORD_HASH],
  ])(
    '%s',
    async (_case, password, hash) => {
      const { pool: created } = pool({ size: 2 });
      await expect(created.compare(password, hash)).resolves.toBe(
        await bcrypt.compare(password, hash),
      );
    },
    30_000,
  );

  it('weist einen ungültigen Hash mit derselben Fehlermeldung wie bcryptjs ab', async () => {
    const invalid = `$2x$04$${'a'.repeat(53)}`;
    const expected = await bcrypt.compare('passwort', invalid).then(
      () => null,
      (error: Error) => error.message,
    );
    expect(expected).toEqual(expect.any(String));
    const { pool: created } = pool({ size: 1 });
    await expect(created.compare('passwort', invalid)).rejects.toThrow(expected!);
    // Der Thread bleibt nach einem Vergleichsfehler nutzbar.
    await expect(created.compare('richtiges-passwort', FAST_HASH)).resolves.toBe(true);
    expect(created.stats().workers).toBe(1);
  });

  it('prüft die Staff-Anmeldung mit genau einem Vergleich im Pool', async () => {
    expect(bcrypt.getRounds(DUMMY_PASSWORD_HASH)).toBe(STAFF_PASSWORD_HASH_COST);
    await expect(
      verifyStaffPassword('richtiges-passwort', { passwordHash: FAST_HASH }),
    ).resolves.toBe(true);
    await expect(verifyStaffPassword('falsch', { passwordHash: FAST_HASH })).resolves.toBe(false);
    // Ohne zulässiges Konto: Vergleich gegen den Dummy-Hash, Ergebnis immer false.
    await expect(verifyStaffPassword('richtiges-passwort', null)).resolves.toBe(false);
  }, 30_000);
});

describe('Passwort-Pool: Parallelität und Warteschlange', () => {
  it('verteilt Vergleiche parallel auf alle Threads und reiht den Rest ein', async () => {
    const { pool: created, workers } = pool({ size: 2, maxQueue: 8 });
    const pending = Array.from({ length: 5 }, (_, index) =>
      created.compare(index === 0 ? 'richtiges-passwort' : `falsch-${index}`, SLOW_HASH),
    );

    expect(created.stats()).toMatchObject({ workers: 2, active: 2, queued: 3 });
    expect(workers).toHaveLength(2);
    await expect(Promise.all(pending)).resolves.toEqual([false, false, false, false, false]);
    expect(created.stats()).toMatchObject({ workers: 2, active: 0, queued: 0 });
  }, 30_000);

  it('weist bei voller Warteschlange sofort ab und warnt gedrosselt', async () => {
    const { pool: created } = pool({ size: 1, maxQueue: 2 });
    const accepted = [
      created.compare('a', SLOW_HASH),
      created.compare('b', SLOW_HASH),
      created.compare('c', SLOW_HASH),
    ];
    expect(created.stats()).toMatchObject({ active: 1, queued: 2 });

    const rejected = [created.compare('d', SLOW_HASH), created.compare('e', SLOW_HASH)];
    for (const attempt of rejected) {
      await expect(attempt).rejects.toBeInstanceOf(PasswordHashPoolSaturatedError);
    }
    // Abgewiesen, bevor der erste Vergleich fertig ist; nichts nachgereiht.
    expect(created.stats()).toMatchObject({ active: 1, queued: 2 });
    expect(h.log.warn).toHaveBeenCalledTimes(1);
    expect(h.log.warn).toHaveBeenCalledWith(
      { component: 'password-hash-pool', rejected: 1, size: 1, maxQueue: 2 },
      'Passwortprüfung ausgelastet – Anmeldeversuche werden ohne Prüfung generisch abgewiesen',
    );

    await expect(Promise.all(accepted)).resolves.toEqual([false, false, false]);
    // Nach dem Abbau nimmt der Pool wieder an.
    await expect(created.compare('richtiges-passwort', FAST_HASH)).resolves.toBe(true);
  }, 30_000);
});

describe('Passwort-Pool: Backup-Codes, je Versuch alle Hashes (S-09)', () => {
  const CODES = ['BACKUP0001', 'BACKUP0002', 'BACKUP0003', 'BACKUP0004'];
  const CODE_HASHES = CODES.map((code) => bcrypt.hashSync(code, 4));
  const settledLikeBcrypt = (code: string, hashes: readonly string[]) =>
    hashes.map((hash) => ({ status: 'fulfilled', value: bcrypt.compareSync(code, hash) }));

  it.each([
    ['ersten', 0],
    ['dritten', 2],
    ['letzten', 3],
    ['keinen', -1],
  ])(
    'vergleicht bei einem Treffer auf den %s Hash jeden Hash genau einmal',
    async (_case, hit) => {
      const posted: string[] = [];
      const created = new PasswordHashPool({
        size: 2,
        onWorkerStart: (worker) => {
          const post = worker.postMessage.bind(worker);
          worker.postMessage = (task: { hash: string }) => {
            posted.push(task.hash);
            post(task);
          };
        },
      });
      pools.push(created);
      const code = hit < 0 ? 'BACKUP9999' : CODES[hit]!;

      const results = await created.compareEach(code, CODE_HASHES);

      expect(results).toEqual(settledLikeBcrypt(code, CODE_HASHES));
      expect(
        results.filter((result) => result.status === 'fulfilled' && result.value),
      ).toHaveLength(hit < 0 ? 0 : 1);
      // Kein Abbruch beim Treffer: jeder Hash ging genau einmal an einen Thread.
      expect([...posted].sort()).toEqual([...CODE_HASHES].sort());
    },
    30_000,
  );

  it('nimmt die Vergleiche eines Versuchs gemeinsam oder gar nicht an', async () => {
    const { pool: created } = pool({ size: 1, maxQueue: 2 });
    // Ein Thread und zwei Warteplätze: vier Hashes passen nicht, keiner startet.
    await expect(created.compareEach(CODES[0]!, CODE_HASHES)).rejects.toBeInstanceOf(
      PasswordHashPoolSaturatedError,
    );
    expect(created.stats()).toMatchObject({ workers: 1, active: 0, queued: 0 });
    expect(h.log.warn).toHaveBeenCalledOnce();

    // Drei passen genau: einer läuft, zwei warten; danach ist kein Platz mehr.
    const accepted = created.compareEach(CODES[0]!, CODE_HASHES.slice(0, 3));
    expect(created.stats()).toMatchObject({ active: 1, queued: 2 });
    await expect(created.compare(CODES[0]!, FAST_HASH)).rejects.toBeInstanceOf(
      PasswordHashPoolSaturatedError,
    );
    await expect(accepted).resolves.toEqual(settledLikeBcrypt(CODES[0]!, CODE_HASHES.slice(0, 3)));

    await created.close();
    await expect(created.compareEach(CODES[0]!, CODE_HASHES)).rejects.toBeInstanceOf(
      PasswordHashPoolUnavailableError,
    );
  }, 30_000);

  it('liefert Vergleichsfehler je Hash und beendet trotzdem alle übrigen Vergleiche', async () => {
    const invalid = `$2x$04$${'a'.repeat(53)}`;
    const expected = await bcrypt.compare(CODES[0]!, invalid).then(
      () => null,
      (error: Error) => error.message,
    );
    expect(expected).toEqual(expect.any(String));
    const { pool: created } = pool({ size: 1 });

    const results = await created.compareEach(CODES[0]!, [invalid, CODE_HASHES[0]!, invalid]);

    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled', 'rejected']);
    expect(results[1]).toEqual({ status: 'fulfilled', value: true });
    expect((results[0] as PromiseRejectedResult).reason).toMatchObject({ message: expected });
    expect(created.stats()).toMatchObject({ workers: 1, active: 0, queued: 0 });
  }, 30_000);

  it('startet ohne Hashes keinen Thread und prüft sonst im prozessweiten Pool', async () => {
    const { pool: created, workers } = pool({ size: 2 });
    await expect(created.compareEach(CODES[0]!, [])).resolves.toEqual([]);
    expect(workers).toHaveLength(0);
    await expect(comparePasswordHashes(CODES[0]!, [])).resolves.toEqual([]);

    await expect(comparePasswordHashes(CODES[1]!, CODE_HASHES)).resolves.toEqual(
      settledLikeBcrypt(CODES[1]!, CODE_HASHES),
    );
  }, 30_000);
});

describe('Passwort-Pool: Ausfall und Neustart', () => {
  it('lässt nur den laufenden Vergleich scheitern und startet einen neuen Thread', async () => {
    const { pool: created, workers } = pool({ size: 1 });
    const inFlight = created.compare('richtiges-passwort', SLOW_HASH);
    const queued = created.compare('richtiges-passwort', FAST_HASH);
    expect(workers).toHaveLength(1);

    await workers[0]!.terminate();

    await expect(inFlight).rejects.toBeInstanceOf(PasswordHashPoolUnavailableError);
    await expect(queued).resolves.toBe(true);
    expect(workers).toHaveLength(2);
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'password-hash-pool', exitCode: expect.any(Number) }),
      'Passwortprüf-Thread unerwartet beendet',
    );
    await expect(created.compare('falsch', FAST_HASH)).resolves.toBe(false);
  }, 30_000);

  it('startet bei wiederholtem Startfehler nicht im Takt neu, sondern sperrt vorübergehend', async () => {
    const { pool: created, workers } = pool({
      size: 1,
      bcryptPath: '/nicht/vorhanden/bcryptjs.js',
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(created.compare('passwort', FAST_HASH)).rejects.toBeInstanceOf(
        PasswordHashPoolUnavailableError,
      );
    }
    expect(workers).toHaveLength(3);
    expect(h.log.error).toHaveBeenCalledWith(
      { component: 'password-hash-pool', cooldownMs: 30_000 },
      'Passwortprüfung gestört – Anmeldeversuche werden vorübergehend abgewiesen',
    );

    await expect(created.compare('passwort', FAST_HASH)).rejects.toBeInstanceOf(
      PasswordHashPoolUnavailableError,
    );
    expect(workers).toHaveLength(3);
  }, 30_000);
});

describe('Passwort-Pool: Event-Loop bleibt reaktionsfähig', () => {
  it('blockiert den Haupt-Thread nicht, während zehn Vergleiche mit Kosten 12 laufen', async () => {
    // Vergleichsmaß: ein einziger Vergleich im Haupt-Thread blockiert ihn so lange.
    const started = performance.now();
    expect(bcrypt.compareSync('richtiges-passwort', SLOW_HASH)).toBe(false);
    const blockingMs = performance.now() - started;

    const { pool: created } = pool({ size: 2 });
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 10);
    const startedAll = performance.now();
    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) => created.compare(`versuch-${index}`, SLOW_HASH)),
      );
      expect(results).toEqual(Array.from({ length: 10 }, () => false));
    } finally {
      clearInterval(ticker);
      delay.disable();
    }
    const totalMs = performance.now() - startedAll;
    const maxDelayMs = delay.max / 1e6;

    // Im Haupt-Thread hätten zehn Vergleiche ihn ~10 × blockingMs belegt; im
    // Pool bleibt jede Verzögerung weit unter einem einzigen Vergleich.
    expect(maxDelayMs).toBeLessThan(blockingMs / 2);
    expect(ticks).toBeGreaterThan(totalMs / 10 / 3);
  }, 60_000);
});
