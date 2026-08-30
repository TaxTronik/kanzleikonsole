import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const formSource = readFileSync(new URL('../branding-form.tsx', import.meta.url), 'utf8');

describe('Barrierefreiheit der Branding-Einstellungen', () => {
  it('beschriftet beide Farbeingaben und erläutert die automatische Kontrastwahl', () => {
    expect(formSource).toContain('<fieldset>');
    expect(formSource).toContain('<legend className="label">Akzent-Farbe</legend>');
    expect(formSource).toContain('htmlFor="accentColorHex"');
    expect(formSource).toContain('aria-invalid={!accentIsValid}');
    expect(formSource).toContain('id="accentColorContrast"');
    expect(formSource).toContain('role="status"');
    expect(formSource).toContain('die Markenfarbe bleibt unverändert');
  });

  it('kündigt Datei- und Speicherfehler unmittelbar an', () => {
    expect(formSource).toContain('role="alert"');
    expect(formSource).toContain('aria-live="polite"');
  });
});
