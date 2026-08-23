/**
 * Liest Form-Requests mit einer harten Grenze auf den tatsaechlich
 * eingehenden Bytes. Der Content-Length-Check ist nur ein schneller
 * Vorabpfad; die Stream-Grenze greift auch ohne Header und bei chunked
 * Transfer-Encoding.
 */

export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`REQUEST_BODY_TOO_LARGE:${maxBytes}`);
    this.name = 'RequestBodyTooLargeError';
  }
}

export function isRequestBodyTooLargeError(error: unknown): error is RequestBodyTooLargeError {
  return error instanceof RequestBodyTooLargeError;
}

export async function readRequestBodyBounded(req: Request, maxBytes: number): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('maxBytes muss eine nichtnegative sichere Ganzzahl sein.');
  }

  const declaredLength = req.headers.get('content-length');
  if (declaredLength !== null && /^\d+$/.test(declaredLength.trim())) {
    const parsed = Number(declaredLength);
    if (Number.isSafeInteger(parsed) && parsed > maxBytes) {
      throw new RequestBodyTooLargeError(maxBytes);
    }
  }

  if (!req.body) return new ArrayBuffer(0);

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;

      if (value.byteLength > maxBytes - total) {
        await reader.cancel('request body limit exceeded').catch(() => undefined);
        throw new RequestBodyTooLargeError(maxBytes);
      }
      total += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

export async function parseFormDataBounded(req: Request, maxBytes: number): Promise<FormData> {
  const body = await readRequestBodyBounded(req, maxBytes);
  const contentType = req.headers.get('content-type');
  const headers = new Headers();
  if (contentType) headers.set('content-type', contentType);
  return await new Response(body, { headers }).formData();
}
