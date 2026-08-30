// =============================================================================
// Zentrale Theme-Logik (Dark-/Light-/System-Modus + UI-Mode).
//
// Vorher dreifach dupliziert: Bootstrap-Inline-Script (layout.tsx),
// theme-toggle.tsx und quantenlos-panel.tsx hatten je eine eigene Kopie der
// „localStorage('theme') → dark/light/system → classList.toggle('dark')"-Logik
// mit divergierenden Listener-Sätzen — Ursache der Dark-Mode-Flicker-Serie.
//
// Diese Datei ist REIN (kein React, kein 'use client'): sie exportiert den
// Bootstrap-String (fürs Root-Layout, das ihn als synchrones <script> setzt)
// und die Browser-Helfer. Der React-Sync-Listener liegt in
// components/theme-sync.tsx.
// =============================================================================

export type ThemePref = 'light' | 'dark' | 'system';

/** Fenster-Event, das ein Theme-Wechsel im selben Tab auslöst. */
export const THEME_EVENT = 'taxtronik-theme-change';

// Anti-FOUC-Bootstrap: setzt Theme- UND UI-Mode-Klasse VOR dem ersten Paint.
// MUSS ein self-contained IIFE-String bleiben (kein Laufzeit-Import), weil ihn
// das Root-Layout synchron ins SSR-HTML schreibt. Semantik identisch zu
// `resolveDark`/`readThemePref` unten — hier bewusst dupliziert, weil ein
// Inline-Script nicht importieren kann; beide Stellen sind knapp und stabil.
export const THEME_BOOTSTRAP_JS = `
(function () {
  try {
    function cookie(name) {
      var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    }
    var t = localStorage.getItem('theme');
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var dark = t === 'dark' || (t !== 'light' && prefersDark);
    document.documentElement.classList.toggle('dark', dark);
    var ui = localStorage.getItem('ui_mode') || cookie('ui_mode');
    document.documentElement.classList.toggle('ui-modern', ui === 'modern');
  } catch (_) {}
})();
`.trim();

/** Ob bei gegebener Präferenz dunkel dargestellt wird (Browser-only). */
export function resolveDark(pref: ThemePref): boolean {
  if (pref === 'dark') return true;
  if (pref === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Setzt die `dark`-Klasse am <html> entsprechend der Präferenz (Browser-only). */
export function applyTheme(pref: ThemePref): void {
  document.documentElement.classList.toggle('dark', resolveDark(pref));
}

/** Liest die gespeicherte Präferenz aus localStorage (Default: 'system'). */
export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem('theme');
    if (v === 'dark' || v === 'light') return v;
  } catch {
    // ignore
  }
  return 'system';
}

/** Persistiert die Präferenz, wendet sie an und benachrichtigt denselben Tab. */
export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === 'system') localStorage.removeItem('theme');
    else localStorage.setItem('theme', pref);
  } catch {
    // ignore
  }
  // Cross-Fade NUR bei explizitem Nutzerwechsel. Sync-Pfade (storage/pageshow/
  // focus, theme-sync.tsx) rufen applyTheme direkt auf und animieren nicht.
  const root = document.documentElement;
  root.classList.add('theme-fade');
  applyTheme(pref);
  window.setTimeout(() => root.classList.remove('theme-fade'), 350);
  window.dispatchEvent(new Event(THEME_EVENT));
}
