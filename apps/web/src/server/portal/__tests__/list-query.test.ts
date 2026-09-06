// Fachkatalog: ACCESS-SEARCH-SCOPE-001

import { describe, expect, it } from 'vitest';

import {
  PORTAL_LIST_PAGE_SIZE,
  clampPortalListPage,
  escapePortalContainsQuery,
  normalizePortalListQuery,
  parsePortalListPage,
} from '../list-query';

describe('Portal-Listenparameter', () => {
  it('verwendet releaseweit exakt 25 Treffer je Seite', () => {
    expect(PORTAL_LIST_PAGE_SIZE).toBe(25);
  });

  it('normalisiert ungültige und doppelte Seitenparameter stabil', () => {
    expect(parsePortalListPage(undefined)).toBe(1);
    expect(parsePortalListPage('-4')).toBe(1);
    expect(parsePortalListPage('2')).toBe(2);
    expect(parsePortalListPage(['3', '99'])).toBe(3);
  });

  it('begrenzt Suchbegriffe und Seiten auf den vorhandenen Ergebnisraum', () => {
    expect(normalizePortalListQuery(`  ${'x'.repeat(200)}  `)).toHaveLength(120);
    expect(clampPortalListPage(9, 26)).toBe(2);
    expect(clampPortalListPage(2, 0)).toBe(1);
  });

  it('behandelt PostgreSQL-Platzhalter als normale Suchzeichen', () => {
    expect(escapePortalContainsQuery('50%_A\\B')).toBe('50\\%\\_A\\\\B');
  });
});
