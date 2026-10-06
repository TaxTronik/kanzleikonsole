// Fachkatalog: GWG-REVERIFICATION-VALIDITY-001
// =============================================================================
// K-01: Eskalationsstufen der Wiederholungsprüfung und Ausweis-Erinnerungs-
// fenster (vormals lokal im Worker-Job gwg-expiry-check). Das Zusammenspiel
// mit Empfängern, Statuswechsel und Audit prüft
// apps/worker/src/jobs/__tests__/gwg-expiry-check.test.ts.
// =============================================================================

import { describe, expect, it } from 'vitest';
import {
  GWG_EXPIRY_NOTIFICATION_KIND,
  gwgCheckDaysLeft,
  gwgExpiryStage1Cutoff,
  gwgExpiryStageForDaysLeft,
  gwgIdDocumentWarnCutoff,
  responsibleStaffForGwgExpiryStage,
} from '../expiry';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-09T10:00:00.000Z');

describe('Eskalationsstufen nach validUntil', () => {
  it.each([
    [91, null],
    [90, 'STAGE1'],
    [31, 'STAGE1'],
    [30, 'STAGE2'],
    [1, 'STAGE2'],
    [0, 'STAGE3'],
    [-5, 'STAGE3'],
  ] as const)('%i Tage vor Ablauf → %s', (daysLeft, stage) => {
    expect(gwgExpiryStageForDaysLeft(daysLeft)).toBe(stage);
  });

  it('rundet angebrochene Tage auf und wertet den Ablaufzeitpunkt selbst als abgelaufen', () => {
    expect(gwgCheckDaysLeft(new Date(NOW.getTime() + 30 * DAY), NOW)).toBe(30);
    expect(gwgCheckDaysLeft(new Date(NOW.getTime() + 30 * DAY + 1), NOW)).toBe(31);
    expect(gwgCheckDaysLeft(new Date(NOW.getTime() + 1), NOW)).toBe(1);
    expect(gwgCheckDaysLeft(NOW, NOW)).toBe(0);
    expect(gwgCheckDaysLeft(new Date(NOW.getTime() - 2 * DAY), NOW)).toBe(-2);
  });

  it('lädt Prüfungen bis 90 Tage und Ausweise bis 60 Tage vorab', () => {
    expect(gwgExpiryStage1Cutoff(NOW)).toEqual(new Date(NOW.getTime() + 90 * DAY));
    const berlinToday = new Date('2026-06-09T00:00:00.000Z');
    expect(gwgIdDocumentWarnCutoff(berlinToday)).toEqual(new Date('2026-08-08T00:00:00.000Z'));
  });

  it('ordnet jeder Stufe ihre Notification-Art zu', () => {
    expect(GWG_EXPIRY_NOTIFICATION_KIND).toEqual({
      STAGE1: 'GWG_EXPIRY_90D',
      STAGE2: 'GWG_EXPIRY_30D',
      STAGE3: 'GWG_EXPIRED',
    });
  });
});

describe('Zuständige je Stufe', () => {
  const responsibilities = [
    { staffId: 'berufstraeger-1', role: 'BERUFSTRAEGER' },
    { staffId: 'bearbeiter-1', role: 'HAUPTBEARBEITER' },
    { staffId: 'mitarbeiter-1', role: 'MITARBEITER' },
  ];

  it('informiert in Stufe 1 nur die Hauptbearbeitung', () => {
    expect(responsibleStaffForGwgExpiryStage('STAGE1', responsibilities)).toEqual(['bearbeiter-1']);
  });

  it('nimmt ab Stufe 2 die Berufsträger hinzu', () => {
    for (const stage of ['STAGE2', 'STAGE3'] as const) {
      expect(responsibleStaffForGwgExpiryStage(stage, responsibilities)).toEqual([
        'bearbeiter-1',
        'berufstraeger-1',
      ]);
    }
  });
});
