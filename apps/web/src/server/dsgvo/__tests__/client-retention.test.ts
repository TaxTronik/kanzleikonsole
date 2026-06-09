import { describe, it, expect, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import {
  clientAnonymizationDeadline,
  isClientAnonymizationDue,
  findDueClientAnonymizations,
  CLIENT_ANONYMIZATION_YEARS,
  GOBD_RETENTION_YEARS,
} from '../client-retention';

describe('clientAnonymizationDeadline — Art. 17 (Jahresende + längste Frist)', () => {
  it('Mandatsende 2026-03-15 → fällig ab 2037-01-01', () => {
    expect(clientAnonymizationDeadline(new Date('2026-03-15T10:00:00Z')).toISOString()).toBe(
      '2037-01-01T00:00:00.000Z',
    );
  });

  it('Jahresanfang zählt zum Vorjahres-Schluss: 2026-01-01 → 2037-01-01', () => {
    // Frist beginnt mit Schluss des Kalenderjahres 2026, nicht ab dem Tag.
    expect(clientAnonymizationDeadline(new Date('2026-01-01T00:00:00Z')).toISOString()).toBe(
      '2037-01-01T00:00:00.000Z',
    );
  });

  it('Silvester 2026-12-31 → noch Kalenderjahr 2026 → 2037-01-01', () => {
    expect(clientAnonymizationDeadline(new Date('2026-12-31T23:59:00Z')).toISOString()).toBe(
      '2037-01-01T00:00:00.000Z',
    );
  });

  it('die längste Aufbewahrungsfrist gewinnt (GoBD 10 J. > GwG 5 J.)', () => {
    expect(GOBD_RETENTION_YEARS).toBe(10);
    expect(CLIENT_ANONYMIZATION_YEARS).toBe(10);
  });
});

describe('isClientAnonymizationDue', () => {
  const mandateEnd = new Date('2026-06-01T00:00:00Z'); // fällig ab 2037-01-01

  it('false ohne Mandatsende', () => {
    expect(isClientAnonymizationDue(null)).toBe(false);
    expect(isClientAnonymizationDue(undefined)).toBe(false);
  });

  it('false vor dem Stichtag (ein Tag davor)', () => {
    expect(isClientAnonymizationDue(mandateEnd, new Date('2036-12-31T23:59:59Z'))).toBe(false);
  });

  it('true am Stichtag', () => {
    expect(isClientAnonymizationDue(mandateEnd, new Date('2037-01-01T00:00:00Z'))).toBe(true);
  });

  it('true lange nach dem Stichtag', () => {
    expect(isClientAnonymizationDue(mandateEnd, new Date('2045-01-01T00:00:00Z'))).toBe(true);
  });
});

describe('findDueClientAnonymizations — Review-Queue (NATPERS, Fristablauf)', () => {
  const NOW = new Date('2037-06-01T00:00:00Z');

  function fakeTx(clients: unknown[]) {
    const findMany = vi.fn().mockResolvedValue(clients);
    return { tx: { client: { findMany } } as unknown as TxClient, findMany };
  }

  it('filtert auf NATPERS + nicht anonymisiert + Grobfilter, mappt Zähler', async () => {
    const mandateEnd = new Date('2026-06-01T00:00:00Z'); // fällig ab 2037-01-01
    const { tx, findMany } = fakeTx([
      {
        id: 'client-1',
        name: 'Max Mustermann',
        mandateEndedAt: mandateEnd,
        _count: { contacts: 2, documents: 1, gwgChecks: 1 },
      },
    ]);

    const out = await findDueClientAnonymizations(tx, NOW);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          kind: 'NATPERS',
          anonymizedAt: null,
          mandateEndedAt: { lt: new Date(Date.UTC(2027, 0, 1)) },
        },
      }),
    );
    expect(out).toEqual([
      {
        clientId: 'client-1',
        clientName: 'Max Mustermann',
        mandateEndedAt: mandateEnd,
        anonymizationDeadline: new Date('2037-01-01T00:00:00.000Z'),
        contacts: 2,
        openGwgItems: 2,
      },
    ]);
  });

  it('Mandat noch nicht fällig (exakte Jahresende-Rundung) → kein Item', async () => {
    // Grobfilter könnte den Client liefern; die exakte Prüfung verwirft ihn.
    const { tx } = fakeTx([
      {
        id: 'client-2',
        name: 'Erika Musterfrau',
        mandateEndedAt: new Date('2027-02-01T00:00:00Z'), // fällig erst ab 2038-01-01
        _count: { contacts: 0, documents: 0, gwgChecks: 0 },
      },
    ]);

    expect(await findDueClientAnonymizations(tx, NOW)).toEqual([]);
  });
});
