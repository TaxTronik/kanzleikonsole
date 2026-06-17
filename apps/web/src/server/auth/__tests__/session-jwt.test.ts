import { afterEach, describe, expect, it, vi } from 'vitest';
import { encode as defaultEncode } from 'next-auth/jwt';
import { createStableSessionJwtOptions } from '../session-jwt';

const SECRET = 'test-auth-secret-with-at-least-thirtytwo-chars';
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

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

describe('session cookie JWT salts', () => {
  it('namespaces new salts by deployment URL and keeps legacy salts for decode', async () => {
    vi.resetModules();
    process.env['NEXTAUTH_URL'] = 'https://kanzlei.example.de';
    delete process.env['TAXTRONIK_SESSION_NAMESPACE'];

    const salts = await import('../session-cookie');

    expect(salts.STAFF_SESSION_JWT_SALT).toBe(
      'taxtronik_staff_session:https://kanzlei.example.de',
    );
    expect(salts.PORTAL_SESSION_JWT_SALT).toBe(
      'taxtronik_portal_session:https://kanzlei.example.de',
    );
    expect(salts.STAFF_SESSION_JWT_DECODE_SALTS).toContain('taxtronik_staff_session');
    expect(salts.PORTAL_SESSION_JWT_DECODE_SALTS).toContain('taxtronik_portal_session');
  });

  it('allows an explicit session namespace for stable on-prem deployments', async () => {
    vi.resetModules();
    process.env['TAXTRONIK_SESSION_NAMESPACE'] = 'kanzlei-prod-a';
    process.env['NEXTAUTH_URL'] = 'https://ignored.example.de';

    const salts = await import('../session-cookie');

    expect(salts.STAFF_SESSION_JWT_SALT).toBe('taxtronik_staff_session:kanzlei-prod-a');
  });
});
