import { describe, it, expect, vi } from 'vitest';

// Modul-Import zieht Queue/Redis/S3/Prisma/Mailer — mocken; getestet wird die
// pure Übergangs-Logik (Flatter-Schutz + Einmal-Alarm + Entwarnung).
vi.mock('bullmq', () => ({
  Worker: class {
    on() {
      return this;
    }
  },
}));
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: class {}, ListBucketsCommand: class {} }));
vi.mock('@taxtronik/config', () => ({
  env: {
    S3_ENDPOINT: 'http://seaweedfs:8333',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY: 'x',
    S3_SECRET_KEY: 'y',
    CLAMAV_HOST: 'clamav',
    CLAMAV_PORT: 3310,
    OPS_ALERT_EMAIL: 'ops@example.de',
  },
}));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../prisma-owner', () => ({ prismaOwner: {} }));
vi.mock('../../mailer', () => ({ sendOpsMail: vi.fn() }));
vi.mock('../../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { evaluateTransitions, FAIL_THRESHOLD, type HealthState } from '../health-alert';

const allOk = { postgres: true, redis: true, objectStore: true, clamav: true };

describe('evaluateTransitions', () => {
  it('alles ok, kein Vorzustand → keine Alarme', () => {
    const { next, alerts } = evaluateTransitions({}, allOk);
    expect(alerts).toEqual([]);
    expect(next.postgres).toEqual({ failures: 0, alerted: false });
  });

  it('erster Fehllauf → noch KEIN Alarm (Flatter-Schutz)', () => {
    const { next, alerts } = evaluateTransitions({}, { ...allOk, clamav: false });
    expect(alerts).toEqual([]);
    expect(next.clamav).toEqual({ failures: 1, alerted: false });
  });

  it(`${FAIL_THRESHOLD}. Fehllauf in Folge → genau EIN Down-Alarm`, () => {
    const prev: HealthState = { clamav: { failures: FAIL_THRESHOLD - 1, alerted: false } };
    const { next, alerts } = evaluateTransitions(prev, { ...allOk, clamav: false });
    expect(alerts).toEqual([{ service: 'clamav', kind: 'down' }]);
    expect(next.clamav).toEqual({ failures: FAIL_THRESHOLD, alerted: true });
  });

  it('weiterer Fehllauf nach Alarm → KEIN erneuter Alarm (kein Mail-Sturm)', () => {
    const prev: HealthState = { clamav: { failures: 5, alerted: true } };
    const { alerts } = evaluateTransitions(prev, { ...allOk, clamav: false });
    expect(alerts).toEqual([]);
  });

  it('Erholung nach Alarm → genau EINE Entwarnung, Zähler zurückgesetzt', () => {
    const prev: HealthState = { redis: { failures: 7, alerted: true } };
    const { next, alerts } = evaluateTransitions(prev, allOk);
    expect(alerts).toEqual([{ service: 'redis', kind: 'up' }]);
    expect(next.redis).toEqual({ failures: 0, alerted: false });
  });

  it('Erholung OHNE vorherigen Alarm (1 Fehllauf) → stille Rücksetzung', () => {
    const prev: HealthState = { postgres: { failures: 1, alerted: false } };
    const { alerts } = evaluateTransitions(prev, allOk);
    expect(alerts).toEqual([]);
  });

  it('mehrere Dienste gleichzeitig down → je ein Alarm', () => {
    const prev: HealthState = {
      postgres: { failures: 1, alerted: false },
      clamav: { failures: 1, alerted: false },
    };
    const { alerts } = evaluateTransitions(prev, { ...allOk, postgres: false, clamav: false });
    expect(alerts).toHaveLength(2);
    expect(alerts.map((a) => a.kind)).toEqual(['down', 'down']);
  });
});
