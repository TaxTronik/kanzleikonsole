// =============================================================================
// Unit-Test: safePortalReturnTo aus der Magic-Link-Verify-Page.
//
// Bewacht V-4 (open-redirect-Schutz nach Magic-Link-Verify). Wenn jemand
// die Funktion versehentlich aufweicht ("ah, scheme-relative URLs sind
// doch auch okay"), schlägt der Test an, BEVOR ein Angreifer mit
// `?returnTo=//evil.example.de` aus dem Portal raus auf eine fremde
// Domain umgeleitet wird.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { safePortalReturnTo } from '../safe-return-to';

describe('safePortalReturnTo', () => {
  it('Default ohne Eingabe: /portal/dashboard', () => {
    expect(safePortalReturnTo(undefined)).toBe('/portal/dashboard');
    expect(safePortalReturnTo('')).toBe('/portal/dashboard');
  });

  it('akzeptiert same-origin /portal/-Pfade', () => {
    expect(safePortalReturnTo('/portal/dashboard')).toBe('/portal/dashboard');
    expect(safePortalReturnTo('/portal/anforderungen')).toBe('/portal/anforderungen');
    expect(safePortalReturnTo('/portal/bescheide/123')).toBe('/portal/bescheide/123');
  });

  it('lehnt scheme-relative URLs ab (//evil.example.de)', () => {
    expect(safePortalReturnTo('//evil.example.de')).toBe('/portal/dashboard');
    expect(safePortalReturnTo('//evil.example.de/portal/dashboard')).toBe('/portal/dashboard');
  });

  it('lehnt absolute URLs ab', () => {
    expect(safePortalReturnTo('https://evil.example.de/portal/dashboard')).toBe('/portal/dashboard');
    expect(safePortalReturnTo('http://localhost:3000/portal/dashboard')).toBe('/portal/dashboard');
  });

  it('lehnt /staff/-Pfade ab (Surface-Trennung)', () => {
    expect(safePortalReturnTo('/staff/dashboard')).toBe('/portal/dashboard');
    expect(safePortalReturnTo('/staff/admin/settings')).toBe('/portal/dashboard');
  });

  it('lehnt andere Top-Level-Pfade ab', () => {
    expect(safePortalReturnTo('/api/portal/something')).toBe('/portal/dashboard');
    expect(safePortalReturnTo('/admin')).toBe('/portal/dashboard');
    expect(safePortalReturnTo('/')).toBe('/portal/dashboard');
  });

  it('lehnt Backslash-Pfade ab (Windows-Path-Confusion)', () => {
    expect(safePortalReturnTo('/portal/\\evil')).toBe('/portal/dashboard');
    expect(safePortalReturnTo('\\\\evil.example.de')).toBe('/portal/dashboard');
  });

  it('lehnt Pfade ohne führenden Slash ab', () => {
    expect(safePortalReturnTo('portal/dashboard')).toBe('/portal/dashboard');
    expect(safePortalReturnTo('javascript:alert(1)')).toBe('/portal/dashboard');
  });
});
