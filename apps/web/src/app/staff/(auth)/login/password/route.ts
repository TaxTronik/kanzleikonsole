import { NextRequest, NextResponse } from 'next/server';
import { encode } from 'next-auth/jwt';
import { env } from '@taxtronik/config';
import { prismaOwner } from '@/server/db/prisma-owner';
import { STAFF_SESSION_COOKIE } from '@/server/auth/session-cookie';
import { checkPasswordAction, loginAction } from '../actions';

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
  const formData = await req.formData();
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

  const loginFormData = new FormData();
  loginFormData.set('email', email);
  loginFormData.set('password', password);
  loginFormData.set('tenantSlug', tenantSlug);

  const loginResult = await loginAction(loginFormData);
  if (!loginResult.ok) {
    return loginRedirect(req, 'session-invalid');
  }

  const tenant = await prismaOwner.tenant.findFirst({ where: { slug: tenantSlug } });
  const staffUser = tenant
    ? await prismaOwner.staffUser.findFirst({
        where: { tenantId: tenant.id, email: email.toLowerCase(), active: true },
        include: { roles: true, permissions: true },
      })
    : null;
  if (!tenant || !staffUser) {
    return loginRedirect(req, 'session-invalid');
  }

  const token = await encode({
    secret: env.AUTH_SECRET,
    salt: STAFF_SESSION_COOKIE,
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
    },
  });

  const response = NextResponse.redirect(new URL(returnTo, req.url), 303);
  response.cookies.set(STAFF_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 24 * 60 * 60,
    ...(env.STAFF_COOKIE_DOMAIN ? { domain: env.STAFF_COOKIE_DOMAIN } : {}),
  });
  return response;
}
