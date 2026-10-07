// F-06: Der Proxy vergibt je Request eine Request-ID, übernimmt eine eingehende
// nur, wenn sie wohlgeformt ist, reicht sie an den Request weiter und setzt sie
// auf jede eigene Antwort (Weiterleitung, Redirect, 404).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const ORIGINAL_ENV = { ...process.env };
const NGINX_REQUEST_ID = '0123456789abcdef0123456789abcdef';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function loadProxy() {
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'production',
    NEXTAUTH_URL: 'https://staff.example.test',
    PORTAL_PUBLIC_URL: undefined,
    N8N_LEGACY_CALLBACKS_ENABLED: undefined,
  };
  vi.resetModules();
  return (await import('../proxy')).proxy;
}

function request(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, { headers });
}

/** Header, den NextResponse.next({ request }) an den weiterfließenden Request gibt. */
function forwardedRequestId(response: Response): string | null {
  return response.headers.get('x-middleware-request-x-request-id');
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('F-06 proxy request id', () => {
  it('übernimmt eine wohlgeformte eingehende ID für Request und Response', async () => {
    const proxy = await loadProxy();

    const response = proxy(
      request('https://staff.example.test/staff/login', { 'x-request-id': NGINX_REQUEST_ID }),
    );

    expect(response.headers.get('x-request-id')).toBe(NGINX_REQUEST_ID);
    expect(forwardedRequestId(response)).toBe(NGINX_REQUEST_ID);
  });

  it.each([
    ['E-Mail-Adresse', 'max.mustermann@example.test'],
    ['zu lang', 'a'.repeat(65)],
    ['Header-Liste', `${NGINX_REQUEST_ID}, ${NGINX_REQUEST_ID}`],
    ['Freitext', 'request-von-max-mustermann'],
  ])('ersetzt eine fehlerhafte eingehende ID (%s) durch eine neue', async (_label, incoming) => {
    const proxy = await loadProxy();

    const response = proxy(
      request('https://staff.example.test/staff/login', { 'x-request-id': incoming }),
    );

    const id = response.headers.get('x-request-id');
    expect(id).toMatch(UUID);
    expect(forwardedRequestId(response)).toBe(id);
  });

  it('vergibt ohne eingehende ID je Request eine eigene', async () => {
    const proxy = await loadProxy();

    const first = proxy(request('https://staff.example.test/staff/login'));
    const second = proxy(request('https://staff.example.test/staff/login'));

    expect(first.headers.get('x-request-id')).toMatch(UUID);
    expect(second.headers.get('x-request-id')).toMatch(UUID);
    expect(first.headers.get('x-request-id')).not.toBe(second.headers.get('x-request-id'));
  });

  it('setzt die ID auch auf Login-Redirects und den 404 der Legacy-Callbacks', async () => {
    const proxy = await loadProxy();

    const redirect = proxy(
      request('https://staff.example.test/staff/dashboard', { 'x-request-id': NGINX_REQUEST_ID }),
    );
    const hidden = proxy(request('https://staff.example.test/api/n8n/legacy'));

    expect(redirect.headers.get('location')).toContain('/staff/login');
    expect(redirect.headers.get('x-request-id')).toBe(NGINX_REQUEST_ID);
    expect(hidden.status).toBe(404);
    expect(hidden.headers.get('x-request-id')).toMatch(UUID);
  });
});
