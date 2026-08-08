import { describe, expect, it } from 'vitest';
import { canStartLlm, llmCapabilityError } from '../risk-llm';

describe('Risk-Layer LLM capability', () => {
  it('schaltet Schicht 2 nur mit Binary und Modell frei', () => {
    expect(canStartLlm({ binaryVorhanden: true, modellGeladen: true })).toBe(true);
    expect(canStartLlm({ binaryVorhanden: false, modellGeladen: true })).toBe(false);
    expect(canStartLlm({ binaryVorhanden: true, modellGeladen: false })).toBe(false);
    expect(canStartLlm(null)).toBe(false);
  });

  it('benennt die fehlende Betriebsvoraussetzung', () => {
    expect(llmCapabilityError({ binaryVorhanden: false, modellGeladen: true })).toMatch(
      /llama-server/,
    );
    expect(llmCapabilityError({ binaryVorhanden: true, modellGeladen: false })).toMatch(/Modell/);
  });
});
