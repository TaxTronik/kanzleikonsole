'use client';

// =============================================================================
// Gespeicherte Ansichten — benannte Lesezeichen der aktuellen Filter-/Sortier-
// Kombination (Query-String) pro Listenseite. localStorage, kein Backend:
// persönliche Bequemlichkeit pro Browser, keine Auswertung.
// =============================================================================

import { useEffect, useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Bookmark, BookmarkPlus, X } from 'lucide-react';

interface SavedView {
  name: string;
  query: string; // Such-String OHNE führendes '?'
}

const KEY = 'taxtronik:saved-views';

function readAll(): Record<string, SavedView[]> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, SavedView[]>) : {};
  } catch {
    return {};
  }
}

function writeAll(data: Record<string, SavedView[]>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // localStorage nicht verfügbar → ignorieren.
  }
}

export function SavedViews() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [views, setViews] = useState<SavedView[]>([]);

  useEffect(() => {
    setViews(readAll()[pathname] ?? []);
  }, [pathname]);

  const currentQuery = searchParams.toString();

  function persist(next: SavedView[]) {
    const all = readAll();
    if (next.length === 0) delete all[pathname];
    else all[pathname] = next;
    writeAll(all);
    setViews(next);
  }

  function saveCurrent() {
    const name = window.prompt('Name für diese Ansicht?')?.trim();
    if (!name) return;
    const next = [...views.filter((v) => v.name !== name), { name, query: currentQuery }];
    next.sort((a, b) => a.name.localeCompare(b.name, 'de-DE'));
    persist(next);
  }

  function remove(name: string) {
    persist(views.filter((v) => v.name !== name));
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="inline-flex items-center gap-1 text-xs text-disabled">
        <Bookmark className="h-3.5 w-3.5" /> Ansichten:
      </span>
      {views.map((v) => {
        const active = v.query === currentQuery;
        return (
          <span
            key={v.name}
            className={
              active
                ? 'inline-flex items-center gap-1 text-xs rounded-md border border-brand-300 bg-brand-50 text-brand-700 pl-2'
                : 'inline-flex items-center gap-1 text-xs rounded-md border border-default bg-surface text-secondary pl-2'
            }
          >
            <button
              type="button"
              onClick={() => router.push(v.query ? `${pathname}?${v.query}` : pathname)}
              className="py-1 hover:underline"
            >
              {v.name}
            </button>
            <button
              type="button"
              onClick={() => remove(v.name)}
              aria-label={`Ansicht „${v.name}“ löschen`}
              className="px-1 py-1 text-disabled hover:text-red-600"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        );
      })}
      <button
        type="button"
        onClick={saveCurrent}
        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-dashed border-default text-muted hover:text-primary hover:border-strong"
      >
        <BookmarkPlus className="h-3.5 w-3.5" /> Aktuelle speichern
      </button>
    </div>
  );
}
