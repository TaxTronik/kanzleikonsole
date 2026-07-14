import { describe, expect, it } from 'vitest';
import {
  N8N_EVENT_CATALOG,
  N8N_EVENT_CATALOG_BY_NAME,
  requiresSeparateTestWebhook,
  STATIC_EVENT_NAMES,
} from '../index';

describe('N8N_EVENT_CATALOG', () => {
  it('bildet alle statischen Events exakt einmal und in stabiler Reihenfolge ab', () => {
    const catalogNames = N8N_EVENT_CATALOG.map((entry) => entry.name);

    expect(catalogNames).toEqual([...STATIC_EVENT_NAMES]);
    expect(new Set(catalogNames).size).toBe(STATIC_EVENT_NAMES.length);
    expect(Object.keys(N8N_EVENT_CATALOG_BY_NAME)).toEqual([...STATIC_EVENT_NAMES]);
  });

  it('liefert für jeden Namen denselben Eintrag über den Lookup', () => {
    for (const entry of N8N_EVENT_CATALOG) {
      expect(N8N_EVENT_CATALOG_BY_NAME[entry.name]).toBe(entry);
    }
  });

  it('enthält vollständige deutsche Anzeigetexte und JSON-fähige Beispielpayloads', () => {
    for (const entry of N8N_EVENT_CATALOG) {
      expect(entry.label.trim().length).toBeGreaterThan(0);
      expect(entry.categoryLabel.trim().length).toBeGreaterThan(0);
      expect(entry.description.trim().length).toBeGreaterThan(0);
      expect(entry.piiNotice.trim().length).toBeGreaterThan(0);
      expect(entry.examplePayload).not.toBeNull();
      expect(Array.isArray(entry.examplePayload)).toBe(false);

      const serialized = JSON.stringify(entry.examplePayload);
      expect(serialized).toBeTypeOf('string');
      expect(JSON.parse(serialized)).toEqual(entry.examplePayload);
      expect(serialized).not.toContain('undefined');
    }
  });

  it('kennzeichnet ausschließlich den synthetischen Ping als technische Nutzlast', () => {
    const technicalEvents = N8N_EVENT_CATALOG.filter((entry) => entry.dataClass === 'TECHNICAL');

    expect(technicalEvents.map((entry) => entry.name)).toEqual(['taxtronik.ping']);
    expect(technicalEvents[0]?.containsPersonalData).toBe(false);
  });

  it('fordert für jedes Fach- oder Workflow-Step-Event eine getrennte Test-URL', () => {
    expect(requiresSeparateTestWebhook([])).toBe(false);
    expect(requiresSeparateTestWebhook(['taxtronik.ping'])).toBe(false);
    expect(requiresSeparateTestWebhook(['request.opened'])).toBe(true);
    expect(requiresSeparateTestWebhook(['taxtronik.ping', 'request.opened'])).toBe(true);
    expect(requiresSeparateTestWebhook(['workflow.step.mein_schritt'])).toBe(true);
  });
});
