import { describe, it, expect } from 'vitest';
import { StaffPermissionName as PrismaPermission } from '@prisma/client';
import {
  STAFF_PERMISSIONS,
  STAFF_PERMISSION_VALUES,
  PERMISSION_LABELS,
} from '../staff-permissions';

// Drift-Guard: die zentrale TS-Quelle (lib/staff-permissions) MUSS exakt das
// DB-Enum StaffPermissionName spiegeln. Fügt jemand ein Recht in der Migration
// hinzu, ohne hier zu pflegen (oder umgekehrt), schlägt dieser Test an —
// statt eines stillen Laufzeit-Bugs in zod-Validierung/UI.
describe('staff-permissions ↔ Prisma-Enum', () => {
  it('deckt exakt die DB-Enum-Werte ab', () => {
    const dbValues = Object.values(PrismaPermission).sort();
    const sourceValues = [...STAFF_PERMISSION_VALUES].sort();
    expect(sourceValues).toEqual(dbValues);
  });

  it('jeder Eintrag hat Label + Kurztext, keine Dubletten', () => {
    const keys = STAFF_PERMISSIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of STAFF_PERMISSIONS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.short.length).toBeGreaterThan(0);
      expect(PERMISSION_LABELS[p.key]).toBe(p.label);
    }
  });
});
