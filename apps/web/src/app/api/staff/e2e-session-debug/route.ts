// =============================================================================
// TEMPORÄRER Diagnose-Endpoint für den E2E-Login-Fehler (DEV_SKIP_TOTP-CI).
//
// Liefert EXACT die Infos, die im Playwright-Report landen müssen, um das
// „Session abgelehnt -> force-logout"-Rätsel aufzuklären:
//   - mit welchem Salt der Cookie-JWE dekodiert werden kann (oder ob gar keiner)
//   - ob das dekodierte Token die Staff-Felder trägt
//   - welches Gate im Session-Callback greifen würde (Shape/Revocation/DB)
//   - ob die echte staffAuth()-Pipeline null liefert
//
// Der Endpoint ist scharf NUR im CI+DEV_SKIP_TOTP-Modus; sonst 404. Er wird
// vom E2E-Helper (apps/e2e/tests/helpers/auth.ts) bei Login-Misserfolg per GET
// gezogen und sein JSON in die Fehlermeldung eingebettet. Sobald der Fehler
// behoben ist, wird diese Datei wieder gelöscht.
// =============================================================================

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { decode } from 'next-auth/jwt';
import { env } from '@taxtronik/config';
import {
  STAFF_SESSION_COOKIE,
  STAFF_SESSION_COOKIE_BASE,
  STAFF_SESSION_JWT_DECODE_SALTS,
} from '@/server/auth/session-cookie';
import { staffAuth } from '@/server/auth/staff';
import { isTokenRevoked } from '@/server/auth/revocation';
import { prismaOwner } from '@/server/db/prisma-owner';

function isEnabled(): boolean {
  return process.env['CI'] === 'true' && process.env['DEV_SKIP_TOTP'] === 'true';
}

function cookieCandidates(): string[] {
  return [
    STAFF_SESSION_COOKIE,
    `__${STAFF_SESSION_COOKIE_BASE}`,
    `__Host-${STAFF_SESSION_COOKIE_BASE}`,
    `__Secure-${STAFF_SESSION_COOKIE_BASE}`,
  ];
}

function hasStaffShape(t: unknown): boolean {
  if (!t || typeof t !== 'object') return false;
  const o = t as Record<string, unknown>;
  return (
    typeof o['staffId'] === 'string' &&
    typeof o['tenantId'] === 'string' &&
    typeof o['fullName'] === 'string' &&
    Array.isArray(o['roles'])
  );
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isEnabled()) {
    return NextResponse.json({ enabled: false }, { status: 404 });
  }

  let rawCookie: string | undefined;
  let cookieFoundName: string | null = null;
  for (const name of cookieCandidates()) {
    const c = req.cookies.get(name);
    if (c?.value) {
      rawCookie = c.value;
      cookieFoundName = name;
      break;
    }
  }

  const secret = env.AUTH_SECRET;
  const decodeResults: Record<string, unknown> = {};
  let decoded: Record<string, unknown> | null = null;
  for (const salt of STAFF_SESSION_JWT_DECODE_SALTS) {
    try {
      const t = await decode({ token: rawCookie, secret, salt });
      decodeResults[salt] = t
        ? { ok: true, keys: Object.keys(t), staffId: (t as Record<string, unknown>)['staffId'], iat: (t as Record<string, unknown>)['iat'] }
        : { ok: false };
      if (t && !decoded) decoded = t as Record<string, unknown>;
    } catch (e) {
      decodeResults[salt] = { ok: false, error: (e as Error).message };
    }
  }

  // Gate-Replikation (wie Session-Callback in staff.ts)
  const gates: Record<string, unknown> = { shape: hasStaffShape(decoded) };
  if (decoded && hasStaffShape(decoded)) {
    const staffId = decoded['staffId'] as string;
    const tenantId = decoded['tenantId'] as string;
    const iat = decoded['iat'] as number | undefined;
    try {
      gates['revoked'] = await isTokenRevoked('staff', staffId, iat);
    } catch (e) {
      gates['revoked'] = `error: ${(e as Error).message}`;
    }
    try {
      const u = await prismaOwner.staffUser.findUnique({
        where: { id: staffId },
        select: { active: true, tenantId: true },
      });
      gates['dbUser'] = u
        ? { found: true, active: u.active, tenantMatches: u.tenantId === tenantId, dbTenant: u.tenantId, tokenTenant: tenantId }
        : { found: false };
    } catch (e) {
      gates['dbUser'] = `error: ${(e as Error).message}`;
    }
  }

  // Echte Pipeline (Session-Callback inklusive)
  let pipeline: unknown;
  try {
    const s = await staffAuth();
    pipeline = s ? { ok: true, staffId: s.user?.staffId } : { ok: false };
  } catch (e) {
    pipeline = { ok: false, error: (e as Error).message };
  }

  return NextResponse.json({
    enabled: true,
    cookieName: STAFF_SESSION_COOKIE,
    cookieFoundName,
    cookiePresent: !!rawCookie,
    cookieValueLen: rawCookie?.length,
    secretDefined: !!secret,
    secretLen: secret?.length,
    nodeEnv: process.env.NODE_ENV,
    saltsTried: STAFF_SESSION_JWT_DECODE_SALTS,
    decodeResults,
    gates,
    pipeline,
  });
}
