import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Rfc3161HttpAdapter } from '../rfc3161-http';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(here, '..', '..', '__tests__', 'fixtures', name)));

describe('Rfc3161HttpAdapter trust policy', () => {
  it('rejects a correctly signed token when its signer has no configured trust anchor', async () => {
    const adapter = new Rfc3161HttpAdapter('https://tsa.example/tsr', 10_000, []);
    const payload = fixture('synthetic-payload.bin');
    const response = fixture('synthetic-good.tsr');

    await expect(adapter.verify(payload, response)).resolves.toBe(false);
    await expect(adapter.verifyDetailed(payload, response)).resolves.toEqual({
      ok: false,
      trustAnchored: false,
    });
  });
});
