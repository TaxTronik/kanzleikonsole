// Fachkatalog: ACCESS-SEARCH-SCOPE-001
import { describe, expect, it } from 'vitest';
import {
  CLIENT_PICKER_ENDPOINT,
  canonicalClientPickerFilters,
  clientPickerUrl,
  parseClientPickerRequest,
} from '../client-picker';

describe('Mandantenauswahl — Such-URL-Vertrag', () => {
  it('erzeugt kanonische URLs unabhängig von Reihenfolge und Dubletten der Filter', () => {
    expect(clientPickerUrl({ query: '  Müller ', filters: ['notEnded', 'active', 'active'] })).toBe(
      `${CLIENT_PICKER_ENDPOINT}?q=M%C3%BCller&filter=active%2CnotEnded`,
    );
    expect(clientPickerUrl({ query: '', filters: [] })).toBe(CLIENT_PICKER_ENDPOINT);
    expect(canonicalClientPickerFilters(['activeWorkflow', 'notAnonymized'])).toEqual([
      'notAnonymized',
      'activeWorkflow',
    ]);
  });

  it('liest dieselbe URL serverseitig wieder ein', () => {
    const url = new URL(
      clientPickerUrl({ query: '50% GmbH', filters: ['notAnonymized', 'active'] }),
      'http://localhost',
    );
    expect(parseClientPickerRequest(url.searchParams)).toEqual({
      query: '50% GmbH',
      filters: ['active', 'notAnonymized'],
    });
  });

  it('weist unbekannte Filter und überlange Begriffe ab (fail-closed)', () => {
    expect(parseClientPickerRequest(new URLSearchParams({ filter: 'active,all' }))).toBeNull();
    expect(parseClientPickerRequest(new URLSearchParams({ q: 'x'.repeat(101) }))).toBeNull();
    expect(parseClientPickerRequest(new URLSearchParams({ q: 'x'.repeat(100) }))).toEqual({
      query: 'x'.repeat(100),
      filters: [],
    });
    expect(parseClientPickerRequest(new URLSearchParams())).toEqual({ query: '', filters: [] });
  });
});
