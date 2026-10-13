// Fachkatalog: DSGVO-CONTACT-EXPORT-001
// Welle 15 (Folgepunkt P-11): Ein verlorener Job darf den Antrag nicht
// dauerhaft blockieren; ein laufender Auftrag darf nicht vorschnell ersetzt werden.
import { describe, expect, it } from 'vitest';
import { DSGVO_EXPORT_STALE_AFTER_MS, isDsgvoExportStale } from '../export-status';

const NOW = new Date('2026-10-12T12:00:00Z');
const before = (ms: number) => new Date(NOW.getTime() - ms);

describe('isDsgvoExportStale (Welle 15)', () => {
  it('wertet offene Aufträge erst nach Ablauf der Frist als hängengeblieben', () => {
    const limit = DSGVO_EXPORT_STALE_AFTER_MS;
    expect(
      isDsgvoExportStale({ status: 'REQUESTED', requestedAt: before(limit), startedAt: null }, NOW),
    ).toBe(false);
    expect(
      isDsgvoExportStale(
        { status: 'REQUESTED', requestedAt: before(limit + 1), startedAt: null },
        NOW,
      ),
    ).toBe(true);
    // RUNNING zählt ab der (letzten) Übernahme durch den Worker.
    expect(
      isDsgvoExportStale(
        { status: 'RUNNING', requestedAt: before(limit * 3), startedAt: before(60_000) },
        NOW,
      ),
    ).toBe(false);
    expect(
      isDsgvoExportStale(
        { status: 'RUNNING', requestedAt: before(limit * 3), startedAt: before(limit + 1) },
        NOW,
      ),
    ).toBe(true);
  });

  it.each(['DONE', 'FAILED'])(
    'wertet einen abgeschlossenen Auftrag (%s) nie als hängengeblieben',
    (status) => {
      expect(
        isDsgvoExportStale(
          { status, requestedAt: before(10 * DSGVO_EXPORT_STALE_AFTER_MS), startedAt: null },
          NOW,
        ),
      ).toBe(false);
    },
  );
});
