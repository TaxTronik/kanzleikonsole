// Fachkatalog: GWG-SELF-ONBOARDING-001
// Eine nie abgeschlossene Einladung gilt nach Ablauf als abgelaufen – auch wenn
// der Link danach nie mehr aufgerufen wurde und der gespeicherte Status daher
// noch „Versendet“ oder „In Bearbeitung“ lautet.
import { describe, expect, it } from 'vitest';
import { effectiveGwgInviteStatus, GWG_INVITE_STATUS_LABELS } from '../domain-labels';

const now = new Date('2026-10-22T12:00:00Z');

describe('GWG-SELF-ONBOARDING-001 wirksamer Einladungsstatus', () => {
  it('zeigt offene Einladungen nach Ablauf als abgelaufen', () => {
    for (const status of ['PENDING', 'STARTED']) {
      expect(effectiveGwgInviteStatus(status, '2026-10-22T11:59:59Z', now)).toBe('EXPIRED');
      expect(effectiveGwgInviteStatus(status, '2026-10-22T12:00:01Z', now)).toBe(status);
    }
    expect(GWG_INVITE_STATUS_LABELS[effectiveGwgInviteStatus('PENDING', '2026-10-01', now)]).toBe(
      'Abgelaufen',
    );
  });

  it('lässt abgeschlossene, zurückgezogene und abgelaufene Einladungen unverändert', () => {
    for (const status of ['SUBMITTED', 'CANCELLED', 'EXPIRED'])
      expect(effectiveGwgInviteStatus(status, '2026-10-01T00:00:00Z', now)).toBe(status);
  });
});
