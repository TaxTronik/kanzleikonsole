import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const onboardingRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('abgeschlossene GwG im Onboarding', () => {
  it('zeigt nach der Verifikation nur noch den nächsten Schritt an', () => {
    const source = readFileSync(resolve(onboardingRoot, '[id]', 'page.tsx'), 'utf8');

    expect(source).toContain("verified={gwgCheck?.status === 'VERIFIED'}");
    expect(source).toContain('verified ? (');
    expect(source).toContain('<SkipButton clientId={clientId} next="poa" label="Weiter" />');
    expect(source).toContain('{!verified && (');
  });
});
