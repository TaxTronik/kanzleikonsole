import { describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import {
  findDueGwgCheckDeletions,
  gwgDeletionDeadline,
  gwgDocumentEffectiveStart,
  gwgEffectiveStart,
  isGwgDeletionDue,
} from '../retention';

describe('GwG-Aufbewahrungsfrist', () => {
  it('läuft fünf Jahre ab Schluss des Kalenderjahres', () => {
    expect(gwgDeletionDeadline(new Date('2026-03-15T10:00:00Z')).toISOString()).toBe(
      '2032-01-01T00:00:00.000Z',
    );
    expect(
      isGwgDeletionDue(new Date('2026-03-15T10:00:00Z'), new Date('2031-12-31T23:59:59Z')),
    ).toBe(false);
    expect(
      isGwgDeletionDue(new Date('2026-03-15T10:00:00Z'), new Date('2032-01-01T00:00:00Z')),
    ).toBe(true);
  });

  it('startet bei REJECTED bzw. nie verifiziertem EXPIRED ohne Mandat ab Feststellung', () => {
    const createdAt = new Date('2026-03-15T10:00:00Z');
    expect(gwgEffectiveStart(null, 'REJECTED', createdAt)).toEqual(createdAt);
    expect(gwgEffectiveStart(null, 'EXPIRED', createdAt, null)).toEqual(createdAt);
  });

  it('behandelt einen zuvor VERIFIED abgelaufenen Check der laufenden Beziehung nicht als Löschgrund', () => {
    expect(
      gwgEffectiveStart(
        null,
        'EXPIRED',
        new Date('2020-01-01T00:00:00Z'),
        new Date('2020-01-02T00:00:00Z'),
      ),
    ).toBeNull();
  });

  it('verwendet bei später Datenerfassung den Terminal-/Updatezeitpunkt statt der Check-Anlage', () => {
    const terminalAt = new Date('2025-08-01T00:00:00Z');
    const start = gwgEffectiveStart(null, 'REJECTED', terminalAt, null);
    expect(start).toEqual(terminalAt);
    if (!start) throw new Error('Terminaler Check muss einen Fristbeginn liefern.');
    expect(isGwgDeletionDue(start, new Date('2026-01-01T00:00:00Z'))).toBe(false);
    expect(gwgDeletionDeadline(start)).toEqual(new Date('2031-01-01T00:00:00Z'));
  });
});

describe('gwgDocumentEffectiveStart', () => {
  const createdAt = new Date('2026-05-01T00:00:00Z');
  const expiresAt = new Date('2026-05-31T00:00:00Z');

  it.each([
    ['CANCELLED', new Date('2026-05-10T00:00:00Z')],
    ['EXPIRED', null],
    ['PENDING', null],
    ['STARTED', null],
  ])('erfasst abgebrochenes/abgelaufenes Onboarding (%s)', (status, cancelledAt) => {
    expect(
      gwgDocumentEffectiveStart(
        {
          createdAt,
          mandateEndedAt: null,
          linkedChecks: [],
          invite: { status, expiresAt, cancelledAt, gwgCheck: null },
        },
        new Date('2026-06-01T00:00:00Z'),
      ),
    ).toEqual(createdAt);
  });

  it('erfasst SUBMITTED mit abgelehntem Check', () => {
    expect(
      gwgDocumentEffectiveStart({
        createdAt,
        mandateEndedAt: null,
        linkedChecks: [],
        invite: {
          status: 'SUBMITTED',
          expiresAt,
          cancelledAt: null,
          gwgCheck: { status: 'REJECTED', createdAt, verifiedAt: null },
        },
      }),
    ).toEqual(createdAt);
  });

  it('erfasst einen manuell verknüpften abgelehnten Check ohne Invite', () => {
    expect(
      gwgDocumentEffectiveStart({
        createdAt,
        mandateEndedAt: null,
        linkedChecks: [{ status: 'REJECTED', createdAt, verifiedAt: null }],
        invite: null,
      }),
    ).toEqual(createdAt);
  });

  it('löscht einen wiederverwendeten Beleg nicht wegen eines älteren abgelehnten Checks', () => {
    expect(
      gwgDocumentEffectiveStart({
        createdAt,
        mandateEndedAt: null,
        linkedChecks: [
          { status: 'REJECTED', createdAt, verifiedAt: null },
          { status: 'IN_REVIEW', createdAt: new Date('2027-01-01T00:00:00Z'), verifiedAt: null },
        ],
        invite: null,
      }),
    ).toBeNull();
  });
});

describe('findDueGwgCheckDeletions', () => {
  it('liefert terminalen Check ohne Mandat und zählt nur seine eigenen offenen Belege', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'check-1',
        clientId: 'client-1',
        status: 'REJECTED',
        updatedAt: new Date('2026-03-15T00:00:00Z'),
        verifiedAt: null,
        client: { name: 'Abgelehnt GmbH', mandateEndedAt: null },
        idDocuments: [
          {
            createdAt: new Date('2026-03-10T00:00:00Z'),
            document: { id: 'doc-1', classification: 'GWG_EVIDENCE', gwgDestroyedAt: null },
          },
          {
            createdAt: new Date('2026-03-11T00:00:00Z'),
            document: {
              id: 'doc-deleted',
              classification: 'GWG_EVIDENCE',
              gwgDestroyedAt: new Date(),
            },
          },
        ],
        beneficialOwners: [{ createdAt: new Date('2026-03-12T00:00:00Z') }],
        onboardingInvites: [
          {
            uploadedDocuments: [
              { id: 'doc-1', classification: 'GWG_EVIDENCE', gwgDestroyedAt: null },
              { id: 'doc-2', classification: 'GWG_EVIDENCE', gwgDestroyedAt: null },
            ],
          },
        ],
      },
    ]);
    const tx = { gwgCheck: { findMany } } as unknown as TxClient;

    expect(await findDueGwgCheckDeletions(tx, new Date('2032-06-01T00:00:00Z'))).toEqual([
      {
        checkId: 'check-1',
        clientId: 'client-1',
        clientName: 'Abgelehnt GmbH',
        status: 'REJECTED',
        retentionStartedAt: new Date('2026-03-15T00:00:00Z'),
        retentionReason: 'ONBOARDING_TERMINATED',
        deletionDeadline: new Date('2032-01-01T00:00:00Z'),
        openEvidenceDocs: 2,
      },
    ]);
  });

  it('startet die Frist nicht vor einer später hinzugefügten Kindaufzeichnung', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'check-recent-child',
        clientId: 'client-1',
        status: 'REJECTED',
        updatedAt: new Date('2020-01-01T00:00:00Z'),
        verifiedAt: null,
        client: { name: 'Späte Feststellung GmbH', mandateEndedAt: null },
        idDocuments: [{ createdAt: new Date('2025-08-01T00:00:00Z'), document: null }],
        beneficialOwners: [],
        onboardingInvites: [],
      },
    ]);
    const tx = { gwgCheck: { findMany } } as unknown as TxClient;

    expect(await findDueGwgCheckDeletions(tx, new Date('2026-06-01T00:00:00Z'))).toEqual([]);
  });
});
