import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('../page.tsx', import.meta.url), 'utf8');

describe('request detail creation timestamp', () => {
  it('shows the complete creation date and time in the header', () => {
    expect(pageSource).toContain('Erstellt am {fmtDateTimeShort(reqRow.createdAt)}');
  });
});
