import { describe, expect, it } from 'vitest';
import {
  parseFormDataBounded,
  readRequestBodyBounded,
  RequestBodyTooLargeError,
} from '../bounded-form-data';

function streamedRequest(chunks: string[], headers: Record<string, string> = {}): Request {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request('https://staff.example.test/form', {
    method: 'POST',
    headers,
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

describe('readRequestBodyBounded', () => {
  it('stoppt einen chunked Body anhand der tatsaechlich gelesenen Bytes', async () => {
    const req = streamedRequest(['1234', '5678', '9'], {
      'content-type': 'application/x-www-form-urlencoded',
    });

    await expect(readRequestBodyBounded(req, 8)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it('vertraut einem zu kleinen Content-Length nicht', async () => {
    const req = streamedRequest(['12345', '67890'], {
      'content-length': '3',
      'content-type': 'application/x-www-form-urlencoded',
    });

    await expect(readRequestBodyBounded(req, 8)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it('weist ehrlich deklarierte Uebergroesse vor dem Stream-Lesen ab', async () => {
    const req = new Request('https://staff.example.test/form', {
      method: 'POST',
      headers: { 'content-length': '100' },
      body: new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
      }),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    await expect(readRequestBodyBounded(req, 8)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });
});

describe('parseFormDataBounded', () => {
  it('parst einen Form-Body innerhalb der Grenze ohne Content-Length', async () => {
    const req = streamedRequest(['email=a%40example.test&', 'password=secret'], {
      'content-type': 'application/x-www-form-urlencoded',
    });

    const form = await parseFormDataBounded(req, 128);
    expect(form.get('email')).toBe('a@example.test');
    expect(form.get('password')).toBe('secret');
  });
});
