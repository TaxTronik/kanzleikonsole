import { beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Zugriff auf Wiedervorlagen — besonders die INTERNEN (ohne Mandant).
//
// Mit dem optionalen Mandantenfeld entstand eine Lücke: `assertClientAccessTx`
// greift ohne clientId nicht. Ohne eigene Regel könnte jede Person im Tenant
// jede fremde interne Aufgabe lesen, abhaken und löschen.
// =============================================================================

const h = vi.hoisted(() => {
  class ForbiddenError extends Error {}
  return {
    ForbiddenError,
    assertClientAccessTx: vi.fn(),
    isStaffAdmin: vi.fn().mockReturnValue(false),
  };
});

vi.mock('@/server/auth/rbac', () => ({
  ForbiddenError: h.ForbiddenError,
  assertClientAccessTx: h.assertClientAccessTx,
  isStaffAdmin: h.isStaffAdmin,
}));

import { assertReminderAccessTx, darfSteuern, istBeteiligt } from '../access';

const ICH = 'staff-ich';
const FREMD = 'staff-fremd';
const session = (staffId: string) =>
  ({ user: { staffId, tenantId: 't1', fullName: 'X', email: '' } }) as never;

const tx = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.isStaffAdmin.mockReturnValue(false);
});

describe('assertReminderAccessTx — mit Mandant', () => {
  it('delegiert an die Mandanten-Policy', async () => {
    await assertReminderAccessTx(tx, session(FREMD), {
      clientId: 'client-1',
      createdByStaff: ICH,
      assignees: [],
    });
    expect(h.assertClientAccessTx).toHaveBeenCalledWith(tx, expect.anything(), 'client-1');
  });
});

describe('assertReminderAccessTx — interne Aufgabe', () => {
  const intern = { clientId: null, createdByStaff: ICH, assignees: [{ staffId: 'staff-a' }] };

  it('lässt die anlegende Person durch', async () => {
    await expect(assertReminderAccessTx(tx, session(ICH), intern)).resolves.toBeUndefined();
    // Ohne Mandant darf die Mandanten-Policy gar nicht erst befragt werden.
    expect(h.assertClientAccessTx).not.toHaveBeenCalled();
  });

  it('lässt zugewiesene Personen durch', async () => {
    await expect(assertReminderAccessTx(tx, session('staff-a'), intern)).resolves.toBeUndefined();
  });

  it('sperrt Unbeteiligte aus', async () => {
    await expect(assertReminderAccessTx(tx, session(FREMD), intern)).rejects.toBeInstanceOf(
      h.ForbiddenError,
    );
  });

  it('lässt Admin/Partner durch', async () => {
    h.isStaffAdmin.mockReturnValue(true);
    await expect(assertReminderAccessTx(tx, session(FREMD), intern)).resolves.toBeUndefined();
  });
});

describe('darfSteuern', () => {
  const rem = { createdByStaff: ICH };

  it('erlaubt es der anlegenden Person', () => {
    expect(darfSteuern(session(ICH), rem)).toBe(true);
  });

  it('verweigert es der zugewiesenen Person', () => {
    // Sonst stuft man sich die eigenen Aufgaben herunter oder schiebt die Frist.
    expect(darfSteuern(session(FREMD), rem)).toBe(false);
  });

  it('erlaubt es Admin/Partner', () => {
    h.isStaffAdmin.mockReturnValue(true);
    expect(darfSteuern(session(FREMD), rem)).toBe(true);
  });
});

describe('istBeteiligt', () => {
  it('erkennt anlegende und zugewiesene Personen', () => {
    const rem = { clientId: null, createdByStaff: ICH, assignees: [{ staffId: 'staff-a' }] };
    expect(istBeteiligt(ICH, rem)).toBe(true);
    expect(istBeteiligt('staff-a', rem)).toBe(true);
    expect(istBeteiligt(FREMD, rem)).toBe(false);
  });
});
