// =============================================================================
// Property-Based Tests für das zentrale Staff-Action-Gate (decideStaffGuard).
//
// Diese Funktion ist die EINZIGE Stelle, an der Admin/Permission-Checks
// stattfinden (statt 162×/63× verstreut). Wenn hier ein Fehler durchrutscht,
// ist die gesamte RBAC-Architektur kompromittiert.
//
// Wichtig: decideStaffGuard ist eine REINE Funktion — sie weiß nicht, dass
// Admins implizit alle Permissions haben. Der Caller (staffActionGuard)
// berechnet hasPermission via hasStaffPermission(session, perm), das für
// Admins true zurückgibt. Die Properties hier testen die reine Funktion.
// =============================================================================

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { decideStaffGuard } from '../staff-action-policy';

const guardInputArb = fc.record({
  hasUser: fc.boolean(),
  isAdmin: fc.boolean(),
  requireAdmin: fc.boolean(),
  requiredPermission: fc.oneof(fc.constant(null), fc.string({ minLength: 1, maxLength: 50 })),
  hasPermission: fc.boolean(),
});

describe('decideStaffGuard — Property-Based', () => {
  // G1: Ohne Session → IMMER abgelehnt ("Nicht eingeloggt.").
  it('ohne Session → immer abgelehnt', () => {
    fc.assert(
      fc.property(guardInputArb, (input) => {
        fc.pre(!input.hasUser);
        const result = decideStaffGuard(input);
        expect(result).not.toBeNull();
        expect(result).toContain('eingeloggt');
      }),
    );
  });

  // G2: Admin mit hasPermission → immer erlaubt. Wenn requiredPermission null
  // ist, ist hasPermission irrelevant. Der Admin-Bypass für Permissions
  // passiert im Caller (hasStaffPermission), nicht hier.
  it('Admin mit Permission → immer erlaubt (null)', () => {
    fc.assert(
      fc.property(guardInputArb, (input) => {
        fc.pre(
          input.hasUser &&
            input.isAdmin &&
            (input.requiredPermission === null || input.hasPermission),
        );
        expect(decideStaffGuard(input)).toBeNull();
      }),
    );
  });

  // G3: requireAdmin=true ohne Admin → IMMER abgelehnt.
  it('requireAdmin ohne Admin → abgelehnt', () => {
    fc.assert(
      fc.property(guardInputArb, (input) => {
        fc.pre(input.hasUser && input.requireAdmin && !input.isAdmin);
        const result = decideStaffGuard(input);
        expect(result).not.toBeNull();
        expect(result).toContain('ADMIN');
      }),
    );
  });

  // G4: requiredPermission ohne Berechtigung (und ohne Admin) → abgelehnt.
  it('requiredPermission ohne hasPermission → abgelehnt', () => {
    fc.assert(
      fc.property(guardInputArb, (input) => {
        fc.pre(
          input.hasUser &&
            !input.isAdmin &&
            !input.requireAdmin &&
            input.requiredPermission !== null &&
            !input.hasPermission,
        );
        const result = decideStaffGuard(input);
        expect(result).not.toBeNull();
        expect(result).toContain('Berechtigung');
      }),
    );
  });

  // G5: Vollständige Wahrheitstabelle — die exakte Spezifikation der Funktion.
  it('Wahrheitstabelle: allowed ⟺ hasUser && (!requireAdmin || isAdmin) && (!requiredPermission || hasPermission)', () => {
    fc.assert(
      fc.property(guardInputArb, (input) => {
        const result = decideStaffGuard(input);
        const expectedAllowed =
          input.hasUser &&
          (!input.requireAdmin || input.isAdmin) &&
          (input.requiredPermission === null || input.hasPermission);
        expect(result === null).toBe(expectedAllowed);
      }),
    );
  });
});
