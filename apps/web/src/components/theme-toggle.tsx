'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { applyTheme, readThemePref, setThemePref, THEME_EVENT, type ThemePref } from '@/lib/theme';

function subscribeTheme(onChange: () => void) {
  window.addEventListener('storage', onChange);
  window.addEventListener(THEME_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(THEME_EVENT, onChange);
  };
}

export function ThemeToggle() {
  const storedPref = useSyncExternalStore(subscribeTheme, readThemePref, () => null);
  const [localChoice, setLocalChoice] = useState<{ stored: ThemePref; value: ThemePref } | null>(
    null,
  );
  const pref = localChoice?.stored === storedPref ? localChoice.value : (storedPref ?? 'system');

  useEffect(() => {
    if (storedPref !== null) applyTheme(pref);
  }, [pref, storedPref]);

  // Bei "system" auf Änderungen der OS-Einstellung reagieren
  useEffect(() => {
    if (pref !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    function onChange() {
      applyTheme('system');
    }
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);

  function setAndPersist(next: ThemePref) {
    setThemePref(next);
    // Retain an explicit choice for this tab even if persistence is unavailable.
    setLocalChoice({ stored: readThemePref(), value: next });
  }

  function cycle() {
    const order: ThemePref[] = ['light', 'dark', 'system'];
    const idx = order.indexOf(pref);
    const next = order[(idx + 1) % order.length]!;
    setAndPersist(next);
  }

  // Vor Mount: invisible Placeholder (gleicher Slot, kein Layout-Shift)
  if (storedPref === null) {
    return <div className="w-8 h-8" aria-hidden />;
  }

  const Icon = pref === 'dark' ? Moon : pref === 'light' ? Sun : Monitor;
  const title =
    pref === 'dark'
      ? 'Dunkel — klicken für System'
      : pref === 'light'
        ? 'Hell — klicken für Dunkel'
        : 'System — klicken für Hell';

  return (
    <button type="button" onClick={cycle} title={title} aria-label={title} className="icon-action">
      <Icon className="h-5 w-5" />
    </button>
  );
}
