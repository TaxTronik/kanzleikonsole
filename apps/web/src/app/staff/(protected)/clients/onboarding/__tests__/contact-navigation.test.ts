import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const onboardingRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('Ansprechpartner-Schritt im Onboarding', () => {
  it('verschachtelt die Ueberspringen-Aktion nicht im Kontaktformular', () => {
    const source = readFileSync(resolve(onboardingRoot, '[id]', 'page.tsx'), 'utf8');
    const formStart = source.indexOf('id={contactFormId}');
    const formEnd = source.indexOf('</form>', formStart);
    const skipButton = source.indexOf(
      '<SkipButton clientId={clientId} next="gwg" label="Überspringen" />',
      formStart,
    );

    expect(formStart).toBeGreaterThan(-1);
    expect(formEnd).toBeGreaterThan(formStart);
    expect(skipButton).toBeGreaterThan(formEnd);
    expect(source).toContain('form={contactFormId}');
  });
});
