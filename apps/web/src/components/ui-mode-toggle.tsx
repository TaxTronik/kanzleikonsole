'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
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
function subscribeUiMode(onChange: () => void) {
  window.addEventListener('storage', onChange);
  window.addEventListener(UI_MODE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(UI_MODE_EVENT, onChange);
  };
}

export function UiModeToggle() {
  const storedMode = useSyncExternalStore(subscribeUiMode, readPref, () => null);
  const [localChoice, setLocalChoice] = useState<{ stored: UiMode; value: UiMode } | null>(null);
  const mode = localChoice?.stored === storedMode ? localChoice.value : (storedMode ?? 'classic');

  useEffect(() => {
    if (storedMode === null) return;
    applyMode(mode);
    syncUiModeCookie(mode);
  }, [mode, storedMode]);

  function toggle() {
    const next: UiMode = mode === 'modern' ? 'classic' : 'modern';
    try {
      if (next === 'classic') localStorage.removeItem('ui_mode');
      else localStorage.setItem('ui_mode', next);
    } catch {
      // ignore
    }
    syncUiModeCookie(next);
    applyMode(next);
    setLocalChoice({ stored: readPref(), value: next });
    window.dispatchEvent(new Event(UI_MODE_EVENT));
  }

  if (storedMode === null) return <div className="w-8 h-8" aria-hidden />;

  const Icon = mode === 'modern' ? Sparkles : Square;
  const title =
    mode === 'modern'
      ? 'Modernes UI — klicken für Klassik (für schwache Geräte)'
      : 'Klassisches UI — klicken für Modern (für leistungsfähige Geräte)';

  return (
    <button type="button" onClick={toggle} title={title} aria-label={title} className="icon-action">
      <Icon className="h-5 w-5" />
    </button>
  );
}
