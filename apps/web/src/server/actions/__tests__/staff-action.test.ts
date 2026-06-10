import { describe, it, expect } from 'vitest';
import { decideStaffGuard } from '../staff-action-policy';

// Sicherheits-Wahrheitstabelle des zentralen Staff-Gates — EINMAL geprüft statt
// in 162/63 handkopierten Stellen.
describe('decideStaffGuard', () => {
  it('keine Session → „Nicht eingeloggt."', () => {
    expect(decideStaffGuard({ hasUser: false, isAdmin: false, requireAdmin: false })).toBe('Nicht eingeloggt.');
    expect(decideStaffGuard({ hasUser: false, isAdmin: true, requireAdmin: true })).toBe('Nicht eingeloggt.');
  });

  it('eingeloggt, kein Admin nötig → erlaubt', () => {
    expect(decideStaffGuard({ hasUser: true, isAdmin: false, requireAdmin: false })).toBeNull();
  });

  it('Admin verlangt, aber kein Admin → „Nur ADMIN/PARTNER."', () => {
    expect(decideStaffGuard({ hasUser: true, isAdmin: false, requireAdmin: true })).toBe('Nur ADMIN/PARTNER.');
  });

  it('Admin verlangt und Admin → erlaubt', () => {
    expect(decideStaffGuard({ hasUser: true, isAdmin: true, requireAdmin: true })).toBeNull();
  });

  // iter87: Einzelrecht-Gate (hasPermission liefert der Caller via
  // hasStaffPermission — ADMIN/PARTNER-implizit ist dort schon eingerechnet).
  it('Einzelrecht verlangt, nicht vorhanden → Meldung mit Rechtename', () => {
    expect(
      decideStaffGuard({
        hasUser: true, isAdmin: false, requireAdmin: false,
        requiredPermission: 'INVOICE_SEND', hasPermission: false,
      }),
    ).toBe('Keine Berechtigung (INVOICE_SEND).');
  });

  it('Einzelrecht verlangt und vorhanden → erlaubt', () => {
    expect(
      decideStaffGuard({
        hasUser: true, isAdmin: false, requireAdmin: false,
        requiredPermission: 'INVOICE_MANAGE', hasPermission: true,
      }),
    ).toBeNull();
  });

  it('Einzelrecht schlägt auch bei Admin-Flag NICHT fehl (Implizit-Logik liegt beim Caller)', () => {
    // Kein-Session-Fall dominiert weiterhin alles.
    expect(
      decideStaffGuard({
        hasUser: false, isAdmin: true, requireAdmin: false,
        requiredPermission: 'ABSENCE_DECIDE', hasPermission: true,
      }),
    ).toBe('Nicht eingeloggt.');
  });
});
