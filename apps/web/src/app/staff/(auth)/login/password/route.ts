import { NextRequest, NextResponse } from 'next/server';
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

  return NextResponse.redirect(new URL(returnTo, req.url), 303);
}
