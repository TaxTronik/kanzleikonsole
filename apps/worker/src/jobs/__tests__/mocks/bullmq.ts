// =============================================================================
// bullmq-Mock für die Worker-Job-Tests.
//
// Eingebunden per `vi.mock('bullmq', () => import('./mocks/bullmq'))` — fängt
// beim Modul-Load des Jobs die Processor-Funktion + Event-Handler des Workers
// ab und zeichnet Queue.add/close auf. Kein Redis nötig: die Tests holen sich
// den Processor über `processors.get('<queue-name>')` und rufen ihn mit einem
// Fake-Job direkt auf.
//
// Der direkte Import dieses Moduls im Test liefert DIESELBE Modul-Instanz wie
// die vi.mock-Factory (gleicher aufgelöster Pfad) — die Maps sind also geteilt.
// =============================================================================

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FakeJob<T = any> {
  data: T;
  id?: string;
  attemptsMade?: number;
  opts?: { attempts?: number };
}

export type Processor = (job: FakeJob) => Promise<any>;
export type EventHandler = (...args: any[]) => unknown;

export const processors = new Map<string, Processor>();
export const workerEvents = new Map<string, Map<string, EventHandler>>();

export class Worker {
  constructor(
    public name: string,
    processor: Processor,
    _opts?: unknown,
  ) {
    processors.set(name, processor);
    if (!workerEvents.has(name)) workerEvents.set(name, new Map());
  }

  on(event: string, handler: EventHandler): this {
    workerEvents.get(this.name)?.set(event, handler);
    return this;
  }
}

export interface QueueAddCall {
  queue: string;
  jobName: string;
  data: any;
  opts: any;
}

export const queueAdds: QueueAddCall[] = [];
export const queueCloses: string[] = [];

export class Queue {
  constructor(
    public name: string,
    _opts?: unknown,
  ) {}

  async add(jobName: string, data: any, opts?: any): Promise<void> {
    queueAdds.push({ queue: this.name, jobName, data, opts });
  }

  async close(): Promise<void> {
    queueCloses.push(this.name);
  }
}

/** Setzt die aufgezeichneten Queue-Aufrufe zurück (beforeEach der Tests). */
export function resetQueueRecords(): void {
  queueAdds.length = 0;
  queueCloses.length = 0;
}
