import { NextRequest, NextResponse } from 'next/server';
import { encode } from 'next-auth/jwt';
import { env } from '@taxtronik/config';
import { prismaOwner } from '@/server/db/prisma-owner';
import {
  STAFF_SESSION_COOKIE,
  STAFF_SESSION_JWT_SALT,
  USE_SECURE_COOKIES,
} from '@/server/auth/session-cookie';
import { checkPasswordAction } from '../actions';
import { evidenceService } from '@/server/container';
import { auditIp } from '@/server/auth/login-audit';
import { getClientIp } from '@/server/rate-limit';
import { isRequestBodyTooLargeError, parseFormDataBounded } from '@/server/http/bounded-form-data';

export const STAFF_PASSWORD_FORM_MAX_BYTES = 64 * 1024;

function safeStaffReturnTo(raw: string | null): string {
  if (!raw) return '/staff/dashboard';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/staff/dashboard';
  if (!raw.startsWith('/staff/')) return '/staff/dashboard';
  if (raw.includes('\\')) return '/staff/dashboard';
  return raw;
}

function loginRedirect(req: NextRequest, error?: string): NextResponse {
  const url = new URL('/staff/login', req.url);
  if (error) url.searchParams.set('error', error);
  return NextResponse.redirect(url, 303);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let formData: FormData;
  try {
    formData = await parseFormDataBounded(req, STAFF_PASSWORD_FORM_MAX_BYTES);
  } catch (error) {
    if (isRequestBodyTooLargeError(error)) {
      return NextResponse.json({ error: 'request_too_large' }, { status: 413 });
    }
    return NextResponse.json({ error: 'invalid_form' }, { status: 400 });
  }
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const tenantSlug = String(formData.get('tenantSlug') ?? 'default');
  const returnTo = safeStaffReturnTo(new URL(req.url).searchParams.get('returnTo'));

  const passwordResult = await checkPasswordAction(email, password, tenantSlug);
  if (!passwordResult.ok) {
    return loginRedirect(req, 'password-invalid');
  }

  if (!passwordResult.devSkip) {
    return loginRedirect(req, 'totp-required');
  }

  const tenant = await prismaOwner.tenant.findFirst({ where: { slug: tenantSlug } });
  const staffUser = tenant
    ? await prismaOwner.staffUser.findFirst({
        where: {
          tenantId: tenant.id,
          email: email.toLowerCase(),
          active: true,
          hardwareOnlyEnabledAt: null,
        },
        include: { roles: true, permissions: true },
      })
    : null;
  if (!tenant || !staffUser) {
    return loginRedirect(req, 'session-invalid');
  }

  const ip = (() => {
    try {
      return getClientIp(req.headers);
    } catch {
      return null;
    }
  })();

  await prismaOwner.$transaction((tx) =>
    evidenceService.record(tx, {
      tenantId: tenant.id,
      actorType: 'STAFF',
      actorId: staffUser.id,
      action: 'auth.login.success',
      resourceType: 'staff_user',
      resourceId: staffUser.id,
      after: { email: staffUser.email, method: 'dev_skip_totp' },
      ip: auditIp(ip),
    }),
  );

  const token = await encode({
    secret: env.AUTH_SECRET,
    salt: STAFF_SESSION_JWT_SALT,
    maxAge: 24 * 60 * 60,
    token: {
      sub: staffUser.id,
      email: staffUser.email,
      name: staffUser.fullName,
      staffId: staffUser.id,
      tenantId: tenant.id,
      fullName: staffUser.fullName,
      roles: staffUser.roles.map((r) => r.role as string),
      permissions: staffUser.permissions.map((p) => p.permission as string),
      authMethod: 'dev_skip_totp',
      authRevision: staffUser.authRevision,
    },
  });

  const response = NextResponse.redirect(new URL(returnTo, req.url), 303);
  response.cookies.set(STAFF_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: USE_SECURE_COOKIES,
    sameSite: 'lax',
    path: '/',
    maxAge: 24 * 60 * 60,
    ...(env.STAFF_COOKIE_DOMAIN ? { domain: env.STAFF_COOKIE_DOMAIN } : {}),
  });
  return response;
}
