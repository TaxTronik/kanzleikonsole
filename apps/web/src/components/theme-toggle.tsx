'use client';

import { useEffect, useState } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';

type ThemePref = 'light' | 'dark' | 'system';

function applyTheme(pref: ThemePref): void {
  let dark: boolean;
  if (pref === 'dark') dark = true;
  else if (pref === 'light') dark = false;
  else dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', dark);
}

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem('theme');
    if (v === 'dark' || v === 'light') return v;
  } catch {
    // ignore
  }
  return 'system';
}

export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>('system');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setPref(readPref());
    setMounted(true);
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
    try {
      if (next === 'system') localStorage.removeItem('theme');
      else localStorage.setItem('theme', next);
    } catch {
      // ignore
    }
    applyTheme(next);
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
