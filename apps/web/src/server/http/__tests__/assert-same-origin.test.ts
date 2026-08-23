import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { assertSameOrigin } from '../assert-same-origin';

function post(headers: Record<string, string> = {}) {
  return new NextRequest('http://staff.example.test/api/staff/documents/commit', {
    method: 'POST',
    headers: {
      host: 'staff.example.test',
      ...headers,
    },
  });
}

describe('assertSameOrigin', () => {
  it('akzeptiert exakt gleiche Origin', () => {
    expect(
      assertSameOrigin(post({ origin: 'https://staff.example.de' }), 'https://staff.example.de'),
    ).toBeNull();
  });

  it('akzeptiert Origin passend zum Request-Host fuer Multi-Host-Deploys', () => {
    expect(
      assertSameOrigin(post({ origin: 'http://staff.example.test' }), 'https://staff.example.de'),
    ).toBeNull();
  });

  it('blockt fremde Origins', () => {
    const res = assertSameOrigin(
      post({ origin: 'https://evil.example' }),
      'https://staff.example.de',
    );
    expect(res?.status).toBe(403);
  });

  it('blockt unparsebare Origins wie sandbox-null', () => {
    const res = assertSameOrigin(post({ origin: 'null' }), 'https://staff.example.de');
    expect(res?.status).toBe(403);
  });

  it('blockt headerlose mutierende Requests fail-closed', () => {
    const res = assertSameOrigin(post(), 'https://staff.example.de');
    expect(res?.status).toBe(403);
  });

  it('akzeptiert fehlenden Origin nur mit eindeutig same-origin Fetch-Metadata', () => {
    expect(
      assertSameOrigin(post({ 'sec-fetch-site': 'same-origin' }), 'https://staff.example.de'),
    ).toBeNull();
    expect(
      assertSameOrigin(post({ 'sec-fetch-site': 'same-site' }), 'https://staff.example.de')?.status,
    ).toBe(403);
    expect(
      assertSameOrigin(post({ 'sec-fetch-site': 'cross-site' }), 'https://staff.example.de')
        ?.status,
    ).toBe(403);
  });
});
