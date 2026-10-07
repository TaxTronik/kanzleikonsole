// =============================================================================
// Begrenzter Worker-Thread-Pool für Staff-Passwortvergleiche
//
// Fachkatalog: ACCESS-TENANT-RLS-001
//
// Seit S-09 kostet jeder Staff-Passwortversuch genau einen bcryptjs-Vergleich
// mit Kosten 12 (~350 ms CPU) – auch für unbekannte oder nicht zulässige
// Konten (Dummy-Hash). Im Haupt-Thread hätte ein Angreifer damit bereits mit
// dem globalen Storm-Limit (10 Versuche/s ohne vertrauenswürdige Client-IP)
// die Event-Loop des Web-Prozesses ausgelastet. Die Vergleiche laufen deshalb
// in einem kleinen Pool aus worker_threads; bcryptjs ist reines JavaScript und
// wird im Worker unverändert verwendet (gleiches Hashformat, gleiche Kosten,
// identische Ergebnisse).
//
// - Größe: aus os.availableParallelism() abgeleitet (ab drei Kernen bleibt
//   einer der Event-Loop), mindestens 2 und höchstens 4 Threads.
// - Warteschlange: höchstens 32 wartende Vergleiche. Ist sie voll, wird der
//   Versuch sofort mit PasswordHashPoolSaturatedError abgewiesen (der Aufrufer
//   antwortet generisch) und eine gedrosselte Warnung geloggt. Unter Sättigung
//   ist der Timing-Seitenkanal von S-09 ohnehin wertlos: die Antwortzeit hängt
//   dann von der Last ab, nicht vom Konto, und jede Anfrage – gleich welches
//   Konto – wird gleich behandelt.
// - Fällt ein Thread aus, scheitert nur sein laufender Vergleich
//   (PasswordHashPoolUnavailableError) und ein neuer Thread wird gestartet.
//   Scheitern drei Threads nacheinander, ohne einen Vergleich abzuschließen
//   (z. B. bcryptjs nicht ladbar), lehnt der Pool 30 Sekunden lang alle
//   Vergleiche ab, statt im Takt neue Threads zu starten (fail-closed).
// - Backup-Codes des zweiten Faktors (S-09) prüft derselbe Pool: compareEach
//   vergleicht einen Code mit allen gespeicherten Hashes (bis zu acht), nimmt
//   diese Vergleiche gemeinsam oder gar nicht an und liefert erst nach dem
//   letzten ein Ergebnis — ohne Abbruch beim ersten Treffer.
// =============================================================================

import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { log } from '@/server/logger';

export const PASSWORD_HASH_POOL_MAX_SIZE = 4;
export const PASSWORD_HASH_POOL_MAX_QUEUE = 32;
const SATURATION_LOG_INTERVAL_MS = 60_000;
const MAX_CONSECUTIVE_WORKER_FAILURES = 3;
const BROKEN_POOL_COOLDOWN_MS = 30_000;

// Fest vorgegebenes Programm; Passwort und Hash sind ausschließlich Daten.
// bcryptjs lädt der Thread selbst als echtes Node-Modul: zuerst den
// ESM-Einstieg relativ zum Arbeitsverzeichnis (so liegt er im
// Standalone-Paket, next.config: serverExternalPackages; geprüft durch
// scripts/verify-standalone-trace.mjs), ersatzweise den CommonJS-Build ab
// apps/web eines Repository-Checkouts. Ein require.resolve im Hauptprozess
// würde Turbopack durch eine Bundle-Modul-ID ersetzen.
const PASSWORD_HASH_WORKER = `
'use strict';
const { createRequire } = require('node:module');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
async function loadBcrypt() {
  if (workerData.bcryptPath) return require(workerData.bcryptPath);
  try {
    const imported = await import('bcryptjs');
    return imported.default ?? imported;
  } catch (importError) {
    for (const base of workerData.resolutionBases) {
      try {
        return createRequire(path.join(base, 'password-hash-worker.js'))('bcryptjs');
      } catch {
        // nächstes Ausgangsverzeichnis
      }
    }
    throw importError;
  }
}
const ready = loadBcrypt();
// Nicht ladbar: Thread beenden, der Pool zählt den Startfehler.
ready.catch((error) => setImmediate(() => { throw error; }));
parentPort.on('message', (task) => {
  ready.then((bcrypt) => {
    let reply;
    try {
      reply = { id: task.id, matches: bcrypt.compareSync(task.password, task.hash) === true };
    } catch (error) {
      reply = { id: task.id, error: error instanceof Error ? error.message : String(error) };
    }
    parentPort.postMessage(reply);
  }, () => undefined);
});
`;

/** Warteschlange voll: der Versuch wurde nicht geprüft. */
export class PasswordHashPoolSaturatedError extends Error {
  constructor() {
    super('Die Passwortprüfung ist ausgelastet.');
    this.name = 'PasswordHashPoolSaturatedError';
  }
}

/** Thread ausgefallen, Pool gestört oder geschlossen: der Versuch wurde nicht geprüft. */
export class PasswordHashPoolUnavailableError extends Error {
  constructor(
    message = 'Die Passwortprüfung ist derzeit nicht verfügbar.',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PasswordHashPoolUnavailableError';
  }
}

/** Kerne minus einer für die Event-Loop, mindestens 2, höchstens 4 Threads. */
export function defaultPasswordHashPoolSize(
  parallelism: number = os.availableParallelism(),
): number {
  return Math.min(PASSWORD_HASH_POOL_MAX_SIZE, Math.max(2, parallelism - 1));
}

export type PasswordHashPoolOptions = {
  size?: number;
  maxQueue?: number;
  /** Absoluter Pfad eines CommonJS-Builds von bcryptjs (Tests); Standard: Auflösung ab Arbeitsverzeichnis. */
  bcryptPath?: string;
  /** Testhaken: jeder gestartete Thread. */
  onWorkerStart?: (worker: Worker) => void;
};

export type PasswordHashPoolStats = {
  size: number;
  maxQueue: number;
  workers: number;
  active: number;
  queued: number;
};

type CompareTask = {
  id: number;
  password: string;
  hash: string;
  resolve: (matches: boolean) => void;
  reject: (error: Error) => void;
};

type WorkerSlot = {
  worker: Worker;
  task: CompareTask | null;
  completed: number;
  lastError: Error | null;
};

type WorkerReply = { id: number; matches?: boolean; error?: string };

/**
 * Ersatz-Ausgangsverzeichnisse der Modulauflösung im Thread, falls der
 * ESM-Import ab dem Arbeitsverzeichnis scheitert (z. B. Start ab der
 * Repository-Wurzel).
 */
function resolutionBases(): string[] {
  const cwd = process.cwd();
  return [...new Set([cwd, path.join(cwd, 'apps/web')])];
}

export class PasswordHashPool {
  readonly size: number;
  readonly maxQueue: number;
  private readonly bcryptPath: string | undefined;
  private readonly onWorkerStart: ((worker: Worker) => void) | undefined;
  private readonly slots = new Set<WorkerSlot>();
  private readonly queue: CompareTask[] = [];
  private nextTaskId = 1;
  private closed = false;
  private consecutiveWorkerFailures = 0;
  private unavailableUntil = 0;
  private saturation = { rejected: 0, loggedAt: Number.NEGATIVE_INFINITY };

  constructor(options: PasswordHashPoolOptions = {}) {
    this.size = Math.max(1, Math.floor(options.size ?? defaultPasswordHashPoolSize()));
    this.maxQueue = Math.max(0, Math.floor(options.maxQueue ?? PASSWORD_HASH_POOL_MAX_QUEUE));
    this.bcryptPath = options.bcryptPath;
    this.onWorkerStart = options.onWorkerStart;
  }

  /** Genau ein bcrypt-Vergleich in einem Pool-Thread; Ergebnis wie bcryptjs.compare. */
  compare(password: string, hash: string): Promise<boolean> {
    const refusal = this.admissionRefusal(1);
    if (refusal) return Promise.reject(refusal);
    return this.enqueue(password, hash);
  }

  /**
   * Je ein Vergleich von `password` mit jedem Hash (Backup-Codes, S-09). Alle
   * Vergleiche werden gemeinsam angenommen oder keiner: Reichen freie Threads
   * und Warteschlange nicht für alle, wird wie bei compare sofort abgewiesen,
   * ohne einen Vergleich zu starten. Das Ergebnis liegt erst vor, wenn jeder
   * Vergleich beendet ist, auch nach einem Treffer oder einem Fehler: je Hash
   * in dessen Reihenfolge `fulfilled` (Treffer ja/nein) oder `rejected`.
   */
  compareEach(
    password: string,
    hashes: readonly string[],
  ): Promise<PromiseSettledResult<boolean>[]> {
    if (hashes.length === 0) return Promise.resolve([]);
    const refusal = this.admissionRefusal(hashes.length);
    if (refusal) return Promise.reject(refusal);
    return Promise.allSettled(hashes.map((hash) => this.enqueue(password, hash)));
  }

  stats(): PasswordHashPoolStats {
    let active = 0;
    for (const slot of this.slots) if (slot.task) active += 1;
    return {
      size: this.size,
      maxQueue: this.maxQueue,
      workers: this.slots.size,
      active,
      queued: this.queue.length,
    };
  }

  /** Beendet alle Threads; offene Vergleiche scheitern mit PasswordHashPoolUnavailableError. */
  async close(): Promise<void> {
    this.closed = true;
    this.rejectQueued(new PasswordHashPoolUnavailableError('Die Passwortprüfung wurde beendet.'));
    await Promise.all([...this.slots].map((slot) => slot.worker.terminate()));
  }

  /** null, wenn `count` Vergleiche jetzt angenommen werden können, sonst der Ablehnungsgrund. */
  private admissionRefusal(count: number): Error | null {
    if (this.closed) {
      return new PasswordHashPoolUnavailableError('Die Passwortprüfung wurde beendet.');
    }
    if (Date.now() < this.unavailableUntil) return new PasswordHashPoolUnavailableError();
    this.ensureWorkers();
    let idle = 0;
    for (const slot of this.slots) if (!slot.task) idle += 1;
    if (count > idle + this.maxQueue - this.queue.length) {
      this.noteSaturation();
      return new PasswordHashPoolSaturatedError();
    }
    return null;
  }

  private enqueue(password: string, hash: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const task: CompareTask = { id: this.nextTaskId++, password, hash, resolve, reject };
      const idle = this.idleSlot();
      if (idle) this.dispatch(idle, task);
      else this.queue.push(task);
    });
  }

  private ensureWorkers(): void {
    while (this.slots.size < this.size) this.startWorker();
  }

  private startWorker(): void {
    const worker = new Worker(PASSWORD_HASH_WORKER, {
      eval: true,
      workerData: { bcryptPath: this.bcryptPath, resolutionBases: resolutionBases() },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
    });
    const slot: WorkerSlot = { worker, task: null, completed: 0, lastError: null };
    // Leerlaufende Threads halten den Prozess nicht am Leben.
    worker.unref();
    worker.on('message', (reply: WorkerReply) => this.onReply(slot, reply));
    worker.on('error', (error: Error) => {
      slot.lastError = error;
    });
    worker.on('exit', (code: number) => this.onExit(slot, code));
    this.slots.add(slot);
    this.onWorkerStart?.(worker);
  }

  private idleSlot(): WorkerSlot | undefined {
    for (const slot of this.slots) if (!slot.task) return slot;
    return undefined;
  }

  private dispatch(slot: WorkerSlot, task: CompareTask): void {
    slot.task = task;
    slot.worker.ref();
    slot.worker.postMessage({ id: task.id, password: task.password, hash: task.hash });
  }

  private onReply(slot: WorkerSlot, reply: WorkerReply): void {
    const task = slot.task;
    if (!task || reply?.id !== task.id) return;
    slot.task = null;
    slot.completed += 1;
    this.consecutiveWorkerFailures = 0;
    slot.worker.unref();
    if (typeof reply.error === 'string') task.reject(new Error(reply.error));
    else task.resolve(reply.matches === true);
    const next = this.queue.shift();
    if (next) this.dispatch(slot, next);
  }

  private onExit(slot: WorkerSlot, code: number): void {
    this.slots.delete(slot);
    const task = slot.task;
    slot.task = null;
    if (this.closed) {
      task?.reject(new PasswordHashPoolUnavailableError('Die Passwortprüfung wurde beendet.'));
      return;
    }
    log.error(
      {
        component: 'password-hash-pool',
        exitCode: code,
        completed: slot.completed,
        err: slot.lastError?.message,
      },
      'Passwortprüf-Thread unerwartet beendet',
    );
    task?.reject(
      new PasswordHashPoolUnavailableError('Der Passwortprüf-Thread ist ausgefallen.', {
        cause: slot.lastError ?? undefined,
      }),
    );
    if (slot.completed === 0) this.consecutiveWorkerFailures += 1;
    if (this.consecutiveWorkerFailures >= MAX_CONSECUTIVE_WORKER_FAILURES) {
      // Kein Neustart im Takt: alle Threads scheitern, bevor sie arbeiten.
      this.consecutiveWorkerFailures = 0;
      this.unavailableUntil = Date.now() + BROKEN_POOL_COOLDOWN_MS;
      log.error(
        { component: 'password-hash-pool', cooldownMs: BROKEN_POOL_COOLDOWN_MS },
        'Passwortprüfung gestört – Anmeldeversuche werden vorübergehend abgewiesen',
      );
      this.rejectQueued(new PasswordHashPoolUnavailableError());
      return;
    }
    if (this.queue.length > 0) {
      this.startWorker();
      const idle = this.idleSlot();
      const next = idle ? this.queue.shift() : undefined;
      if (idle && next) this.dispatch(idle, next);
    }
  }

  private rejectQueued(error: Error): void {
    for (const task of this.queue.splice(0)) task.reject(error);
  }

  private noteSaturation(): void {
    this.saturation.rejected += 1;
    const now = Date.now();
    if (now - this.saturation.loggedAt < SATURATION_LOG_INTERVAL_MS) return;
    log.warn(
      {
        component: 'password-hash-pool',
        rejected: this.saturation.rejected,
        size: this.size,
        maxQueue: this.maxQueue,
      },
      'Passwortprüfung ausgelastet – Anmeldeversuche werden ohne Prüfung generisch abgewiesen',
    );
    this.saturation = { rejected: 0, loggedAt: now };
  }
}

let sharedPool: PasswordHashPool | null = null;

/** Prozessweiter Pool (beim ersten Vergleich gestartet). */
export function comparePasswordHash(password: string, hash: string): Promise<boolean> {
  sharedPool ??= new PasswordHashPool();
  return sharedPool.compare(password, hash);
}

/** Prozessweiter Pool: je ein Vergleich mit jedem Hash, alle vollständig (compareEach). */
export function comparePasswordHashes(
  password: string,
  hashes: readonly string[],
): Promise<PromiseSettledResult<boolean>[]> {
  if (hashes.length === 0) return Promise.resolve([]);
  sharedPool ??= new PasswordHashPool();
  return sharedPool.compareEach(password, hashes);
}
