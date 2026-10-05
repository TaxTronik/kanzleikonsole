import { NextRequest, NextResponse } from 'next/server';
import { completeStaffLogin } from '@/server/auth/staff-login';
import { staffSessionFactory, staffSessionToken } from '@/server/auth/staff-session';
import { checkPasswordAction } from '../actions';
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

  // R-04: derselbe Staff-Login-Service wie die Oberfläche — Passwortschritt
  // (genau ein bcrypt-Vergleich, Einmal-Ticket), danach dieselbe Einlösung wie
  // der Auth.js-Credentials-Provider. Ohne DEV_SKIP_TOTP endet der Pfad nach
  // dem Passwortschritt (TOTP braucht die Oberfläche).
  const passwordResult = await checkPasswordAction(email, password, tenantSlug);
  if (!passwordResult.ok) {
    return loginRedirect(req, 'password-invalid');
  }

  if (!passwordResult.devSkip || !passwordResult.loginTicket) {
    return loginRedirect(req, 'totp-required');
  }

  const ip = (() => {
    try {
      return getClientIp(req.headers);
    } catch {
      return null;
    }
  })();
  const user = await completeStaffLogin({
    loginTicket: passwordResult.loginTicket,
    totpCode: '',
    ip,
  });
  if (!user) {
    return loginRedirect(req, 'session-invalid');
  }

  // S-05: Cookie-Name, -Optionen, Codec und Claims aus der Staff-Session-
  // Fabrik — dieselbe Implementierung, mit der Auth.js die Session ausstellt.
  const response = NextResponse.redirect(new URL(returnTo, req.url), 303);
  await staffSessionFactory.issue(staffSessionToken(user), { request: req, response });
  return response;
}
