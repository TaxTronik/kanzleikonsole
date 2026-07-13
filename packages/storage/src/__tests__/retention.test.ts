// =============================================================================
// Unit-Tests: § 147 AO / § 8 Abs. 4 GwG Aufbewahrungsfristen & Object-Lock-Modus.
//
// Getestet werden ausschließlich REINE Funktionen aus service.ts, die ohne
// S3/ClamAV/Netzwerk laufen:
//   - gobdRetentionUntil  (konservativer 10-Jahre-Default, Jahresende-basiert)
//   - gobdRetentionUntilFor / retentionUntilForYears (exakte 6/8/10-Jahresfrist)
//   - gwgRetentionUntil   (5-Jahre-GwG-Frist)
//   - retentionForTier    (Tier → Retain-Until)
//   - lockModeForTier      (Tier → GOVERNANCE vs. COMPLIANCE)
//
// Regressionsschwerpunkt (H-5): der frühere Bug, bei dem die Frist über
// `10 * 365.25 Tage` gerechnet wurde und für Belege vom Jahresanfang bei knapp
// ~9,5 statt vollen 10 Kalenderjahren nach Jahresende landete — also potenziell
// VOR Ablauf der gesetzlichen Frist.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  gobdRetentionUntil,
  gobdRetentionUntilFor,
  gobdRetentionYears,
  retentionUntilForYears,
  gwgRetentionUntil,
  retentionForTier,
  lockModeForTier,
} from '../service';
import type { ProtectionTier } from '../client';

// Gesetzliches Jahresende (§ 147 Abs. 3 AO): Frist beginnt mit Schluss des
// Kalenderjahres der letzten Eintragung. Für den konservativen 10-Jahres-
// Default muss Retain-Until mindestens bis zu diesem Datum reichen.
function gobdLegalDeadline(docDate: Date): Date {
  const endOfCreationYear = Date.UTC(docDate.getUTCFullYear(), 11, 31, 23, 59, 59, 999);
  // 10 volle Jahre nach dem Jahresende.
  return new Date(endOfCreationYear + 10 * 365 * 24 * 60 * 60 * 1000);
}

describe('gobdRetentionUntilFor — BEG IV, belegart-abhängig (8 J. Rechnungen)', () => {
  it('GOBD_INVOICE → 8 Jahre (§ 147 Abs. 3 AO n.F. / § 14b UStG n.F.)', () => {
    expect(gobdRetentionYears('GOBD_INVOICE')).toBe(8);
    // Beleg 2026 → Jahresende 2026 + 8 J. + 1 Tag = 2035-01-01.
    expect(
      gobdRetentionUntilFor('GOBD_INVOICE', new Date(Date.UTC(2026, 2, 15))).toISOString(),
    ).toBe('2035-01-01T00:00:00.000Z');
  });

  it('Bücher/Abschlüsse bleiben beim konservativen Zehnjahrestyp', () => {
    expect(gobdRetentionYears('GOBD_TAX')).toBe(10);
    expect(gobdRetentionUntilFor('GOBD_TAX', new Date(Date.UTC(2026, 2, 15))).toISOString()).toBe(
      '2037-01-01T00:00:00.000Z',
    );
  });

  it('Verträge/Geschäftsbriefe fallen grundsätzlich in die Sechsjahresgruppe', () => {
    expect(gobdRetentionYears('GOBD_CONTRACT')).toBe(6);
    expect(
      gobdRetentionUntilFor('GOBD_CONTRACT', new Date(Date.UTC(2026, 2, 15))).toISOString(),
    ).toBe('2033-01-01T00:00:00.000Z');
  });

  it('ohne/unbekannte Klassifikation → 10 Jahre (konservativer Default)', () => {
    expect(gobdRetentionYears()).toBe(10);
    expect(gobdRetentionYears('SONSTIGE')).toBe(10);
    expect(gobdRetentionUntilFor(undefined, new Date(Date.UTC(2026, 2, 15))).getTime()).toBe(
      gobdRetentionUntil(new Date(Date.UTC(2026, 2, 15))).getTime(),
    );
  });
});

describe('retentionUntilForYears — fachliche 6/8/10-Jahres-Typen', () => {
  const now = new Date(Date.UTC(2026, 2, 15));

  it.each([
    [6, '2033-01-01T00:00:00.000Z'],
    [8, '2035-01-01T00:00:00.000Z'],
    [10, '2037-01-01T00:00:00.000Z'],
  ])('%i Jahre → korrekter Jahresende-Stichtag', (years, expected) => {
    expect(retentionUntilForYears(years, now).toISOString()).toBe(expected);
  });

  it('weist fachlich unbekannte Intervalle zurück', () => {
    expect(() => retentionUntilForYears(7, now)).toThrow('INVALID_RETENTION_YEARS');
  });
});

describe('gobdRetentionUntil — § 147 AO, 10 Jahre ab Jahresende', () => {
  it('Beleg vom 2026-03-15 → Retain-Until 2037-01-01', () => {
    const result = gobdRetentionUntil(new Date(Date.UTC(2026, 2, 15)));
    expect(result.toISOString()).toBe('2037-01-01T00:00:00.000Z');
  });

  it('Beleg vom Jahresende 2026-12-31 → identisch 2037-01-01 (Jahresende-Anker)', () => {
    // Egal ob Beleg am 1.1. oder 31.12. des Jahres — die Frist hängt am
    // KALENDERJAHR, nicht am Tag. Beide müssen dasselbe Datum liefern.
    const early = gobdRetentionUntil(new Date(Date.UTC(2026, 0, 1)));
    const late = gobdRetentionUntil(new Date(Date.UTC(2026, 11, 31, 23, 59, 59, 999)));
    expect(early.toISOString()).toBe('2037-01-01T00:00:00.000Z');
    expect(late.toISOString()).toBe('2037-01-01T00:00:00.000Z');
    expect(early.getTime()).toBe(late.getTime());
  });

  it('REGRESSION (~9,5-Jahre-Bug): Frist liegt NACH dem gesetzlichen Stichtag, auch für Jahresanfangs-Belege', () => {
    // Der alte Bug (10 * 365.25 Tage ab Erstellung) landete für einen Beleg vom
    // 1. Januar rund ein halbes Jahr zu früh — VOR dem gesetzlichen Fristende
    // (Jahresende + 10 Jahre). Dieser Test schlägt fehl, sollte die alte
    // Tages-Arithmetik zurückkommen.
    const newYearsDay = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0));
    const retainUntil = gobdRetentionUntil(newYearsDay);
    const legalDeadline = gobdLegalDeadline(newYearsDay);
    expect(retainUntil.getTime()).toBeGreaterThanOrEqual(legalDeadline.getTime());
  });

  it('deckt VOLLE 10 Kalenderjahre nach dem Erstellungsjahr ab (Endjahr = Startjahr + 11 als Puffer-Stichtag)', () => {
    const result = gobdRetentionUntil(new Date(Date.UTC(2030, 5, 20)));
    // Jahresende 2030-12-31, +10 J. = 2040-12-31; Retain-Until großzügig 2041-01-01.
    expect(result.getUTCFullYear()).toBe(2041);
    expect(result.getUTCMonth()).toBe(0);
    expect(result.getUTCDate()).toBe(1);
    // Muss echt hinter dem Jahresende des 10. Folgejahres liegen.
    expect(result.getTime()).toBeGreaterThan(Date.UTC(2040, 11, 31, 23, 59, 59, 999));
  });

  it('Schaltjahr-Beleg (2024, ein Schaltjahr) → korrekt jahresende-verankert, unabhängig von 366 Tagen', () => {
    // Robustheit gegen Tages-Arithmetik: ein Schaltjahr (366 Tage) darf das
    // Ergebnis nicht verschieben, weil wir auf Kalenderjahre rechnen, nicht Tage.
    const feb29 = new Date(Date.UTC(2024, 1, 29, 12, 0, 0));
    const result = gobdRetentionUntil(feb29);
    expect(result.toISOString()).toBe('2035-01-01T00:00:00.000Z');
    // Gesetzliches Fristende (2034-12-31) muss abgedeckt sein.
    expect(result.getTime()).toBeGreaterThanOrEqual(gobdLegalDeadline(feb29).getTime());
  });

  it('Retain-Until ist ein UTC-Mitternacht-Stichtag (keine Zeitzonen-Drift)', () => {
    const result = gobdRetentionUntil(new Date(Date.UTC(2026, 6, 4)));
    expect(result.getUTCHours()).toBe(0);
    expect(result.getUTCMinutes()).toBe(0);
    expect(result.getUTCSeconds()).toBe(0);
    expect(result.getUTCMilliseconds()).toBe(0);
  });
});

describe('gwgRetentionUntil — § 8 Abs. 4 GwG, 5 Jahre', () => {
  it('Beleg von 2026 → Retain-Until 2032-01-01 (5 J. + Jahresende-Puffer)', () => {
    const result = gwgRetentionUntil(new Date(Date.UTC(2026, 5, 15)));
    expect(result.toISOString()).toBe('2032-01-01T00:00:00.000Z');
  });

  it('GwG-Frist (5 J.) ist kürzer als der konservative GoBD-Default (10 J.)', () => {
    const now = new Date(Date.UTC(2026, 3, 1));
    expect(gwgRetentionUntil(now).getTime()).toBeLessThan(gobdRetentionUntil(now).getTime());
  });

  it('am Jahresanfang und Jahresende identisch (Kalenderjahr-Anker)', () => {
    const early = gwgRetentionUntil(new Date(Date.UTC(2027, 0, 1)));
    const late = gwgRetentionUntil(new Date(Date.UTC(2027, 11, 31, 23, 59, 59, 999)));
    expect(early.getTime()).toBe(late.getTime());
    expect(early.toISOString()).toBe('2033-01-01T00:00:00.000Z');
  });
});

describe('retentionForTier — Tier → Retain-Until', () => {
  it('GOBD ohne Datei-Typ → konservativer 10-Jahre-Default', () => {
    const r = retentionForTier('GOBD');
    expect(r).not.toBeNull();
    // 10-11 Jahre in der Zukunft.
    expect(r!.getUTCFullYear()).toBeGreaterThanOrEqual(new Date().getUTCFullYear() + 10);
  });

  it('GWG → gesetzt (5-Jahre-Frist, nicht null)', () => {
    const r = retentionForTier('GWG');
    expect(r).not.toBeNull();
    expect(r!.getUTCFullYear()).toBeGreaterThanOrEqual(new Date().getUTCFullYear() + 5);
  });

  it('GWG-Retention ist kürzer als GOBD-Retention', () => {
    expect(retentionForTier('GWG')!.getTime()).toBeLessThan(retentionForTier('GOBD')!.getTime());
  });

  it('NONE → null (keine gesetzliche Aufbewahrung / kein Object-Lock)', () => {
    expect(retentionForTier('NONE')).toBeNull();
  });
});

describe('lockModeForTier — Object-Lock-Modus je Schutzstufe (Review F2 / N-7)', () => {
  it('GWG → GOVERNANCE (Löschung zum fachlich ermittelten Fristende bleibt möglich)', () => {
    expect(lockModeForTier('GWG')).toBe('GOVERNANCE');
  });

  it('GOBD → COMPLIANCE (typabhängig 6/8/10 J., von niemandem aufhebbar)', () => {
    expect(lockModeForTier('GOBD')).toBe('COMPLIANCE');
  });

  it('NONE → COMPLIANCE als Default (wird nur bei aktivem Lock genutzt)', () => {
    // NONE-Objekte werden ohne Object-Lock geschrieben; der Modus ist dann
    // irrelevant, aber die Funktion muss deterministisch antworten.
    expect(lockModeForTier('NONE')).toBe('COMPLIANCE');
  });

  it('nur GWG erhält GOVERNANCE — jede andere Stufe COMPLIANCE', () => {
    const tiers: ProtectionTier[] = ['NONE', 'GWG', 'GOBD'];
    for (const t of tiers) {
      const mode = lockModeForTier(t);
      if (t === 'GWG') expect(mode).toBe('GOVERNANCE');
      else expect(mode).toBe('COMPLIANCE');
    }
  });
});
