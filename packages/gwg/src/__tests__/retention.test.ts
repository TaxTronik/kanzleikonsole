// Fachkatalog: GWG-RETENTION-DESTRUCTION-001
// =============================================================================
// R-02/K-01: GwG-Löschfristen (§ 8 Abs. 4 GwG) als gemeinsame Prädikate für die
// Web-Review-Queue und den Worker-Job gwg-expiry-check (@taxtronik/gwg, vormals
// @taxtronik/tax). Die Gleichheit der Datenbankfilter mit der JS-Fristlogik
// prüft zusätzlich packages/db/src/__tests__/gwg-retention-count.test.ts gegen
// PostgreSQL.
// =============================================================================

import { describe, expect, it } from 'vitest';
import {
  dueGwgCheckDeletionsWhere,
  dueGwgDeletionDocsWhere,
  GWG_UNESTABLISHED_CHECK_STATUSES,
  gwgDeletionDeadline,
  gwgDeletionDueStartCutoff,
  gwgDocumentEffectiveStart,
  gwgEffectiveStart,
  gwgMaximumDeletionDeadline,
  isGwgDeletionDue,
  type GwgDocumentRetentionContext,
} from '../retention';

const UTC = (iso: string) => new Date(iso);

describe('Fristen nach § 8 Abs. 4 GwG', () => {
  it('beginnt mit dem Schluss des Kalenderjahres und endet regulär nach fünf Jahren', () => {
    expect(gwgDeletionDeadline(UTC('2026-03-15T10:00:00Z'))).toEqual(UTC('2032-01-01T00:00:00Z'));
    expect(gwgDeletionDeadline(UTC('2026-12-31T23:59:59Z'))).toEqual(UTC('2032-01-01T00:00:00Z'));
    expect(isGwgDeletionDue(UTC('2026-03-15T10:00:00Z'), UTC('2031-12-31T23:59:59Z'))).toBe(false);
    expect(isGwgDeletionDue(UTC('2026-03-15T10:00:00Z'), UTC('2032-01-01T00:00:00Z'))).toBe(true);
    expect(isGwgDeletionDue(null, UTC('2045-01-01T00:00:00Z'))).toBe(false);
  });

  it('setzt die absolute Höchstgrenze zehn Jahre nach demselben Fristbeginn', () => {
    expect(gwgMaximumDeletionDeadline(UTC('2026-03-15T10:00:00Z'))).toEqual(
      UTC('2037-01-01T00:00:00Z'),
    );
  });

  it('bildet „Frist abgelaufen" exakt als Vergleich mit dem Stichtags-Cutoff ab', () => {
    // gwgDeletionDeadline(start) <= now  ⇔  start < gwgDeletionDueStartCutoff(now)
    const starts = ['2019-12-31T23:59:59Z', '2020-01-01T00:00:00Z', '2020-07-01T00:00:00Z'];
    const nows = ['2025-12-31T23:59:59Z', '2026-01-01T00:00:00Z', '2026-06-30T12:00:00Z'];
    for (const start of starts.map(UTC)) {
      for (const now of nows.map(UTC)) {
        expect(gwgDeletionDeadline(start) <= now).toBe(start < gwgDeletionDueStartCutoff(now));
      }
    }
  });
});

describe('Fristbeginn einer GwG-Prüfung', () => {
  const recordedAt = UTC('2026-03-15T10:00:00Z');

  it('verwendet bei beendetem Mandat dessen Ende', () => {
    const ended = UTC('2027-02-01T00:00:00Z');
    expect(gwgEffectiveStart(ended, 'VERIFIED', recordedAt, recordedAt, true)).toEqual(ended);
  });

  it.each(GWG_UNESTABLISHED_CHECK_STATUSES)(
    'beginnt für eine nie zustande gekommene %s-Erstprüfung mit der Feststellung',
    (status) => {
      expect(gwgEffectiveStart(null, status, recordedAt, null, false)).toEqual(recordedAt);
    },
  );

  it('wartet bei zustande gekommener Beziehung oder verifizierter Prüfung auf das Ende', () => {
    expect(gwgEffectiveStart(null, 'DRAFT', recordedAt, null, true)).toBeNull();
    expect(gwgEffectiveStart(null, 'EXPIRED', recordedAt, recordedAt, false)).toBeNull();
    expect(gwgEffectiveStart(null, 'VERIFIED', recordedAt, null, false)).toBeNull();
  });
});

describe('Fristbeginn eines GwG-Dateibelegs', () => {
  const base: GwgDocumentRetentionContext = {
    createdAt: UTC('2026-03-15T10:00:00Z'),
    mandateEndedAt: null,
    relationshipEstablished: false,
    linkedChecks: [],
    invite: null,
  };
  const verifiedCheck = { status: 'VERIFIED', createdAt: base.createdAt, verifiedAt: null };

  it('beginnt ohne Beziehung und ohne verifizierte Prüfung mit der Erfassung', () => {
    expect(gwgDocumentEffectiveStart(base)).toEqual(base.createdAt);
  });

  it('wartet bei verifizierter verknüpfter Prüfung oder Einladung auf das Beziehungsende', () => {
    expect(gwgDocumentEffectiveStart({ ...base, linkedChecks: [verifiedCheck] })).toBeNull();
    expect(
      gwgDocumentEffectiveStart({
        ...base,
        invite: {
          status: 'SUBMITTED',
          expiresAt: base.createdAt,
          cancelledAt: null,
          gwgCheck: { status: 'EXPIRED', createdAt: base.createdAt, verifiedAt: base.createdAt },
        },
      }),
    ).toBeNull();
    expect(gwgDocumentEffectiveStart({ ...base, relationshipEstablished: true })).toBeNull();
  });

  it('verwendet bei beendetem Mandat dessen Ende, auch für verifizierte Belege', () => {
    const ended = UTC('2027-02-01T00:00:00Z');
    expect(
      gwgDocumentEffectiveStart({ ...base, mandateEndedAt: ended, linkedChecks: [verifiedCheck] }),
    ).toEqual(ended);
  });
});

describe('Datenbankfilter (Web-Kachel, Review-Queue, Worker-Benachrichtigung)', () => {
  const now = UTC('2032-06-01T08:00:00Z');
  const cutoff = UTC('2027-01-01T00:00:00Z');

  it('filtert Belege nach Mandatsende oder — ohne Beziehung — nach Erfassung', () => {
    expect(dueGwgDeletionDocsWhere(now)).toEqual({
      classification: 'GWG_EVIDENCE',
      deletedAt: null,
      OR: [
        { client: { is: { mandateEndedAt: { lt: cutoff } } } },
        {
          createdAt: { lt: cutoff },
          client: { is: { mandateEndedAt: null, allowActive: false, onboardingCompletedAt: null } },
          gwgIdDocuments: {
            none: {
              check: { is: { OR: [{ status: 'VERIFIED' }, { verifiedAt: { not: null } }] } },
            },
          },
          NOT: {
            gwgOnboardingInvite: {
              is: {
                gwgCheck: { is: { OR: [{ status: 'VERIFIED' }, { verifiedAt: { not: null } }] } },
              },
            },
          },
        },
      ],
    });
  });

  it('filtert Prüfungen ab der spätesten Feststellung (max(…) < Cutoff)', () => {
    expect(dueGwgCheckDeletionsWhere(now)).toEqual({
      destroyedAt: null,
      OR: [
        { client: { mandateEndedAt: { lt: cutoff } } },
        {
          client: { mandateEndedAt: null, allowActive: false, onboardingCompletedAt: null },
          verifiedAt: null,
          updatedAt: { lt: cutoff },
          idDocuments: { none: { createdAt: { gte: cutoff } } },
          beneficialOwners: { none: { createdAt: { gte: cutoff } } },
          onboardingInvites: { none: { updatedAt: { gte: cutoff } } },
          status: { in: ['DRAFT', 'IN_REVIEW', 'REJECTED', 'EXPIRED'] },
        },
      ],
    });
  });
});
