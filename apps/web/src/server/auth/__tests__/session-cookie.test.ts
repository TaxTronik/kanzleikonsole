import { describe, expect, it } from 'vitest';
import { readSessionCookieValue } from '../session-cookie';

function jar(cookies: Array<{ name: string; value: string }>) {
  return {
    get(name: string) {
      return cookies.find((cookie) => cookie.name === name);
    },
    getAll() {
      return cookies;
    },
  };
}

describe('readSessionCookieValue', () => {
  it('reads a direct cookie before chunk variants', () => {
    expect(
      readSessionCookieValue(
        jar([
          { name: '__Host-session', value: 'direct' },
          { name: '__Host-session.0', value: 'chunk' },
        ]),
        ['__Host-session'],
      ),
    ).toBe('direct');
  });

  it('joins contiguous Auth.js chunks in numeric order', () => {
    expect(
      readSessionCookieValue(
        jar([
          { name: '__Host-session.1', value: 'def' },
          { name: '__Host-session.0', value: 'abc' },
          { name: '__Host-session.2', value: 'ghi' },
        ]),
        ['__Host-session'],
      ),
    ).toBe('abcdefghi');
  });

  it('rejects a chunk set with gaps instead of decoding partial JWT bytes', () => {
    expect(
      readSessionCookieValue(
        jar([
          { name: '__Host-session.0', value: 'abc' },
          { name: '__Host-session.2', value: 'ghi' },
        ]),
        ['__Host-session'],
      ),
    ).toBeNull();
  });
});
