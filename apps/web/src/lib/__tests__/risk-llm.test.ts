import { describe, expect, it } from 'vitest';
import { canStartLlm, llmCapabilityError, llmOptionalSetupNotice } from '../risk-llm';

describe('Risk-Layer LLM capability', () => {
  it('schaltet Schicht 2 nur mit Binary und Modell frei', () => {
    expect(canStartLlm({ binaryVorhanden: true, modellGeladen: true })).toBe(true);
    expect(canStartLlm({ binaryVorhanden: false, modellGeladen: true })).toBe(false);
    expect(canStartLlm({ binaryVorhanden: true, modellGeladen: false })).toBe(false);
    expect(canStartLlm(null)).toBe(false);
  });

  it('benennt die fehlende Betriebsvoraussetzung', () => {
    const binary = llmCapabilityError({ binaryVorhanden: false, modellGeladen: true });
    const model = llmCapabilityError({ binaryVorhanden: true, modellGeladen: false });
    expect(binary).toMatch(/Signal ist verfügbar/);
    expect(binary).toMatch(/optionale.*llama-server/);
    expect(model).toMatch(/Signal ist verfügbar/);
    expect(model).toMatch(/optionale.*Modell/);
  });

  it('stellt ein fehlendes LLM nicht als fehlende Signal-Installation dar', () => {
    const binary = llmOptionalSetupNotice({ binaryVorhanden: false, modellGeladen: true });
    const model = llmOptionalSetupNotice({ binaryVorhanden: true, modellGeladen: false });
    expect(binary).toMatchObject({ detail: expect.stringContaining('optional') });
    expect(binary?.title).toMatch(/Signal ist installiert und nutzbar/);
    expect(model).toMatchObject({ detail: expect.stringContaining('optional') });
    expect(llmOptionalSetupNotice({ binaryVorhanden: true, modellGeladen: true })).toBeNull();
  });
});
