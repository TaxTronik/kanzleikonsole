'use client';
// =============================================================================
// URL-Zustand der Browser-Variante (Review-Befund K-04): Die Liste ist
// URL-getrieben; der Suchentwurf bleibt lokal, bis er abgeschickt wird, und
// überlebt einen gewöhnlichen Daten-Refresh. Ordner-, Such- und Bereichswechsel
// setzen ihn über den Schlüssel in index.tsx zurück.
// =============================================================================

import { useState, type SubmitEvent } from 'react';
import type { Crumb } from '@/components/document-browser-utils';
import type { DocumentOps } from './ops';

/** Aktuelle Ebene (letzter Brotkrumen), sonst die Dokumentwurzel. */
export function currentHref(crumbs: Crumb[]): string {
  return crumbs[crumbs.length - 1]?.href ?? '/staff/documents';
}

/** Ziel der Suche: aktuelle Ebene mit `q`, ohne `q` bei leerem Begriff. */
export function browserSearchTarget(here: string, search: string, origin: string): string {
  const url = new URL(here, origin);
  if (search.trim()) url.searchParams.set('q', search.trim());
  else url.searchParams.delete('q');
  return url.pathname + url.search;
}

export function useBrowserSearch(q: string, crumbs: Crumb[], router: DocumentOps['router']) {
  const [search, setSearch] = useState(q);
  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    router.push(browserSearchTarget(currentHref(crumbs), search, window.location.origin));
  }
  return { search, setSearch, submit };
}
