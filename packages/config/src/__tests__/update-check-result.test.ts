// Fachkatalog: ASSURANCE-RELEASE-EVIDENCE-001
// P-21: Die Admin-Übersicht wertet das gespeicherte Worker-Ergebnis gegen die
// installierte Version aus, samt Alter.
import { describe, expect, it } from 'vitest';
import {
  evaluateStoredUpdateCheck,
  toPersistedUpdateCheck,
  UPDATE_CHECK_STALE_AFTER_MS,
} from '../update-manifest';

const CHECKED = new Date('2026-10-05T06:00:00.000Z');
const stored = {
  checkedAt: CHECKED.toISOString(),
  ok: true,
  channel: 'stable',
  versions: [
    { version: '1.5.0', releasedAt: '2026-09-01T00:00:00Z', migrationsRequired: true },
    { version: '1.4.0', releasedAt: '2026-06-10T12:00:00Z', migrationsRequired: false },
  ],
};

describe('evaluateStoredUpdateCheck', () => {
  it('zählt neuere Versionen relativ zur installierten Version', () => {
    expect(evaluateStoredUpdateCheck(stored, '1.3.9', CHECKED)).toMatchObject({
      ok: true,
      hasUpdate: true,
      newerCount: 2,
      stale: false,
      checkedAt: CHECKED,
    });
    expect(evaluateStoredUpdateCheck(stored, '1.5.0', CHECKED)).toMatchObject({
      hasUpdate: false,
      newerCount: 0,
    });
  });

  it('meldet fehlende, defekte und veraltete Ergebnisse ehrlich', () => {
    expect(evaluateStoredUpdateCheck(undefined, '1.0.0')).toMatchObject({
      checkedAt: null,
      ok: false,
      hasUpdate: false,
    });
    expect(evaluateStoredUpdateCheck({ checkedAt: 'kaputt' }, '1.0.0').checkedAt).toBeNull();
    const later = new Date(CHECKED.getTime() + UPDATE_CHECK_STALE_AFTER_MS + 1);
    expect(evaluateStoredUpdateCheck(stored, '1.3.9', later).stale).toBe(true);
    expect(
      evaluateStoredUpdateCheck({ ...stored, ok: false, error: 'HTTP 503' }, '1.3.9', CHECKED),
    ).toMatchObject({ ok: false, hasUpdate: false, error: 'HTTP 503' });
  });

  it('ignoriert ungültige Versionseinträge', () => {
    const value = { ...stored, versions: [{ version: '2.0' }, { version: 'x' }, null] };
    expect(evaluateStoredUpdateCheck(value, '1.0.0', CHECKED).newerCount).toBe(0);
  });
});

describe('toPersistedUpdateCheck', () => {
  it('übernimmt Warnung und Fehler ohne Manifest', () => {
    expect(
      toPersistedUpdateCheck(
        { ok: false, warning: 'UPDATE_MANIFEST_URL nicht konfiguriert.' },
        CHECKED,
      ),
    ).toEqual({
      checkedAt: CHECKED.toISOString(),
      ok: false,
      warning: 'UPDATE_MANIFEST_URL nicht konfiguriert.',
    });
  });
});
