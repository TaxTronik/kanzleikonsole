import { describe, expect, it } from 'vitest';
import { encode as defaultEncode } from 'next-auth/jwt';
import { createStableSessionJwtOptions } from '../session-jwt';

const SECRET = 'test-auth-secret-with-at-least-thirtytwo-chars';

describe('stable session JWT salts', () => {
  it('encodes with the stable salt regardless of the runtime cookie name', async () => {
    const jwt = createStableSessionJwtOptions('taxtronik_staff_session', [
      '__taxtronik_staff_session',
      '__Host-taxtronik_staff_session',
    ]);

    const token = await jwt.encode({
      secret: SECRET,
      salt: '__Host-taxtronik_staff_session',
      token: { staffId: 'staff-1' },
    });

    await expect(
      jwt.decode({ secret: SECRET, salt: '__taxtronik_staff_session', token }),
    ).resolves.toMatchObject({ staffId: 'staff-1' });
  });

  it('decodes legacy tokens that used a prefixed cookie name as salt', async () => {
    const jwt = createStableSessionJwtOptions('taxtronik_staff_session', [
      '__taxtronik_staff_session',
      '__Host-taxtronik_staff_session',
      '__Secure-taxtronik_staff_session',
    ]);

    const legacyToken = await defaultEncode({
      secret: SECRET,
      salt: '__Host-taxtronik_staff_session',
      token: { staffId: 'staff-legacy' },
    });

    await expect(
      jwt.decode({ secret: SECRET, salt: '__taxtronik_staff_session', token: legacyToken }),
    ).resolves.toMatchObject({ staffId: 'staff-legacy' });
  });
});
