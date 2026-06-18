'use client';

import { useEffect, useState } from 'react';
import { Sparkles, Square } from 'lucide-react';

type UiMode = 'classic' | 'modern';
const UI_MODE_EVENT = 'taxtronik-ui-mode-change';
const UI_MODE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function readPref(): UiMode {
  try {
    const v = localStorage.getItem('ui_mode');
    if (v === 'modern') return 'modern';
  } catch {
    // ignore
  }
  try {
    if (readCookie('ui_mode') === 'modern') return 'modern';
  } catch {
    // ignore
  }
  return 'classic';
}

function readCookie(name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : null;
}

function writeCookie(name: string, value: string | null): void {
  if (value === null) {
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
    return;
  }
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${UI_MODE_COOKIE_MAX_AGE}; SameSite=Lax`;
}

function applyMode(mode: UiMode): void {
  document.documentElement.classList.toggle('ui-modern', mode === 'modern');
}

function syncUiModeCookie(mode: UiMode): void {
  try {
    writeCookie('ui_mode', mode === 'modern' ? 'modern' : null);
  } catch {
    // ignore
  }
}

/**
 * Schaltet zwischen Klassik (default — leichtgewichtig, RDS-freundlich)
 * und Modern (Glas/Schatten/Gradient, nur für GPU-beschleunigte Clients).
 *
 * Persistenz via localStorage; bootstrap-Script im RootLayout wendet
 * die Klasse VOR dem ersten Paint an, um Flicker zu vermeiden.
 */
export function UiModeToggle() {
  const [mode, setMode] = useState<UiMode>('classic');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const initial = readPref();
    setMode(initial);
    applyMode(initial);
    syncUiModeCookie(initial);
    setMounted(true);
    function sync() {
      const next = readPref();
      setMode(next);
      applyMode(next);
      syncUiModeCookie(next);
    }
    window.addEventListener('storage', sync);
    window.addEventListener(UI_MODE_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(UI_MODE_EVENT, sync);
    };
  }, []);

  function toggle() {
    const next: UiMode = mode === 'modern' ? 'classic' : 'modern';
    setMode(next);
    try {
      if (next === 'classic') localStorage.removeItem('ui_mode');
      else localStorage.setItem('ui_mode', next);
    } catch {
      // ignore
    }
    syncUiModeCookie(next);
    applyMode(next);
    window.dispatchEvent(new Event(UI_MODE_EVENT));
  }

  if (!mounted) return <div className="w-9 h-9" aria-hidden />;

  const Icon = mode === 'modern' ? Sparkles : Square;
  const title =
    mode === 'modern'
      ? 'Modernes UI — klicken für Klassik (für schwache Geräte)'
      : 'Klassisches UI — klicken für Modern (für leistungsfähige Geräte)';

  return (
    <button
      type="button"
      onClick={toggle}
      title={title}
      aria-label={title}
      className="p-2 text-muted hover:text-primary hover:bg-gray-100 rounded-md transition-colors"
    >
      <Icon className="h-5 w-5" />
    </button>
  );
}
