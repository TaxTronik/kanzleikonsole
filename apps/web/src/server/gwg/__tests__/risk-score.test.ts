import { describe, it, expect } from 'vitest';
import { computeRiskScore, riskValidForDays } from '../risk-score';

describe('computeRiskScore — PEP-Override (§ 15 Abs. 3/4 GwG)', () => {
  it('PEP erzwingt HIGH + 1-Jahres-Frist, auch wenn der Score sonst MEDIUM wäre', () => {
    // pep=3 × weight 5 = 15 (< MEDIUM_THRESHOLD 25) → ohne Override MEDIUM.
    const r = computeRiskScore({ pep: 3 });
    expect(r.level).toBe('HIGH');
    expect(r.pepOverride).toBe(true);
    expect(r.validForDays).toBe(365);
  });

  it('ohne PEP bleibt die score-basierte Stufe erhalten (LOW → 3 Jahre)', () => {
    const r = computeRiskScore({ jurisdiction: 0, industry: 0 });
    expect(r.level).toBe('LOW');
    expect(r.pepOverride).toBe(false);
    expect(r.validForDays).toBe(365 * 3);
  });

  it('hoher Score ohne PEP ist HIGH (kein Override nötig)', () => {
    // jurisdiction 3×4 + transparency 3×4 = 24 + industry 3×3 = 33 ≥ 25 → HIGH.
    const r = computeRiskScore({ jurisdiction: 3, transparency: 3, industry: 3 });
    expect(r.level).toBe('HIGH');
    expect(r.pepOverride).toBe(false);
  });
});

describe('riskValidForDays', () => {
  it('HIGH → 365, sonst 1095', () => {
    expect(riskValidForDays('HIGH')).toBe(365);
    expect(riskValidForDays('MEDIUM')).toBe(365 * 3);
    expect(riskValidForDays('LOW')).toBe(365 * 3);
  });
});
