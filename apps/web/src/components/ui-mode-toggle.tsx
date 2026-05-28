'use client';

import { useEffect, useState } from 'react';
import { Sparkles, Square } from 'lucide-react';

type UiMode = 'classic' | 'modern';

function readPref(): UiMode {
  try {
    const v = localStorage.getItem('ui_mode');
    if (v === 'modern') return 'modern';
  } catch {
    // ignore
  }
  return 'classic';
}

function applyMode(mode: UiMode): void {
  document.documentElement.classList.toggle('ui-modern', mode === 'modern');
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
    setMode(readPref());
    setMounted(true);
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
    applyMode(next);
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
