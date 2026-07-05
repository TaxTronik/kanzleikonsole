'use client';

import { useEffect, useState } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { applyTheme, readThemePref, setThemePref, THEME_EVENT, type ThemePref } from '@/lib/theme';

export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>('system');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setPref(readThemePref());
    setMounted(true);
    function sync() {
      const next = readThemePref();
      setPref(next);
      applyTheme(next);
    }
    window.addEventListener('storage', sync);
    window.addEventListener(THEME_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(THEME_EVENT, sync);
    };
  }, []);

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
    setPref(next);
    setThemePref(next);
  }

  function cycle() {
    const order: ThemePref[] = ['light', 'dark', 'system'];
    const idx = order.indexOf(pref);
    const next = order[(idx + 1) % order.length]!;
    setAndPersist(next);
  }

  // Vor Mount: invisible Placeholder (gleicher Slot, kein Layout-Shift)
  if (!mounted) {
    return <div className="w-9 h-9" aria-hidden />;
  }

  const Icon = pref === 'dark' ? Moon : pref === 'light' ? Sun : Monitor;
  const title =
    pref === 'dark' ? 'Dunkel — klicken für System' :
    pref === 'light' ? 'Hell — klicken für Dunkel' :
    'System — klicken für Hell';

  return (
    <button
      type="button"
      onClick={cycle}
      title={title}
      aria-label={title}
      className="p-2 text-muted hover:text-primary hover:bg-gray-100 rounded-md transition-colors"
    >
      <Icon className="h-5 w-5" />
    </button>
  );
}
