// Fachkatalog: GWG-RETENTION-DESTRUCTION-001
// =============================================================================
// K-01: Review-Queue der GwG-Löschprüfung im Paket (vormals Web:
// server/gwg/retention.ts, das jetzt hierher re-exportiert). Die ausführlichen
// Fristfälle prüft weiterhin apps/web/src/server/gwg/__tests__/retention.test.ts
// über den Web-Adapter; die Gleichheit mit den Datenbankfiltern prüft
// packages/db/src/__tests__/gwg-retention-count.test.ts gegen PostgreSQL.
// =============================================================================

import { describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import { dueGwgDeletionDocsWhere } from '../retention';
import {
  countDueGwgDeletionDocs,
  findDueGwgCheckDeletions,
  findDueGwgDeletionDocs,
} from '../review-queue';

function documentRow(client: {
  mandateEndedAt: Date | null;
  allowActive: boolean;
  onboardingCompletedAt: Date | null;
}) {
  return {
    id: 'doc-1',
    title: 'Ausweiskopie',
    clientId: 'client-1',
    createdAt: new Date('2020-05-01T00:00:00Z'),
    gwgDestructionRequestedAt: null,
    client: { name: 'Muster GmbH', ...client },
    gwgIdDocuments: [],
    gwgOnboardingInvite: null,
  };
}

describe('Review-Queue der GwG-Löschprüfung', () => {
  it('zählt mit demselben Filter wie der Worker', async () => {
    const count = vi.fn().mockResolvedValue(3);
    const now = new Date('2032-01-01T00:00:00Z');
    expect(await countDueGwgDeletionDocs({ document: { count } } as unknown as TxClient, now)).toBe(
      3,
    );
    expect(count).toHaveBeenCalledWith({ where: dueGwgDeletionDocsWhere(now) });
  });

  it('ordnet Belege nach Fristbeginn ein und überspringt eine laufende Beziehung', async () => {
    const findMany = vi.fn().mockResolvedValue([
      documentRow({
        mandateEndedAt: new Date('2025-06-30T00:00:00Z'),
        allowActive: true,
        onboardingCompletedAt: new Date('2020-05-02T00:00:00Z'),
      }),
      {
        ...documentRow({ mandateEndedAt: null, allowActive: true, onboardingCompletedAt: null }),
        id: 'doc-active',
      },
    ]);
    const tx = { document: { findMany } } as unknown as TxClient;

    expect(await findDueGwgDeletionDocs(tx, new Date('2030-12-31T23:59:59Z'))).toEqual([]);
    expect(await findDueGwgDeletionDocs(tx, new Date('2031-01-01T00:00:00Z'))).toEqual([
      expect.objectContaining({
        documentId: 'doc-1',
        retentionReason: 'MANDATE_ENDED',
        retentionStartedAt: new Date('2025-06-30T00:00:00Z'),
        deletionDeadline: new Date('2031-01-01T00:00:00Z'),
      }),
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { classification: 'GWG_EVIDENCE', deletedAt: null } }),
    );
  });

  it('liefert eine nie zustande gekommene Prüfung mit ihren offenen Belegen', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'check-1',
        clientId: 'client-1',
        status: 'REJECTED',
        createdAt: new Date('2026-03-01T00:00:00Z'),
        updatedAt: new Date('2026-03-15T00:00:00Z'),
        verifiedAt: null,
        client: {
          name: 'Abgelehnt GmbH',
          mandateEndedAt: null,
          allowActive: false,
          onboardingCompletedAt: null,
        },
        idDocuments: [
          {
            createdAt: new Date('2026-03-10T00:00:00Z'),
            document: { id: 'doc-1', classification: 'GWG_EVIDENCE', gwgDestroyedAt: null },
          },
        ],
        beneficialOwners: [],
        onboardingInvites: [],
      },
    ]);

    expect(
      await findDueGwgCheckDeletions(
        { gwgCheck: { findMany } } as unknown as TxClient,
        new Date('2037-02-01T00:00:00Z'),
      ),
    ).toEqual([
      {
        checkId: 'check-1',
        clientId: 'client-1',
        clientName: 'Abgelehnt GmbH',
        status: 'REJECTED',
        retentionStartedAt: new Date('2026-03-15T00:00:00Z'),
        retentionReason: 'MAXIMUM_RETENTION',
        deletionDeadline: new Date('2037-01-01T00:00:00Z'),
        openEvidenceDocs: 1,
      },
    ]);
  });
});
