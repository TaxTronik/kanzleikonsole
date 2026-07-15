import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('GwG-Entscheidungsanzeige', () => {
  it('formatiert den Übergabezeitpunkt mit der festen Kanzlei-Zeitzone', () => {
    const source = readFileSync(new URL('../decision-forms.tsx', import.meta.url), 'utf8');

    expect(source).toContain("import { fmtDateTimeShort } from '@/lib/fmt'");
    expect(source).toContain('fmtDateTimeShort(new Date(reviewSubmittedAt))');
    expect(source).not.toContain("toLocaleString('de-DE')");
  });
});
