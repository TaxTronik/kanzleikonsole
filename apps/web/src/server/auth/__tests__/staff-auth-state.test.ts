// Fachkatalog: ACCESS-TENANT-RLS-001
import { describe, expect, it } from 'vitest';
import { staffTokenMatchesCurrentAuthState } from '../staff-auth-state';

describe('Staff-Session-Faktorbindung', () => {
  const hardwareAccount = {
    authRevision: 4,
    hardwareOnlyEnabledAt: new Date('2026-09-03T10:00:00.000Z'),
  };

  it('akzeptiert im Hardware-only-Modus ausschließlich ein Hardware-Token derselben Revision', () => {
    expect(
      staffTokenMatchesCurrentAuthState(
        { authMethod: 'security_key', authRevision: 4 },
        hardwareAccount,
      ),
    ).toBe(true);
    expect(
      staffTokenMatchesCurrentAuthState({ authMethod: 'totp', authRevision: 4 }, hardwareAccount),
    ).toBe(false);
    expect(
      staffTokenMatchesCurrentAuthState(
        { authMethod: 'dev_skip_totp', authRevision: 4 },
        hardwareAccount,
      ),
    ).toBe(false);
    expect(
      staffTokenMatchesCurrentAuthState(
        { authMethod: 'security_key', authRevision: 3 },
        hardwareAccount,
      ),
    ).toBe(false);
  });

  it('verwirft ein Hardware-Token nach Rückkehr zu Passwort + TOTP', () => {
    const passwordAccount = { authRevision: 5, hardwareOnlyEnabledAt: null };
    expect(
      staffTokenMatchesCurrentAuthState(
        { authMethod: 'security_key', authRevision: 5 },
        passwordAccount,
      ),
    ).toBe(false);
    expect(
      staffTokenMatchesCurrentAuthState({ authMethod: 'totp', authRevision: 5 }, passwordAccount),
    ).toBe(true);
  });

  it('erlaubt Legacy-Tokens nur für unveränderte Passwortkonten mit Revision null', () => {
    expect(
      staffTokenMatchesCurrentAuthState({}, { authRevision: 0, hardwareOnlyEnabledAt: null }),
    ).toBe(true);
    expect(
      staffTokenMatchesCurrentAuthState({}, { authRevision: 1, hardwareOnlyEnabledAt: null }),
    ).toBe(false);
    expect(staffTokenMatchesCurrentAuthState({}, hardwareAccount)).toBe(false);
  });
});
