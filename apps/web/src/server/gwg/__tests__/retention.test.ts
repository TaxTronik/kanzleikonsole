import { describe, it, expect, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import {
  gwgDeletionDeadline,
  isGwgDeletionDue,
  findDueGwgCheckDeletions,
  GWG_RETENTION_YEARS,
} from '../retention';

describe('gwgDeletionDeadline — § 8 Abs. 4 (Jahresende + 5 J.)', () => {
  it('Mandatsende 2026-03-15 → fällig ab 2032-01-01', () => {
    expect(gwgDeletionDeadline(new Date('2026-03-15T10:00:00Z')).toISOString()).toBe('2032-01-01T00:00:00.000Z');
  });

  it('Jahresanfang zählt zum Vorjahres-Schluss: 2026-01-01 → 2032-01-01', () => {
    // Frist beginnt mit Schluss des Kalenderjahres 2026, nicht ab dem Tag.
    expect(gwgDeletionDeadline(new Date('2026-01-01T00:00:00Z')).toISOString()).toBe('2032-01-01T00:00:00.000Z');
  });

  it('Silvester 2026-12-31 → noch Kalenderjahr 2026 → 2032-01-01', () => {
    expect(gwgDeletionDeadline(new Date('2026-12-31T23:59:00Z')).toISOString()).toBe('2032-01-01T00:00:00.000Z');
  });

  it('verwendet GWG_RETENTION_YEARS (5)', () => {
    expect(GWG_RETENTION_YEARS).toBe(5);
  });
});

describe('isGwgDeletionDue', () => {
  const mandateEnd = new Date('2026-06-01T00:00:00Z'); // fällig ab 2032-01-01

  it('false ohne Mandatsende', () => {
    expect(isGwgDeletionDue(null)).toBe(false);
    expect(isGwgDeletionDue(undefined)).toBe(false);
  });

  it('false vor dem Stichtag (ein Tag davor)', () => {
    expect(isGwgDeletionDue(mandateEnd, new Date('2031-12-31T23:59:59Z'))).toBe(false);
  });

  it('true am Stichtag', () => {
    expect(isGwgDeletionDue(mandateEnd, new Date('2032-01-01T00:00:00Z'))).toBe(true);
  });

  it('true lange nach dem Stichtag', () => {
    expect(isGwgDeletionDue(mandateEnd, new Date('2040-01-01T00:00:00Z'))).toBe(true);
  });
});

describe('findDueGwgCheckDeletions — § 8 Abs. 4 S. 4 (DB-Aufzeichnungen)', () => {
  const NOW = new Date('2032-06-01T00:00:00Z');

  function fakeTx(clients: unknown[]) {
    const findMany = vi.fn().mockResolvedValue(clients);
    return { tx: { client: { findMany } } as unknown as TxClient, findMany };
  }

  it('filtert auf nicht-vernichtete Checks fälliger Mandate (Grobfilter + exakte Frist)', async () => {
    const mandateEnd = new Date('2026-06-01T00:00:00Z'); // fällig ab 2032-01-01
    const { tx, findMany } = fakeTx([
      {
        id: 'client-1',
        name: 'Alt GmbH',
        mandateEndedAt: mandateEnd,
        gwgChecks: [{ id: 'chk-1', status: 'VERIFIED' }],
        _count: { documents: 2 },
      },
    ]);

    const out = await findDueGwgCheckDeletions(tx, NOW);

    const cutoff = new Date(Date.UTC(2027, 0, 1));
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          gwgChecks: { some: { destroyedAt: null } },
          OR: [
            { mandateEndedAt: { lt: cutoff } },
            {
              mandateEndedAt: null,
              gwgChecks: { some: { destroyedAt: null, status: { in: ['REJECTED', 'EXPIRED'] }, createdAt: { lt: cutoff } } },
            },
          ],
        },
      }),
    );
    expect(out).toEqual([
      {
        checkId: 'chk-1',
        clientId: 'client-1',
        clientName: 'Alt GmbH',
        status: 'VERIFIED',
        mandateEndedAt: mandateEnd,
        deletionDeadline: new Date('2032-01-01T00:00:00.000Z'),
        openEvidenceDocs: 2,
      },
    ]);
  });

  it('§ 8 Abs. 4 S. 2: abgelehntes Onboarding ohne Mandat → Frist ab Feststellung', async () => {
    // Kein mandateEndedAt, aber REJECTED-Check von 2026 → fällig ab 2032-01-01.
    const { tx } = fakeTx([
      {
        id: 'client-3',
        name: 'Abgelehnt GmbH',
        mandateEndedAt: null,
        gwgChecks: [{ id: 'chk-3', status: 'REJECTED', createdAt: new Date('2026-03-15T00:00:00Z') }],
        _count: { documents: 1 },
      },
    ]);
    const out = await findDueGwgCheckDeletions(tx, NOW);
    expect(out).toEqual([
      {
        checkId: 'chk-3',
        clientId: 'client-3',
        clientName: 'Abgelehnt GmbH',
        status: 'REJECTED',
        mandateEndedAt: new Date('2026-03-15T00:00:00Z'),
        deletionDeadline: new Date('2032-01-01T00:00:00.000Z'),
        openEvidenceDocs: 1,
      },
    ]);
  });

  it('offene (IN_REVIEW) Prüfung ohne Mandat → NICHT fällig (kann noch aktiv werden)', async () => {
    const { tx } = fakeTx([
      {
        id: 'client-4',
        name: 'Offen GmbH',
        mandateEndedAt: null,
        gwgChecks: [{ id: 'chk-4', status: 'IN_REVIEW', createdAt: new Date('2020-01-01T00:00:00Z') }],
        _count: { documents: 0 },
      },
    ]);
    expect(await findDueGwgCheckDeletions(tx, NOW)).toEqual([]);
  });

  it('Mandat noch nicht fällig (exakte Jahresende-Rundung) → kein Item', async () => {
    // Grobfilter könnte den Client liefern; die exakte Prüfung verwirft ihn.
    const { tx } = fakeTx([
      {
        id: 'client-2',
        name: 'Frisch GmbH',
        mandateEndedAt: new Date('2027-02-01T00:00:00Z'), // fällig erst ab 2033-01-01
        gwgChecks: [{ id: 'chk-2', status: 'EXPIRED' }],
        _count: { documents: 0 },
      },
    ]);

    expect(await findDueGwgCheckDeletions(tx, NOW)).toEqual([]);
  });
});
