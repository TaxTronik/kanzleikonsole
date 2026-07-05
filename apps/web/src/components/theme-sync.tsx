'use client';

import { useEffect } from 'react';
import { applyTheme, readThemePref, THEME_EVENT } from '@/lib/theme';

/**
 * Hält die `dark`-Klasse mit der gespeicherten Präferenz synchron — für Seiten,
 * die den `ThemeToggle` nicht mounten. Reagiert auf:
 *  - `storage` (Wechsel in einem anderen Tab),
 *  - `THEME_EVENT` (Wechsel im selben Tab über den Toggle),
 *  - `matchMedia`-Änderung (OS-Umschaltung bei Präferenz 'system'),
 *  - `pageshow`/`focus` (bfcache-Restore, bei dem die Klasse veraltet sein kann).
 *
 * Ersetzt den früheren, panel-lokalen `QuantenlosThemeSync`-Flickwerk.
 */
export function ThemeSync(): null {
  useEffect(() => {
    const sync = () => applyTheme(readThemePref());
    sync();
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key === 'theme') sync();
    };
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    window.addEventListener('storage', onStorage);
    window.addEventListener(THEME_EVENT, sync);
    window.addEventListener('pageshow', sync);
    window.addEventListener('focus', sync);
    media.addEventListener('change', sync);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(THEME_EVENT, sync);
      window.removeEventListener('pageshow', sync);
      window.removeEventListener('focus', sync);
      media.removeEventListener('change', sync);
    };
  }, []);
  return null;
}
