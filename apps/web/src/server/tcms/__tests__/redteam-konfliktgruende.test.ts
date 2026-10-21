// =============================================================================
// Red-Team kk-tcms-rt3c (TCMS stage 3): Konfliktgründe eines 409 (tcms-s10).
// Angriffe eines bösartigen Dienstes auf die Konfliktabbildung – die
// Oberfläche zeigt nie den Text des Dienstes, ein nicht passender Grund ist ein
// Protokollfehler.
//
//   pnpm exec vitest run src/server/tcms/__tests__/redteam-konfliktgruende.test.ts
// =============================================================================
import { describe, expect, it, vi } from 'vitest';
import { ENDPUNKTE, fehlerSchemaFuer } from '@taxtronik/tcms-contract';
import { TcmsKonflikt } from '@taxtronik/tcms-client';

vi.mock('server-only', () => ({}));
vi.mock('@/server/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));

import { aktionsFehlerAus, konfliktText, TCMS_KONFLIKT_TEXTE } from '../zustand';

describe('RT3C: Konfliktgründe eines 409', () => {
  const meldung = fehlerSchemaFuer(ENDPUNKTE.portalMeldungErfassen);
  // Endpunkt ohne Konfliktgründe: ein 409 trägt dort nie einen Grund.
  const ohneGrund = fehlerSchemaFuer(ENDPUNKTE.ereignisErfassen);

  it('RT3C-G-01: gültiger Grund des Endpunkts wird angenommen', () => {
    expect(meldung.safeParse({ code: 'KONFLIKT', konflikt: 'IDEMPOTENZ_ABWEICHUNG' }).success).toBe(
      true,
    );
  });

  it('RT3C-G-02: 409 ohne Grund an einem Endpunkt mit `konflikte` ist eine Vertragsverletzung', () => {
    expect(meldung.safeParse({ code: 'KONFLIKT' }).success).toBe(false);
  });

  it('RT3C-G-03: ein bekannter Grund, den dieser Endpunkt nicht nennt, wird abgewiesen', () => {
    // CODE_FEHLT ist ein gültiger Grund – aber nicht für „Ereignis melden“.
    expect(meldung.safeParse({ code: 'KONFLIKT', konflikt: 'CODE_FEHLT' }).success).toBe(false);
  });

  it('RT3C-G-04: an einem Endpunkt ohne Gründe trägt ein 409 nie einen Grund', () => {
    expect(ohneGrund.safeParse({ code: 'KONFLIKT' }).success).toBe(true);
    expect(
      ohneGrund.safeParse({ code: 'KONFLIKT', konflikt: 'ZWISCHENZEITLICH_GEAENDERT' }).success,
    ).toBe(false);
  });

  it('RT3C-G-05: die Oberfläche zeigt den festen Text je Grund, nie den Text des Dienstes', () => {
    const roh = 'INTERNER-LEAK: Mandant 42, SQL-Detail';
    const ergebnis = aktionsFehlerAus(
      new TcmsKonflikt({
        status: 409,
        code: 'KONFLIKT',
        konflikt: 'IDEMPOTENZ_ABWEICHUNG',
        meldung: roh,
      }),
      { schreibend: true },
    );
    expect(ergebnis).toEqual({
      ok: false,
      error: TCMS_KONFLIKT_TEXTE.IDEMPOTENZ_ABWEICHUNG,
      errorCode: 'CONFLICT',
    });
    expect(ergebnis!.error).not.toContain('LEAK');
    expect(ergebnis!.error).not.toContain('Mandant 42');
  });

  it('RT3C-G-06: unbekannter Grund und Prototyp-Namen fallen auf den Sammeltext zurück', () => {
    const sammel = konfliktText(null);
    expect(konfliktText('GIBT_ES_NICHT' as never)).toBe(sammel);
    // Kein Treffer über den Objekt-Prototyp (hasOwn).
    expect(konfliktText('toString' as never)).toBe(sammel);
    expect(konfliktText('__proto__' as never)).toBe(sammel);
  });
});
