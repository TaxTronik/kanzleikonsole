import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const portalPage = readFileSync(new URL('../page.tsx', import.meta.url), 'utf8');
const staffPage = readFileSync(
  new URL('../../../../../staff/(protected)/requests/[id]/page.tsx', import.meta.url),
  'utf8',
);

describe('Request-Kommentar-Sichtbarkeit', () => {
  it('lädt interne Kanzlei-Kommentare ausschließlich auf der Staff-Seite', () => {
    expect(staffPage).toContain('internalComments:');
    expect(staffPage).toContain('InternalCommentForm');
    expect(portalPage).not.toContain('internalComments');
    expect(portalPage).not.toContain('requestInternalComment');
  });
});
