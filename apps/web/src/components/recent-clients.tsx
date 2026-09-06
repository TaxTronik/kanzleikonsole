'use client';

// =============================================================================
// Zuletzt besuchte Mandanten — rein clientseitig über localStorage.
//
// `RecordClientVisit` (auf der Mandanten-Detailseite gemountet) schreibt den
// Besuch; `RecentClients` (auf der Mandantenliste) zeigt die letzten als Chips.
// Bewusst kein Backend/keine DB: das ist eine reine Bequemlichkeit pro Browser,
// keine Auswertung — daher auch DSGVO-/Überwachungs-neutral.
// =============================================================================

import { useEffect } from 'react';
import { readBrowserStorage, useBrowserStorage, writeBrowserStorage } from './use-browser-storage';
import Link from 'next/link';
import { Clock } from 'lucide-react';

const STORAGE_KEY = 'taxtronik:recent-clients';
const MAX_RECENT = 8;

interface RecentClient {
  id: string;
  name: string;
}

function readRecent(raw: string | null): RecentClient[] {
  try {
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is RecentClient => !!e && typeof e.id === 'string' && typeof e.name === 'string',
      )
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/** Unsichtbar — protokolliert den Besuch eines Mandanten beim Mounten. */
export function RecordClientVisit({ id, name }: RecentClient): null {
  useEffect(() => {
    try {
      const current = readRecent(readBrowserStorage(STORAGE_KEY)).filter((e) => e.id !== id);
      const next = [{ id, name }, ...current].slice(0, MAX_RECENT);
      writeBrowserStorage(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // localStorage nicht verfügbar (Privacy-Modus) → einfach ignorieren.
    }
  }, [id, name]);
  return null;
}

/** Chip-Leiste der zuletzt besuchten Mandanten (ohne den aktuell offenen). */
export function RecentClients({ excludeId }: { excludeId?: string }) {
  const recent = readRecent(useBrowserStorage(STORAGE_KEY));

  const shown = recent.filter((c) => c.id !== excludeId);
  if (shown.length === 0) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="inline-flex items-center gap-1 text-xs text-disabled">
        <Clock className="h-3.5 w-3.5" /> Zuletzt:
      </span>
      {shown.map((c) => (
        <Link
          key={c.id}
          href={`/staff/clients/${c.id}`}
          className="text-xs px-2 py-1 rounded-md border border-default bg-surface hover:bg-gray-50 text-secondary hover:text-primary truncate max-w-[12rem]"
        >
          {c.name}
        </Link>
      ))}
    </div>
  );
}
